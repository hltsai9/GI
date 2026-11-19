import { h, state, flash, load, reload } from '../dom.js';
import { api, DEMO, demoFetch, devUser, fmtNum, fmtWhen } from '../api.js';
import { attempt, Dropdown, ErrorNote, errorOf, GIcon, Msg, PageHead, Seg, Warn } from '../ui.js';

const VIEWS = [
  { value: 'values', label: 'Sizes & colors', kicker: 'Settings', title: 'Sizes and colors' },
  { value: 'correct', label: 'Correct stock', kicker: 'Settings · stock correction', title: 'Correct a count' },
  { value: 'count', label: 'Full count', kicker: 'Settings · full count', title: 'Count everything' },
  { value: 'oracle', label: 'Oracle values', kicker: 'Settings · issue import', title: 'Oracle values' },
  { value: 'quality', label: 'Data quality', kicker: 'Settings · data quality', title: 'Unregistered garments' },
  { value: 'import', label: 'Import', kicker: 'Settings · issue import', title: 'Import status' },
  { value: 'device', label: 'This device', kicker: 'Settings · this device', title: 'View and user' },
];
const right = { textAlign: 'right' };

/** p: { meta, me, device, onSwitchView, user, onChooseUser } */
export function Settings(p) {
  const [view, setView] = state('settings.view', 'values');
  const v = VIEWS.find((x) => x.value === view);
  const lead = p.me.role === 'lead' || p.me.role === 'admin';
  const opts = VIEWS.map((x) => ({ value: x.value, label: x.label }));
  return [
    PageHead({ kicker: v.kicker, title: v.title }),
    h('div', { class: 'p-seg' },
      p.device === 'laptop'
        ? Seg({ label: 'Settings section', value: view, onChange: setView, optStyle: { padding: '7px 4px' }, options: opts })
        : Dropdown({ label: 'Section', value: view, onChange: setView, options: opts })),
    h('div', { class: 'p-body', style: view === 'values' ? { gap: 'var(--space-6)' } : undefined },
      !lead && ['values', 'correct', 'count', 'oracle'].includes(view) && Warn('Only the cleanroom lead can change these settings.'),
      view === 'values' && Values(p.meta, lead),
      view === 'correct' && CorrectStock(p.meta, lead),
      view === 'count' && FullCount(p.meta, lead),
      view === 'oracle' && OracleValues(p.meta, lead),
      view === 'quality' && DataQuality(),
      view === 'import' && ImportStatus(p.me.role === 'admin'),
      view === 'device' && ThisDevice(p)),
  ];
}

function Values(meta, canEdit) {
  const [text, setText] = state('values.text', { size: '', color: '' });
  const act = (fn) => attempt('values', async () => {
    await fn();
    reload('/meta', '/stock', '/trends');
  });
  const block = (kind, title, items, placeholder) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    h('h4', { style: { margin: 0 } }, title),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
      items.map((it) => h('span', { class: it.active ? 'chip' : 'chip off' },
        it.label,
        h('button', {
          class: 'btn btn-ghost', disabled: !canEdit, 'aria-label': it.active ? `Hide ${it.label}` : `Restore ${it.label}`, title: it.active ? 'Hide' : 'Restore',
          onClick: () => act(() => api(`/${kind}s/${it.id}/${it.active ? 'hide' : 'restore'}`, { method: 'POST' })),
          style: { minWidth: 36, minHeight: 40, padding: 0, color: 'var(--color-neutral-700)', fontSize: 16 },
        }, it.active ? '×' : '↺')))),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 } },
      h('input', { class: 'input', placeholder, value: text[kind], onInput: (e) => setText({ ...text, [kind]: e.target.value }), style: { minHeight: 44 } }),
      h('button', {
        class: 'btn btn-secondary', disabled: !canEdit || !text[kind].trim(), style: { minHeight: 44 },
        onClick: () => act(async () => { await api(`/${kind}s`, { method: 'POST', json: { value: text[kind] } }); setText({ ...text, [kind]: '' }); }),
      }, `Add ${kind}`)));
  return [
    ErrorNote(errorOf('values')),
    block('size', 'Sizes', meta.sizes.map((s) => ({ id: s.id, label: s.code, active: s.active })), 'New size, e.g. 5XLG'),
    block('color', 'Colors', meta.colors.map((c) => ({ id: c.id, label: c.name, active: c.active })), 'New color, e.g. Grey'),
    h('div', { class: 'note' }, 'New sizes and colors show up straight away in Receive, Stock and stock correction. Removing one only hides it from those screens — its stock records are kept.'),
  ];
}

const REASONS = [
  { value: 'spot_check', label: 'Spot check' }, { value: 'damaged', label: 'Damaged' }, { value: 'found', label: 'Found' },
  { value: 'miscount_at_delivery', label: 'Miscount at delivery' }, { value: 'other', label: 'Other' },
];
const ICON_BY_GARMENT = { Gown: 'gown', Hood: 'hood', Boots: 'boot' };

function CorrectStock(meta, canEdit) {
  const colors = meta.colors.filter((c) => c.active);
  const sizes = meta.sizes.filter((s) => s.active);
  const [f, setF] = state('correct.form', () => ({ garmentTypeId: meta.types[0].id, colorId: colors[0].id, sizeId: sizes[0].id, locationId: meta.locations[0].id, counted: '', reason: 'spot_check', note: '' }));
  const grid = load(`/stock/grid?garmentTypeId=${f.garmentTypeId}&locationId=${f.locationId}`, 'correct.grid');
  const log = load('/corrections');
  const [saved, setSaved] = flash('correct.saved');
  const sizeCode = sizes.find((s) => s.id === f.sizeId)?.code;
  const sys = grid.data?.rows.find((r) => r.size === sizeCode)?.cells.find((c) => c.colorId === f.colorId)?.onHand ?? 0;
  const counted = f.counted === '' ? null : Number(f.counted);
  const pick = (k) => (v) => setF({ ...f, [k]: v, counted: '' });
  const diff = counted === null ? null : counted - sys;
  const save = () => attempt('correct', async () => {
    await api('/corrections', { method: 'POST', json: { reason: f.reason, note: f.note || undefined, locationId: f.locationId, items: [{ garmentTypeId: f.garmentTypeId, colorId: f.colorId, sizeId: f.sizeId, qty: counted }] } });
    setSaved(`${sys} → ${counted}`);
    setF({ ...f, counted: '' });
    reload('/stock', '/corrections', '/trends');
  });
  return [
    Warn('Only for when the system count is wrong. To fix a delivery, use Receive › History instead. Every correction is logged.'),
    saved && Msg({ tag: 'Saved', text: saved }),
    ErrorNote(errorOf('correct')),
    h('div', { class: 'fields' },
      Dropdown({ label: 'Garment', value: f.garmentTypeId, onChange: pick('garmentTypeId'), options: meta.types.map((t) => ({ value: t.id, label: t.code === 'BOOT' ? 'Boots' : t.name, icon: t.icon })) }),
      Dropdown({ label: 'Color', value: f.colorId, onChange: pick('colorId'), options: colors.map((c) => ({ value: c.id, label: c.name })) }),
      Dropdown({ label: 'Size', value: f.sizeId, onChange: pick('sizeId'), options: sizes.map((s) => ({ value: s.id, label: s.code })) }),
      Dropdown({ label: 'Location', value: f.locationId, onChange: pick('locationId'), options: meta.locations.map((l) => ({ value: l.id, label: l.code })) })),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'end' } },
      h('div', null, h('div', { style: { fontSize: 12, color: 'var(--color-neutral-700)' } }, 'In system'), h('div', { class: 'num', style: { fontSize: 40, lineHeight: 1.1, fontWeight: 600 } }, sys)),
      h('div', { class: 'field' },
        h('label', { for: 'counted' }, 'Counted on the shelf'),
        h('input', { id: 'counted', class: 'input num', inputmode: 'numeric', placeholder: String(sys), value: f.counted,
          onInput: (e) => setF({ ...f, counted: e.target.value.replace(/\D/g, '') }), style: { minHeight: 56, fontSize: 28, fontWeight: 600 } }))),
    h('div', { style: { fontSize: 15, color: diff ? 'var(--color-accent-2-700)' : 'var(--color-neutral-700)' } },
      diff === null ? 'Enter what is on the shelf.' : diff === 0 ? 'Matches the system.' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} — stock will be set to ${counted}`),
    Dropdown({ label: 'Reason', value: f.reason, onChange: (v) => setF({ ...f, reason: v }), options: REASONS }),
    f.reason === 'other' && h('input', { class: 'input', 'aria-label': 'Note', placeholder: 'Why the count was wrong', value: f.note, onInput: (e) => setF({ ...f, note: e.target.value }), style: { minHeight: 44 } }),
    h('button', { class: 'btn btn-primary', disabled: !canEdit || counted === null || diff === 0 || (f.reason === 'other' && !f.note), onClick: save, style: { minHeight: 48, fontSize: 15 } }, 'Save correction'),
    h('div', { style: { display: 'flex', flexDirection: 'column', marginTop: 8 } },
      h('h6', { style: { margin: '0 0 4px', color: 'var(--color-neutral-700)' } }, 'Recent corrections'),
      (log.data ?? []).map((l) => h('div', { style: { display: 'grid', gridTemplateColumns: '28px 1fr auto', gap: 8, alignItems: 'center', padding: '6px 0', fontSize: 14 } },
        GIcon({ name: l.is_system ? null : ICON_BY_GARMENT[l.garment], size: 22, color: 'var(--color-accent-700)' }),
        h('div', null,
          h('div', { style: { fontWeight: 600 } }, l.is_system ? `Unregistered · ${l.location}` : `${l.garment} · ${l.color} · ${l.size} · ${l.location}`),
          h('div', { style: { fontSize: 13, color: 'var(--color-neutral-700)' } }, `${REASONS.find((r) => r.value === l.reason)?.label ?? 'Starting count'} · ${fmtWhen(l.at)} · ${l.user_name}`)),
        h('div', { class: 'num', style: right }, `${l.system_qty} → `, h('b', null, l.counted))))),
  ];
}

// Site time is Phoenix (UTC−7 all year, no daylight saving), so a local time converts with a fixed offset.
const phoenixToIso = (local) => new Date(`${local}:00-07:00`).toISOString();
const nowPhoenixLocal = () => new Date(Date.now() - 7 * 3600_000).toISOString().slice(0, 16);

/** Starting count (ADJ-05) or a full spot check that also clears the unregistered count (DQ-06). */
function FullCount(meta, canEdit) {
  const starts = load('/starting-counts');
  const [locId, setLocId] = state('count.loc', meta.locations[0].id);
  const [typeId, setTypeId] = state('count.type', meta.types[0].id);
  const [asOf, setAsOf] = state('count.asOf', nowPhoenixLocal);
  const [counts, setCounts] = state('count.counts', {});
  const [saved, setSaved] = flash('count.saved');
  const colors = meta.colors.filter((c) => c.active);
  const sizes = meta.sizes.filter((s) => s.active);
  const started = starts.data?.find((s) => s.locationId === locId)?.asOf;
  const entries = Object.entries(counts).filter(([, v]) => v !== '');
  const cols = `44px repeat(${colors.length}, minmax(0, 1fr))`;
  const save = () => attempt('count', async () => {
    const items = entries.map(([k, v]) => {
      const [t, c, s] = k.split('|').map(Number);
      return { garmentTypeId: t, colorId: c, sizeId: s, qty: Number(v) };
    });
    if (!started) {
      const r = await api('/starting-counts', { method: 'POST', json: { locationId: locId, asOf: phoenixToIso(asOf), counts: items } });
      setSaved(`Starting count · ${r.issuesApplied} issues since then applied`);
    } else {
      await api('/corrections', { method: 'POST', json: { reason: 'spot_check', locationId: locId, items, clearUnregistered: true } });
      setSaved('Full spot check · unregistered count reset to 0');
    }
    setCounts({});
    reload('/starting-counts', '/stock', '/corrections', '/trends');
  });
  return [
    h('div', { style: { display: 'flex', gap: 8 } },
      Seg({ label: 'Garment', style: { flex: 1 }, optStyle: { padding: '7px 2px', gap: 4, fontSize: 12.5 }, value: typeId, onChange: setTypeId, options: meta.types.map((t) => ({ value: t.id, label: t.plural, icon: t.icon })) }),
      Seg({ label: 'Location', optStyle: { flex: 'none', padding: '7px 8px' }, value: locId, onChange: setLocId, options: meta.locations.map((l) => ({ value: l.id, label: l.code })) })),
    started
      ? h('div', { class: 'note' }, `Starting count done ${fmtWhen(started)}. Use this for a `, h('b', null, 'full spot check'),
        ': enter what is on the shelf for every garment type, then save — the unregistered count for this fab goes back to 0. Empty cells keep their current number.')
      : [
        Warn('No starting count yet for this fab. Count everything, then enter the counts with the time counting ', h('b', null, 'finished'), '. Issues scanned after that time reduce stock; empty cells count as 0.'),
        h('div', { class: 'field', style: { maxWidth: 280 } },
          h('label', { for: 'asof' }, 'Counting finished at (Phoenix time)'),
          h('input', { id: 'asof', class: 'input', type: 'datetime-local', value: asOf, onInput: (e) => setAsOf(e.target.value), style: { minHeight: 44 } })),
      ],
    saved && Msg({ tag: 'Saved', text: saved }),
    ErrorNote(errorOf('count')),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      h('div', { style: { display: 'grid', gridTemplateColumns: cols, gap: 4, fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-neutral-700)' } },
        h('span'), colors.map((c) => h('span', { style: { textAlign: 'center' } }, c.name))),
      sizes.map((s) => h('div', { style: { display: 'grid', gridTemplateColumns: cols, gap: 4 } },
        h('span', { style: { fontSize: 12, fontWeight: 600, alignSelf: 'center' } }, s.code),
        colors.map((c) => {
          const k = `${typeId}|${c.id}|${s.id}`;
          return h('input', { class: 'input num', inputmode: 'numeric', 'aria-label': `${s.code} ${c.name}`, value: counts[k] ?? '',
            onInput: (e) => setCounts({ ...counts, [k]: e.target.value.replace(/\D/g, '') }), style: { minHeight: 40, textAlign: 'center', fontWeight: 600, fontSize: 15 } });
        })))),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
      h('div', { style: { flex: 1, fontSize: 13, color: 'var(--color-neutral-700)' } }, `${entries.length} items entered`),
      h('button', {
        class: 'btn btn-primary', style: { minHeight: 48, fontSize: 15, padding: '0 22px' }, disabled: !canEdit || (!!started && !entries.length),
        onClick: () => confirm(started ? 'Save the full spot check?' : 'Save the starting count? This can only be done once per fab.') && save(),
      }, started ? 'Save spot check' : 'Save starting count')),
  ];
}

function OracleValues(meta, canEdit) {
  const { data, error } = load('/oracle-values');
  const [saved, setSaved] = flash('oracle.saved');
  const options = (col) => {
    const list = col === 'SUIT_TYPE' ? meta.types.map((t) => ({ value: String(t.id), label: t.name }))
      : col === 'SUIT_COLOR' ? meta.colors.map((c) => ({ value: String(c.id), label: c.name }))
        : col === 'SUIT_SIZE' ? meta.sizes.map((s) => ({ value: String(s.id), label: s.code }))
          : meta.locations.map((l) => ({ value: String(l.id), label: l.code }));
    return [{ value: '', label: 'Not mapped' }, ...list, { value: 'ignore', label: 'Ignore' }];
  };
  const change = (v, choice) => {
    if (!choice) return;
    attempt('oracle', async () => {
      const r = await api(`/oracle-values/${v.id}`, { method: 'PUT', json: choice === 'ignore' ? { ignore: true } : { targetId: Number(choice) } });
      setSaved(`${v.oracle_column} ${v.oracle_value} · ${r.reclassified} held rows applied`);
      reload('/oracle-values', '/stock', '/trends', '/data-quality');
    });
  };
  return [
    h('div', { class: 'note' }, 'How each value in the Oracle issue table translates to GI. New values appear first; rows that use them are held until they are mapped.'),
    saved && Msg({ tag: 'Saved', text: saved }),
    ErrorNote(error ?? errorOf('oracle')),
    h('div', { style: { display: 'flex', flexDirection: 'column' } },
      (data ?? []).map((v) => h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10, alignItems: 'center', padding: '6px 0' } },
        h('div', null,
          h('div', { style: { fontWeight: 600, fontSize: 15 } }, `${v.oracle_value} `, !v.mapped && h('span', { class: 'tag tag-accent-2' }, 'New')),
          h('div', { style: { fontSize: 13, color: 'var(--color-neutral-700)' } }, `${v.oracle_column} · ${fmtNum(v.row_count)} rows${v.heldRows ? ` · ${v.heldRows} held` : ''}`)),
        canEdit
          ? Dropdown({ id: v.id, label: 'GI value', value: v.is_ignored ? 'ignore' : v.gi_id === null ? '' : String(v.gi_id), onChange: (c) => change(v, c), options: options(v.oracle_column) })
          : h('span', null, v.is_ignored ? 'Ignore' : options(v.oracle_column).find((o) => o.value === String(v.gi_id))?.label ?? 'Not mapped')))),
  ];
}

function DataQuality() {
  const { data, error } = load('/data-quality?days=30');
  const m = new Map();
  for (const r of data?.perDay ?? []) {
    const x = m.get(r.day) ?? { incomplete: 0, total: 0 };
    m.set(r.day, { incomplete: x.incomplete + Number(r.incomplete), total: x.total + Number(r.total) });
  }
  const days = [...m].slice(-14).reverse();
  const download = async () => {
    const res = DEMO ? await demoFetch('/data-quality/unregistered.csv') : await fetch('api/data-quality/unregistered.csv', { headers: { 'X-Dev-User': devUser() } });
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: 'unregistered-barcodes.csv' }).click();
  };
  return [
    h('div', { class: 'note' }, 'Garments whose barcode is not in the suit master come through as GOWN / OTHER / OTHER. They count in issued per day and per fab, but not per garment type, size or color.'),
    ErrorNote(error),
    h('table', { class: 'table num' },
      h('thead', null, h('tr', null, h('th', null, 'Day'), h('th', { style: right }, 'Unregistered'), h('th', { style: right }, 'All issues'), h('th', { style: right }, '%'))),
      h('tbody', null, days.map(([d, v]) => h('tr', null, h('td', null, d), h('td', { style: right }, v.incomplete), h('td', { style: right }, fmtNum(v.total)),
        h('td', { style: right }, v.total ? ((v.incomplete / v.total) * 100).toFixed(1) : '0'))))),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 } },
      h('h4', { style: { margin: 0 } }, 'Unregistered barcodes ', h('span', { style: { fontSize: 13, fontWeight: 400, color: 'var(--color-neutral-700)' } }, `· ${data?.unregisteredBarcodes.length ?? 0} for the vendor to register`)),
      h('button', { class: 'btn btn-secondary', onClick: download, style: { minHeight: 44 } }, 'Download CSV')),
    h('table', { class: 'table num' },
      h('thead', null, h('tr', null, h('th', null, 'Barcode'), h('th', { style: right }, 'Times'), h('th', null, 'Last seen'), h('th', null, 'Where'))),
      h('tbody', null, (data?.unregisteredBarcodes ?? []).slice(0, 50).map((b) => h('tr', null, h('td', null, b.barcode), h('td', { style: right }, b.times), h('td', null, fmtWhen(b.last_seen)), h('td', null, b.locations))))),
  ];
}

function ImportStatus(isAdmin) {
  const status = load('/sync/status');
  const runs = load('/sync/runs');
  const alerts = load('/alerts');
  const [busy, setBusy] = state('import.busy', false);
  const run = async (path) => {
    setBusy(true);
    await attempt('import', async () => {
      await api(path, { method: 'POST' });
      reload('/sync', '/alerts', '/stock', '/trends');
    });
    setBusy(false);
  };
  const s = status.data;
  return [
    s && (s.stale
      ? Warn(`No successful import for a while — last ${s.lastSuccessfulImport ? fmtWhen(s.lastSuccessfulImport) : 'never'}.`)
      : Msg({ tag: 'OK', text: `Last import ${s.lastSuccessfulImport ? fmtWhen(s.lastSuccessfulImport) : '—'} · issues up to ${s.issuesUpTo ? fmtWhen(s.issuesUpTo) : '—'} · every ${Math.round(s.pollSeconds / 60)} min` })),
    isAdmin && h('div', { style: { display: 'flex', gap: 8 } },
      h('button', { class: 'btn btn-secondary', disabled: busy, onClick: () => run('/sync/run'), style: { minHeight: 44 } }, 'Run import now'),
      h('button', { class: 'btn btn-secondary', disabled: busy, onClick: () => run('/sync/sweep'), style: { minHeight: 44 } }, 'Run catch-up sweep')),
    ErrorNote(errorOf('import')),
    h('div', null,
      h('h4', { class: 'sec' }, 'Alerts'),
      (alerts.data ?? []).map((a) => h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', fontSize: 14 } },
        h('div', { style: { flex: 1 } },
          h('div', null, h('span', { class: a.acknowledged_at ? 'tag tag-neutral' : 'tag tag-accent-2' }, a.kind.replace(/_/g, ' ')), ` ${a.message}`),
          h('div', { style: { fontSize: 13, color: 'var(--color-neutral-700)' } }, fmtWhen(a.at))),
        isAdmin && !a.acknowledged_at && h('button', { class: 'btn btn-ghost', onClick: () => attempt('import', async () => { await api(`/alerts/${a.id}/ack`, { method: 'POST' }); reload('/alerts'); }) }, 'Mark checked'))),
      !alerts.data?.length && h('div', { class: 'note' }, 'No alerts.')),
    h('table', { class: 'table num' },
      h('thead', null, h('tr', null, h('th', null, 'Recent runs'), h('th', null, 'Kind'), h('th', { style: right }, 'New'), h('th', { style: right }, 'Applied'), h('th', { style: right }, 'Held'), h('th', null, 'Status'))),
      h('tbody', null, (runs.data ?? []).map((r) => h('tr', null, h('td', null, fmtWhen(r.started_at)), h('td', null, r.kind), h('td', { style: right }, fmtNum(r.rows_new)),
        h('td', { style: right }, fmtNum(r.rows_applied)), h('td', { style: right }, r.rows_held), h('td', null, r.status))))),
  ];
}

const DEV_USERS = [
  { value: 'dev-floor', label: 'Floor staff' }, { value: 'dev-lead', label: 'Cleanroom lead' },
  { value: 'dev-admin', label: 'Admin' }, { value: 'dev-viewer', label: 'Viewer' },
];

function ThisDevice({ device, onSwitchView, user, onChooseUser, me }) {
  return [
    h('div', { class: 'note' }, 'The layout is chosen from the type of device. Change it here if this device got the wrong one; the choice is remembered on this device.'),
    Seg({ label: 'Layout', value: device, onChange: onSwitchView, options: [{ value: 'phone', label: 'Phone layout' }, { value: 'laptop', label: 'Laptop layout' }] }),
    DEMO
      ? h('div', { class: 'note' }, `Demo: signed in as ${me.name}.`)
      : [
        h('div', { class: 'note' }, 'Company sign-in (SSO) is not connected yet. For development, choose who you are:'),
        Dropdown({ label: 'Signed in as (dev)', value: user, onChange: onChooseUser, options: DEV_USERS }),
      ],
  ];
}
