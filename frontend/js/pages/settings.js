import { h, state, flash, load, reload } from '../dom.js';
import { api, apiUpload, authHeaders, DEMO, DEV_USERS, demoFetch, fmtNum, fmtWhen, unlockAdmin } from '../api.js';
import { ph } from '../icons.js';
import { attempt, Dropdown, ErrorNote, errorOf, GIcon, Msg, PageHead, Seg, Warn } from '../ui.js';

// Who can use each section; a section is hidden from everyone else (the server checks the same rules).
const VIEWS = [
  { value: 'values', label: 'Sizes & colors', kicker: 'Settings', title: 'Sizes and colors', roles: ['floor', 'lead', 'admin'] },
  { value: 'correct', label: 'Correct stock', kicker: 'Settings · stock correction', title: 'Correct a count', roles: ['floor', 'lead', 'admin'] },
  { value: 'count', label: 'Full count', kicker: 'Settings · full count', title: 'Count everything', roles: ['floor', 'lead', 'admin'] },
  { value: 'oracle', label: 'Oracle values', kicker: 'Settings · issue import', title: 'Oracle values', roles: ['admin'] },
  { value: 'quality', label: 'Data quality', kicker: 'Settings · data quality', title: 'Unregistered garments', roles: ['lead', 'admin'] },
  { value: 'import', label: 'Import', kicker: 'Settings · issue import', title: 'Import status', roles: ['admin'] },
  { value: 'device', label: 'This device', kicker: 'Settings · this device', title: 'View and user', roles: null },
];
const right = { textAlign: 'right' };

/** p: { meta, me, device, onSwitchView, user, onChooseUser } */
export function Settings(p) {
  const allowed = VIEWS.filter((x) => !x.roles || x.roles.includes(p.me.role));
  const [chosen, setView] = state('settings.view', 'values');
  const v = allowed.find((x) => x.value === chosen) ?? allowed[0];
  const view = v.value;
  const lead = p.me.role === 'lead' || p.me.role === 'admin';
  const opts = allowed.map((x) => ({ value: x.value, label: x.label }));
  return [
    PageHead({ kicker: v.kicker, title: v.title }),
    h('div', { class: 'p-seg' },
      allowed.length === 1 ? null : p.device === 'laptop'
        ? Seg({ label: 'Settings section', value: view, onChange: setView, optStyle: { padding: '7px 4px' }, options: opts })
        : Dropdown({ label: 'Section', value: view, onChange: setView, options: opts })),
    h('div', { class: 'p-body', style: view === 'values' ? { gap: 'var(--space-6)' } : undefined },
      view === 'values' && Values(p.meta, true), // only shown to roles that may change it
      view === 'correct' && CorrectStock(p.meta, true),
      view === 'count' && FullCount(p.meta, true),
      view === 'oracle' && OracleValues(p.meta, p.me.role === 'admin'),
      view === 'quality' && DataQuality(p.meta, lead),
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
  const [rowMsg, setRowMsg] = flash('oracle.row'); // shown under the value that was changed
  const options = (col) => {
    const list = col === 'SUIT_TYPE' ? meta.types.map((t) => ({ value: String(t.id), label: t.name }))
      : col === 'SUIT_COLOR' ? meta.colors.map((c) => ({ value: String(c.id), label: c.name }))
        : col === 'SUIT_SIZE' ? meta.sizes.map((s) => ({ value: String(s.id), label: s.code }))
          : meta.locations.map((l) => ({ value: String(l.id), label: l.code }));
    return [{ value: '', label: 'Not mapped' }, ...list, { value: 'ignore', label: 'Ignore' }];
  };
  const change = async (v, choice) => {
    if (!choice) {
      // Mappings are never removed (issues already counted keep their mapping); say so instead of doing nothing.
      if (v.mapped) setRowMsg({ id: v.id, error: 'A mapped value cannot be set back to "Not mapped". Choose another GI value, or Ignore.' });
      return;
    }
    try {
      const r = await api(`/oracle-values/${v.id}`, { method: 'PUT', json: choice === 'ignore' ? { ignore: true } : { targetId: Number(choice) } });
      const st = r.byStatus ?? {};
      const parts = [`${v.oracle_column} ${v.oracle_value} mapped`];
      if (r.reclassified) {
        const how = [st.applied && `${fmtNum(st.applied)} applied to stock`, st.before_start && `${fmtNum(st.before_start)} before the starting count`,
          st.ignored && `${fmtNum(st.ignored)} ignored`].filter(Boolean).join(', ');
        parts.push(`${fmtNum(r.reclassified)} held rows released${how ? ` (${how})` : ''}`);
      }
      if (r.stillHeld) parts.push(`${fmtNum(r.stillHeld)} rows with this value still wait for their other values to be mapped`);
      else if (!r.reclassified) parts.push('no rows were waiting for it');
      setRowMsg({ id: v.id, text: parts.join(' · ') });
      reload('/oracle-values', '/stock', '/trends', '/data-quality');
    } catch (e) {
      setRowMsg({ id: v.id, error: e.message });
    }
  };
  return [
    h('div', { class: 'note' }, 'How each value in the Oracle issue table translates to GI. New values appear first. An issue row is held until all four of its values (type, color, size, level) are mapped; it then counts against stock from the fab\'s starting count on.'),
    ErrorNote(error),
    h('div', { style: { display: 'flex', flexDirection: 'column' } },
      (data ?? []).flatMap((v) => [h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10, alignItems: 'center', padding: '6px 0' } },
        h('div', null,
          h('div', { style: { fontWeight: 600, fontSize: 15 } }, `${v.oracle_value} `, !v.mapped && h('span', { class: 'tag tag-accent-2' }, 'New')),
          h('div', { style: { fontSize: 13, color: 'var(--color-neutral-700)' } }, `${v.oracle_column} · ${fmtNum(v.row_count)} rows${v.heldRows ? ` · ${v.heldRows} held` : ''}`)),
        canEdit
          ? Dropdown({ id: v.id, label: 'GI value', value: v.is_ignored ? 'ignore' : v.gi_id === null ? '' : String(v.gi_id), onChange: (c) => change(v, c), options: options(v.oracle_column) })
          : h('span', null, v.is_ignored ? 'Ignore' : options(v.oracle_column).find((o) => o.value === String(v.gi_id))?.label ?? 'Not mapped')),
        rowMsg && rowMsg.id === v.id && h('div', { role: 'status', style: { padding: '0 0 8px' } }, rowMsg.error ? Warn(rowMsg.error) : Msg({ tag: 'Saved', text: rowMsg.text }))])),
  ];
}

function DataQuality(meta, canEdit) {
  const { data, error } = load('/data-quality?days=30');
  const [find, setFind] = state('quality.find', '');
  // The result is shown right under the row that was clicked (the top of the page may be scrolled away).
  const [rowMsg, setRowMsg] = flash('quality.row');
  const toggle = async (b) => {
    try {
      const r = await api('/data-quality/excluded', { method: 'PUT', json: { barcode: b.barcode, excluded: !b.excluded } });
      setRowMsg({ barcode: b.barcode, text: `${r.excluded ? 'Left out' : 'Counted again'} · ${fmtNum(r.changed)} issues ${r.excluded ? 'no longer count' : 'count again'} in Trends and Stock` });
      reload('/data-quality', '/stock', '/trends');
    } catch (e) {
      setRowMsg({ barcode: b.barcode, error: e.message });
    }
  };
  // The page gets the most issued barcodes; any other one is found on the server (the demo searches the ones it has).
  const top = data?.unregisteredBarcodes ?? [];
  const total = data?.unregisteredTotal ?? top.length;
  const leftOut = data?.unregisteredExcluded ?? top.filter((b) => b.excluded).length;
  const term = find.trim();
  const found = term && !DEMO ? load(`/data-quality/unregistered?find=${encodeURIComponent(term)}&limit=50`, 'quality.found') : null;
  const shown = term
    ? (DEMO ? top.filter((b) => b.barcode.toLowerCase().includes(term.toLowerCase())) : found?.data ?? []).slice(0, 50)
    : top.slice(0, 50);
  const m = new Map();
  for (const r of data?.perDay ?? []) {
    const x = m.get(r.day) ?? { incomplete: 0, total: 0 };
    m.set(r.day, { incomplete: x.incomplete + Number(r.incomplete), total: x.total + Number(r.total) });
  }
  const days = [...m].slice(-14).reverse();
  const download = async (path, name) => {
    const res = DEMO ? await demoFetch(path) : await fetch(`api${path}`, { headers: authHeaders() });
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
  };
  const conflicts = data?.conflictingBarcodes ?? [];
  const conflictTotal = data?.conflictingTotal ?? conflicts.length;
  const combo = (k) => `${k.type} / ${k.color} / ${k.size}`;
  return [
    h('div', { class: 'note' }, 'Garments whose barcode is not in the suit master come through as GOWN / OTHER / OTHER. They never count per garment type, size or color, but they count as issued. A barcode that is only dirty data can be left out of the issued numbers below (Leave out); its issues then no longer count anywhere, now and in future imports, until you count it again.'),
    ErrorNote(error),
    h('table', { class: 'table num' },
      h('thead', null, h('tr', null, h('th', null, 'Day'), h('th', { style: right }, 'Unregistered'), h('th', { style: right }, 'All issues'), h('th', { style: right }, '%'))),
      h('tbody', null, days.map(([d, v]) => h('tr', null, h('td', null, d), h('td', { style: right }, v.incomplete), h('td', { style: right }, fmtNum(v.total)),
        h('td', { style: right }, v.total ? ((v.incomplete / v.total) * 100).toFixed(1) : '0'))))),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 } },
      h('h4', { style: { margin: 0 } }, 'Unregistered barcodes ', h('span', { style: { fontSize: 13, fontWeight: 400, color: 'var(--color-neutral-700)' } }, `· ${fmtNum(total)} for the vendor to register${leftOut ? ` · ${fmtNum(leftOut)} left out` : ''}`)),
      h('button', { class: 'btn btn-secondary', onClick: () => download('/data-quality/unregistered.csv', 'unregistered-barcodes.csv'), style: { minHeight: 44 } }, 'Download CSV')),
    h('input', { class: 'input', placeholder: 'Find a barcode', 'aria-label': 'Find a barcode', value: find, onInput: (e) => setFind(e.target.value), style: { minHeight: 44, maxWidth: 360 } }),
    h('table', { class: 'table num' },
      h('thead', null, h('tr', null, h('th', null, 'Barcode'), h('th', { style: right }, 'Times'),
        h('th', { title: 'INSERT_TIME of the latest scan, exactly as in Oracle (Phoenix time): search for this in an Oracle export' }, 'Last scan (INSERT_TIME)'),
        h('th', null, 'Where'), h('th', { style: right }, 'Issued count'))),
      // white-space: pre keeps runs of spaces in barcodes visible exactly as stored (HTML would merge them).
      h('tbody', null, shown.flatMap((b) => [h('tr', { style: b.excluded ? { color: 'var(--color-neutral-600)' } : null },
        h('td', { style: { whiteSpace: 'pre', textDecoration: b.excluded ? 'line-through' : null }, title: JSON.stringify(b.barcode) }, b.barcode), h('td', { style: right }, b.times),
        h('td', null, b.last_insert_time ?? ''), h('td', null, b.locations),
        h('td', { style: { ...right, whiteSpace: 'nowrap' } },
          b.excluded && h('span', { class: 'tag tag-neutral', style: { marginRight: 6 } }, 'left out'),
          canEdit && h('button', { class: 'btn btn-ghost', onClick: () => toggle(b), style: { minHeight: 36, padding: '0 6px' } }, b.excluded ? 'Count again' : 'Leave out'))),
        rowMsg && rowMsg.barcode === b.barcode && h('tr', null, h('td', { colspan: 5, role: 'status' },
          rowMsg.error ? Warn(rowMsg.error) : Msg({ tag: 'Saved', text: rowMsg.text })))]))),
    term && !shown.length && (DEMO || found?.data) && h('div', { class: 'note' }, 'No unregistered barcode contains that text.'),
    total > 50 && !term && h('div', { class: 'note' }, `Showing the 50 barcodes issued most often; find a barcode to see any of the ${fmtNum(total)}.`),
    h('div', { class: 'note' }, 'Last scan is INSERT_TIME exactly as in Oracle (Phoenix time), to search for in your export. Hover a barcode to see it with its exact spaces.'),
    // One barcode is one garment, so its type, color and size should never change.
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginTop: 8 } },
      h('h4', { style: { margin: 0 } }, 'Barcodes with conflicting values ',
        h('span', { style: { fontSize: 13, fontWeight: 400, color: 'var(--color-neutral-700)' } }, `· ${fmtNum(conflictTotal)} barcodes`)),
      h('button', { class: 'btn btn-secondary', disabled: !conflicts.length, onClick: () => download('/data-quality/conflicts.csv', 'barcodes-with-conflicting-values.csv'), style: { minHeight: 44 } }, 'Download CSV')),
    h('div', { class: 'note' }, 'The same barcode was issued with different type, color or size. Each combination is listed with how often and when it was seen. "unregistered" marks GOWN / OTHER / OTHER rows; a barcode that is unregistered first and complete later was registered in between. "same scan, not counted" marks rows with the same barcode and INSERT_TIME as another row: only the first one counts.'),
    conflicts.length
      ? h('table', { class: 'table num' },
        h('thead', null, h('tr', null, h('th', null, 'Barcode'), h('th', null, 'Type / color / size'), h('th', { style: right }, 'Times'),
          h('th', { title: 'First and last INSERT_TIME exactly as in Oracle (Phoenix time)' }, 'INSERT_TIME'), h('th', null, 'Where'))),
        h('tbody', null, conflicts.slice(0, 50).flatMap((b) => b.combinations.map((k, i) => h('tr', null,
          h('td', { style: { whiteSpace: 'pre', fontWeight: 600, borderBottomColor: i < b.combinations.length - 1 ? 'transparent' : null }, title: JSON.stringify(b.barcode) }, i === 0 ? b.barcode : ''),
          h('td', { style: { whiteSpace: 'pre' } }, combo(k),
            k.unregistered && h('span', { class: 'tag tag-neutral', style: { marginLeft: 6 } }, 'unregistered'),
            k.notCounted && h('span', { class: 'tag tag-accent-2', style: { marginLeft: 6 }, title: 'Same barcode and INSERT_TIME as another row: the same scan, so it was not counted again' }, 'same scan, not counted')),
          h('td', { style: right }, k.times),
          h('td', null, k.first_insert_time === k.last_insert_time ? k.last_insert_time : `${k.first_insert_time} – ${k.last_insert_time}`),
          h('td', null, k.locations))))))
      : h('div', { class: 'note' }, data ? 'None found: every barcode always came with the same type, color and size.' : ''),
    conflictTotal > 50 && h('div', { class: 'note' }, `Showing the 50 barcodes with the most issues; Download CSV has all ${fmtNum(conflictTotal)}.`),
  ];
}

/** CSV export of the Oracle issue table, for test sites that cannot reach Oracle. Rows already in GI are skipped. */
function CsvUpload(isAdmin) {
  const [file, setFile] = state('upload.file', null);
  const [busy, setBusy] = state('upload.busy', false);
  const [result, setResult] = state('upload.result', null);
  const [failure, setFailure] = state('upload.failure', null);
  const [progress, setProgress] = state('upload.progress', null); // { phase: 'upload' | 'import', ... }
  const send = async () => {
    setBusy(true);
    setResult(null);
    setFailure(null);
    setProgress({ phase: 'upload', fraction: 0 });
    try {
      // 1. Upload; the server checks the file and starts the import in the background.
      const started = await apiUpload('/sync/upload', file, { 'content-type': 'text/csv', 'X-File-Name': encodeURIComponent(file.name) },
        (fraction) => setProgress({ phase: 'upload', fraction }));
      // 2. Follow the import until it is done (progress is kept in the database, so any server can answer).
      let run = { status: 'running', done: 0, total: started.total };
      setProgress({ phase: 'import', done: 0, total: started.total });
      while (run.status === 'running') {
        await new Promise((r) => setTimeout(r, 700));
        run = await api(`/sync/runs/${started.runId}`);
        setProgress({ phase: 'import', done: run.done, total: run.total });
      }
      if (run.status !== 'ok') throw new Error(`The import stopped after ${fmtNum(run.done)} of ${fmtNum(run.total)} rows: ${run.error ?? 'unknown error'}. Rows imported so far are kept; upload the file again to finish.`);
      setResult(run);
      setFile(null);
      const input = document.getElementById('csvfile');
      if (input) input.value = '';
      reload('/sync', '/alerts', '/stock', '/trends', '/oracle-values', '/data-quality');
    } catch (e) {
      setFailure({ message: e.message, problems: e.data?.problems ?? [] });
    }
    setProgress(null);
    setBusy(false);
  };
  const pct = progress && (progress.phase === 'upload' ? progress.fraction : progress.total ? progress.done / progress.total : 0);
  const st = result?.byStatus ?? {};
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    h('h4', { class: 'sec', style: { margin: 0 } }, 'Upload an Oracle export'),
    h('div', { class: 'note' }, 'A CSV file of the Oracle issue table, with the column names in the first line (',
      h('code', null, 'SUIT_BARCODE, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE, SUIT_LEVEL, STATE, INSERT_TIME'),
      '). INSERT_TIME is the scan time in Phoenix time; other columns (RECTIME and so on) are ignored. Only rows with STATE = EMPLOYEE GOWN ISSUE are used. Rows already in GI (same barcode and INSERT_TIME) are skipped, so uploading the same or an overlapping file again is safe. Do not open and save the file in Excel: it drops the seconds from times and changes barcodes longer than 15 digits (2399600002641084 becomes 2399600002641080). To look at an export, use a text editor.'),
    isAdmin
      ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        h('label', { class: 'btn btn-secondary', style: { position: 'relative', minHeight: 44, cursor: 'pointer' } },
          'Choose file',
          h('input', { id: 'csvfile', type: 'file', accept: '.csv,text/csv,text/plain', onChange: (e) => { setFile(e.target.files[0] ?? null); setResult(null); setFailure(null); },
            style: { position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden', pointerEvents: 'none' } })),
        h('span', { class: 'num', style: { flex: '1 1 160px', minWidth: 0, fontSize: 14, color: file ? 'var(--color-text)' : 'var(--color-neutral-700)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          file ? `${file.name} · ${fmtNum(Math.ceil(file.size / 1024))} KB` : 'No file chosen'),
        h('button', { class: 'btn btn-primary', disabled: !file || busy, onClick: send, style: { minHeight: 44 } }, busy ? 'Importing…' : 'Upload and import'))
      : h('div', { class: 'note' }, 'Only an admin can upload files (Settings › This device to switch user while there is no SSO).'),
    progress && h('div', { role: 'status', 'aria-live': 'polite', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      h('div', { style: { height: 8, borderRadius: 4, background: 'var(--color-neutral-200)', overflow: 'hidden' } },
        h('div', { style: { height: '100%', width: `${Math.round(pct * 100)}%`, background: 'var(--color-accent)', transition: 'width .3s' } })),
      h('div', { class: 'num', style: { fontSize: 14, color: 'var(--color-neutral-700)' } },
        progress.phase === 'upload'
          ? `Uploading… ${Math.round(pct * 100)} %`
          : `Importing… ${fmtNum(progress.done)} of ${fmtNum(progress.total)} rows (${Math.round(pct * 100)} %)`)),
    result && Msg({ tag: 'Imported', text: `${result.fileRows !== undefined ? fmtNum(result.fileRows) + ' rows in the file · ' : ''}${fmtNum(result.new)} new issues (${fmtNum(st.applied ?? 0)} applied, ${fmtNum(st.held_unmapped ?? 0)} held, ${fmtNum(st.before_start ?? 0)} before the starting count, ${fmtNum(st.ignored ?? 0)} ignored) · ${fmtNum(result.alreadyImported)} already in GI${result.conflicts ? ` · ${fmtNum(result.conflicts)} same scan with other values (not counted, see Data quality)` : ''}${result.otherState ? ` · ${fmtNum(result.otherState)} other STATE` : ''}` }),
    failure && h('div', { role: 'alert' }, Warn(failure.message, failure.problems.length ? h('ul', { style: { margin: '6px 0 0', paddingLeft: 18 } }, failure.problems.map((p) => h('li', null, p))) : null)));
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
  const csvOnly = s?.source === 'csv';
  return [
    s && (s.stale
      ? Warn(`No successful import for a while — last ${s.lastSuccessfulImport ? fmtWhen(s.lastSuccessfulImport) : 'never'}.`)
      : Msg({ tag: 'OK', text: `Last import ${s.lastSuccessfulImport ? fmtWhen(s.lastSuccessfulImport) : '—'} · issues up to ${s.issuesUpTo ? fmtWhen(s.issuesUpTo) : '—'} · ${csvOnly ? 'issues come from CSV uploads' : `every ${Math.round(s.pollSeconds / 60)} min`}` })),
    isAdmin && !csvOnly && h('div', { style: { display: 'flex', gap: 8 } },
      h('button', { class: 'btn btn-secondary', disabled: busy, onClick: () => run('/sync/run'), style: { minHeight: 44 } }, 'Run import now'),
      h('button', { class: 'btn btn-secondary', disabled: busy, onClick: () => run('/sync/sweep'), style: { minHeight: 44 } }, 'Run catch-up sweep')),
    ErrorNote(errorOf('import')),
    CsvUpload(isAdmin),
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
      h('tbody', null, (runs.data ?? []).map((r) => h('tr', null, h('td', null, fmtWhen(r.started_at)), h('td', null, r.note ? `${r.kind} · ${r.note}` : r.kind), h('td', { style: right }, fmtNum(r.rows_new)),
        h('td', { style: right }, fmtNum(r.rows_applied)), h('td', { style: right }, r.rows_held), h('td', null, r.status))))),
  ];
}

function ThisDevice({ device, onSwitchView, user, onChooseUser, me }) {
  const [asking, setAsking] = state('admin.asking', false);
  const [code, setCode] = state('admin.code', '');
  const [busy, setBusy] = state('admin.busy', false);
  const choose = (u) => {
    if (u === 'dev-admin' && user !== 'dev-admin') {
      setAsking(true); // the admin needs the passcode first
      setCode('');
      return;
    }
    setAsking(false);
    onChooseUser(u);
  };
  const unlock = async () => {
    setBusy(true);
    const ok = await attempt('admin', async () => {
      await unlockAdmin(code);
      return true;
    });
    setBusy(false);
    if (ok) {
      setAsking(false);
      setCode('');
      onChooseUser('dev-admin');
    }
  };
  const options = DEV_USERS.map((u) => ({ ...u, trailing: u.locked ? ph('lock', 16, 'var(--color-neutral-700)') : null }));
  return [
    h('div', { class: 'note' }, 'The layout is chosen from the type of device. Change it here if this device got the wrong one; the choice is remembered on this device.'),
    Seg({ label: 'Layout', value: device, onChange: onSwitchView, options: [{ value: 'phone', label: 'Phone layout' }, { value: 'laptop', label: 'Laptop layout' }] }),
    h('div', { class: 'note' }, DEMO
      ? `Demo: signed in as ${me.name}. Choose another user to see what each role can do; the data stays the same and nothing is saved.`
      : 'Company sign-in (SSO) is not connected yet. For development, choose who you are:'),
    Dropdown({ label: DEMO ? 'Signed in as (demo)' : 'Signed in as (dev)', value: user, onChange: choose, options }),
    asking && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h('div', { class: 'note', style: { display: 'flex', alignItems: 'center', gap: 6 } }, ph('lock', 16), DEMO ? 'Admin is locked. Demo: any passcode works.' : 'Admin is locked. Type the admin passcode:'),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': 'Admin passcode', value: code, onInput: (e) => setCode(e.target.value),
          onKeyDown: (e) => e.key === 'Enter' && code && !busy && unlock(), style: { minHeight: 44, flex: '1 1 200px' } }),
        h('button', { class: 'btn btn-primary', disabled: !code || busy, onClick: unlock, style: { minHeight: 44 } }, busy ? 'Checking…' : 'Unlock'),
        h('button', { class: 'btn btn-ghost', onClick: () => setAsking(false), style: { minHeight: 44 } }, 'Cancel')),
      ErrorNote(errorOf('admin'))),
  ];
}
