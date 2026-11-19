import { h, state, flash, load, reload } from '../dom.js';
import { api, fmtNum, fmtToday, fmtWhen, newKey } from '../api.js';
import { ph } from '../icons.js';
import { attempt, Dropdown, ErrorNote, errorOf, GIcon, Msg, PageHead, QtyField, Seg, Stepper } from '../ui.js';

const DRAFT_KEY = 'gi.deliveryDraft';

function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function Receive({ meta, me }) {
  const [view, setView] = state('receive.view', 'new');
  const canPost = me.role !== 'viewer';
  return [
    PageHead({ kicker: view === 'new' ? `Receive · ${fmtToday()}` : 'Receive · history', title: view === 'new' ? 'Morning delivery' : 'Past deliveries' }),
    h('div', { class: 'p-seg' },
      Seg({ label: 'Receive view', value: view, onChange: setView, options: [{ value: 'new', label: 'New delivery' }, { value: 'history', label: 'History' }] })),
    view === 'new' ? NewDelivery({ meta, canPost }) : History({ canEdit: canPost }),
  ];
}

const typeName = (t) => (t.code === 'BOOT' ? 'Boots' : t.name);
const same = (a, b) => a.garmentTypeId === b.garmentTypeId && a.colorId === b.colorId && a.sizeId === b.sizeId && a.locationId === b.locationId;

function NewDelivery({ meta, canPost }) {
  const colors = meta.colors.filter((c) => c.active);
  const sizes = meta.sizes.filter((s) => s.active);
  const [form, setForm] = state('receive.form', () => ({ garmentTypeId: meta.types[0].id, colorId: colors[0].id, sizeId: sizes[0].id, locationId: meta.locations[0].id, qty: '20' }));
  const [lines, setLinesRaw] = state('receive.lines', loadDraft);
  const [busy, setBusy] = state('receive.busy', false);
  const [posted, setPosted] = flash('receive.posted');
  // RCV-07: the draft survives a reload or a dropped connection.
  const setLines = (ls) => {
    setLinesRaw(ls);
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(ls));
    } catch {
      /* ignore */
    }
  };
  const set = (k) => (v) => setForm({ ...form, [k]: v });
  const type = (l) => meta.types.find((t) => t.id === l.garmentTypeId);
  const metaText = (l) => [meta.colors.find((c) => c.id === l.colorId)?.name, meta.sizes.find((s) => s.id === l.sizeId)?.code, meta.locations.find((x) => x.id === l.locationId)?.code].join(' · ');
  const add = () => {
    const qty = parseInt(form.qty, 10);
    if (!qty) return;
    const key = { garmentTypeId: form.garmentTypeId, colorId: form.colorId, sizeId: form.sizeId, locationId: form.locationId };
    setLines(lines.some((l) => same(l, key)) ? lines.map((l) => (same(l, key) ? { ...l, qty: l.qty + qty } : l)) : [{ ...key, qty }, ...lines]);
    setPosted(null);
  };
  const total = lines.reduce((s, l) => s + l.qty, 0);
  const post = async () => {
    setBusy(true);
    await attempt('receive', async () => {
      const key = sessionStorage.getItem('gi.postKey') ?? newKey();
      sessionStorage.setItem('gi.postKey', key); // same key on retry → no double post (NFR-06)
      const r = await api('/deliveries', { method: 'POST', json: { lines }, headers: { 'Idempotency-Key': key } });
      sessionStorage.removeItem('gi.postKey');
      setLines([]);
      setPosted(`${fmtNum(r.total ?? total)} items added to stock`);
      reload('/deliveries', '/stock', '/trends');
    });
    setBusy(false);
  };

  return [
    h('div', { class: 'p-body' },
      posted && Msg({ tag: 'Posted', text: posted }),
      ErrorNote(errorOf('receive')),
      h('div', { class: 'fields' },
        Dropdown({ label: 'Garment', value: form.garmentTypeId, onChange: set('garmentTypeId'), options: meta.types.map((t) => ({ value: t.id, label: typeName(t), icon: t.icon })) }),
        Dropdown({ label: 'Color', value: form.colorId, onChange: set('colorId'), options: colors.map((c) => ({ value: c.id, label: c.name })) }),
        Dropdown({ label: 'Size', value: form.sizeId, onChange: set('sizeId'), options: sizes.map((s) => ({ value: s.id, label: s.code })) }),
        Dropdown({ label: 'Location', value: form.locationId, onChange: set('locationId'), options: meta.locations.map((l) => ({ value: l.id, label: l.code })) }),
        QtyField({ label: 'Quantity', value: form.qty, onChange: set('qty') }),
        h('div', { style: { display: 'flex', alignItems: 'flex-end' } },
          h('button', { class: 'btn btn-secondary', onClick: add, style: { width: '100%', minHeight: 54, borderRadius: 'var(--radius-lg)' } }, ph('plus', 18), 'Add line'))),
      h('div', { style: { display: 'flex', flexDirection: 'column' } },
        lines.map((l, i) => h('div', { class: 'line' },
          GIcon({ name: type(l)?.icon, size: 28, color: 'var(--color-accent-700)' }),
          h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'line-name' }, type(l) ? typeName(type(l)) : ''), h('div', { class: 'line-meta' }, metaText(l))),
          Stepper({ label: 'quantity', step: 5, value: l.qty, onChange: (q) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: q } : x)).filter((x) => x.qty > 0)) }))),
        !lines.length && h('div', { style: { fontSize: 14, color: 'var(--color-neutral-700)', padding: '8px 0' } }, 'No lines yet. Add each garment, color, size and location from the delivery.'))),
    h('div', { class: 'p-foot' },
      h('div', { style: { flex: 1, fontSize: 13, color: 'var(--color-neutral-700)' } },
        `${lines.length} lines`, h('br'), h('span', { style: { fontSize: 17, fontWeight: 600, color: 'var(--color-text)' } }, `${fmtNum(total)} items`)),
      h('button', { class: 'btn btn-primary', onClick: post, disabled: !lines.length || busy || !canPost, style: { minHeight: 48, fontSize: 15, padding: '0 22px' } }, busy ? 'Posting…' : 'Post delivery')),
  ];
}

const sign = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n)}`;

function History({ canEdit }) {
  const { data, error } = load('/deliveries?limit=30');
  const [open, setOpen] = state('history.open', null);
  const [draft, setDraft] = state('history.draft', {});
  const [saved, setSaved] = flash('history.saved');
  const plural = (g) => (g === 'Boots' ? 'Boots' : g);

  const save = (d, voidAll = false) => attempt('history', async () => {
    const r = await api(`/deliveries/${d.id}/correction`, { method: 'POST', json: { void: voidAll, lines: Object.entries(draft).map(([lineId, qty]) => ({ lineId: Number(lineId), qty })) } });
    setSaved(`${fmtWhen(d.receivedAt)} · stock ${sign(r.totalDelta)}`);
    setOpen(null);
    setDraft({});
    reload('/deliveries', '/stock', '/trends');
  });

  return h('div', { class: 'p-body', style: { gap: 'var(--space-2)' } },
    saved && h('div', { style: { paddingBottom: 6 } }, Msg({ tag: 'Saved', text: saved })),
    ErrorNote(error ?? errorOf('history')),
    (data ?? []).map((d) => {
      const total = d.lines.reduce((s, l) => s + l.qty_current, 0);
      const isOpen = open === d.id;
      const diff = d.lines.reduce((s, l) => s + ((draft[l.id] ?? l.qty_current) - l.qty_current), 0);
      const changed = d.lines.some((l) => draft[l.id] !== undefined && draft[l.id] !== l.qty_current);
      const last = d.corrections[d.corrections.length - 1];
      const editable = canEdit && d.status !== 'voided';
      return h('div', { style: { display: 'flex', flexDirection: 'column' } },
        h('button', {
          onClick: () => { setOpen(isOpen ? null : d.id); setDraft({}); }, 'aria-expanded': String(isOpen),
          style: { display: 'flex', gap: 10, alignItems: 'center', minHeight: 60, padding: '8px 0', border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', color: 'var(--color-text)' },
        },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { class: 'line-name' }, fmtWhen(d.receivedAt)),
          h('div', { class: 'line-meta' }, `${fmtNum(total)} items · ${d.lines.length} lines · ${[...new Set(d.lines.map((l) => l.location))].join(', ')}`)),
        d.status !== 'posted' && h('span', { class: 'tag tag-neutral' }, d.status === 'voided' ? 'Voided' : 'Edited'),
        h('span', { style: { color: 'var(--color-accent-700)' } }, ph(isOpen ? 'caretUp' : 'caretDown', 18))),
        isOpen && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '0 0 14px' } },
          last && h('div', { style: { fontSize: 13, fontStyle: 'italic', color: 'var(--color-neutral-700)', paddingBottom: 4 } },
            `${last.isVoid ? 'Voided' : 'Corrected'} ${fmtWhen(last.at)} by ${last.by} · ${sign(last.totalDelta)} items`),
          d.lines.map((l) => {
            const q = draft[l.id] ?? l.qty_current;
            const moved = q !== l.qty_current;
            return h('div', { class: 'line', style: { padding: '6px 0' } },
              GIcon({ name: l.icon, size: 24, color: 'var(--color-accent-700)' }),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontWeight: 600, fontSize: 14 } }, plural(l.garment)),
                h('div', { style: { fontSize: 12, color: moved ? 'var(--color-accent-2-700)' : 'var(--color-neutral-700)' } },
                  `${l.color} · ${l.size} · ${l.location}${moved ? ` · was ${l.qty_current}` : ''}`)),
              editable
                ? Stepper({ label: 'quantity', value: q, size: 16, width: 36, onChange: (v) => setDraft({ ...draft, [l.id]: v }) })
                : h('span', { class: 'num', style: { fontWeight: 600 } }, q));
          }),
          h('div', { style: { fontSize: 14, padding: '6px 0', color: changed ? 'var(--color-accent-2-700)' : 'var(--color-neutral-700)' } },
            !changed ? 'Tap − / + to fix a quantity.' : diff === 0 ? 'Quantities moved, total unchanged.'
              : `${sign(diff)} items will be ${diff > 0 ? 'added to' : 'taken out of'} stock`),
          editable && h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { class: 'btn btn-primary', disabled: !changed, onClick: () => save(d), style: { minHeight: 44 } }, 'Save correction'),
            h('button', { class: 'btn btn-ghost', onClick: () => setOpen(null), style: { minHeight: 44 } }, 'Cancel'),
            h('button', { class: 'btn btn-ghost', onClick: () => confirm('Void this delivery? All its items are taken out of stock.') && save(d, true),
              style: { minHeight: 44, marginLeft: 'auto', color: 'var(--color-accent-2-700)' } }, 'Void delivery'))));
    }),
    h('div', { class: 'note', style: { paddingTop: 6 } }, 'Open a delivery to fix a wrong count. Saving changes stock by the difference and keeps a note of the change.'));
}
