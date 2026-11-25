import { h, state, flash, load, reload } from '../dom.js';
import { api, fmtNum, fmtToday, fmtWhen, newKey } from '../api.js';
import { ph } from '../icons.js';
import { attempt, Dropdown, ErrorNote, errorOf, GIcon, GridHead, Msg, PageHead, QtyField, Seg, ShowAll, Stepper, trimGrid } from '../ui.js';

const DRAFT_KEY = 'gi.deliveryDraft';
const FORM_KEY = 'gi.receiveForm'; // the last garment, color, size, location and quantity used on this device
const MODE_KEY = 'gi.receiveMode'; // 'grid' (size × color grid) or 'lines' (one line at a time)

function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

/** The form as last used on this device, keeping only choices that still exist (and are not hidden). */
function loadForm(meta, colors, sizes) {
  const first = { garmentTypeId: meta.types[0].id, colorId: colors[0].id, sizeId: sizes[0].id, locationId: meta.locations[0].id, qty: '20' };
  try {
    const f = JSON.parse(localStorage.getItem(FORM_KEY) ?? '{}');
    return {
      garmentTypeId: meta.types.some((t) => t.id === f.garmentTypeId) ? f.garmentTypeId : first.garmentTypeId,
      colorId: colors.some((c) => c.id === f.colorId) ? f.colorId : first.colorId,
      sizeId: sizes.some((x) => x.id === f.sizeId) ? f.sizeId : first.sizeId,
      locationId: meta.locations.some((l) => l.id === f.locationId) ? f.locationId : first.locationId,
      qty: /^\d+$/.test(f.qty ?? '') ? f.qty : first.qty,
    };
  } catch {
    return first;
  }
}

/** Puts the cursor in the quantity with its digits selected, so typing replaces them. */
const focusQty = () => requestAnimationFrame(() => {
  const el = document.getElementById('rcv-qty');
  if (el) { el.focus(); el.select(); }
});

export function Receive({ meta, me }) {
  const [view, setView] = state('receive.view', 'new');
  const canPost = me.role !== 'viewer';
  return [
    PageHead({ kicker: view === 'new' ? `Receive · ${fmtToday()}` : 'Receive · history', title: view === 'new' ? 'Off truck' : 'Past deliveries' }),
    h('div', { class: 'p-seg' },
      Seg({ label: 'Receive view', value: view, onChange: setView, options: [{ value: 'new', label: 'New delivery' }, { value: 'history', label: 'History' }] })),
    view === 'new' ? NewDelivery({ meta, canPost }) : History({ canEdit: canPost }),
  ];
}

const typeName = (t) => (t.code === 'BOOT' ? 'Boots' : t.name);
/** "205 pieces · 40 pairs": quantities added up per unit (boots are counted in pairs). */
export const perUnit = (items) => {
  const sums = new Map();
  for (const { unit, qty } of items) sums.set(unit || 'pieces', (sums.get(unit || 'pieces') ?? 0) + qty);
  return [...sums].map(([u, n]) => `${fmtNum(n)} ${n === 1 ? u.replace(/s$/, '') : u}`).join(' · ') || '0 items';
};
const Unit = (unit) => h('span', { style: { width: 44, fontSize: 13, color: 'var(--color-neutral-700)' } }, unit);
const same = (a, b) => a.garmentTypeId === b.garmentTypeId && a.colorId === b.colorId && a.sizeId === b.sizeId && a.locationId === b.locationId;

function NewDelivery({ meta, canPost }) {
  const colors = meta.colors.filter((c) => c.active);
  const sizes = meta.sizes.filter((s) => s.active);
  const [form, setFormRaw] = state('receive.form', () => loadForm(meta, colors, sizes));
  const setForm = (f) => {
    setFormRaw(f);
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(f));
    } catch {
      /* ignore */
    }
  };
  const [lines, setLinesRaw] = state('receive.lines', loadDraft);
  const [busy, setBusy] = state('receive.busy', false);
  const [mode, setModeRaw] = state('receive.mode', () => { try { return localStorage.getItem(MODE_KEY) === 'lines' ? 'lines' : 'grid'; } catch { return 'grid'; } });
  const setMode = (m) => { setModeRaw(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } };
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
  const set = (k) => (v) => {
    setForm({ ...form, [k]: v });
    if (k === 'sizeId' || k === 'colorId') focusQty(); // the quantity is what comes next
  };
  const type = (l) => meta.types.find((t) => t.id === l.garmentTypeId);
  const unitOf = (l) => type(l)?.unit ?? 'pieces';
  const formUnit = meta.types.find((t) => t.id === form.garmentTypeId)?.unit ?? 'pieces';
  const metaText = (l) => [meta.colors.find((c) => c.id === l.colorId)?.name, meta.sizes.find((s) => s.id === l.sizeId)?.code, meta.locations.find((x) => x.id === l.locationId)?.code].join(' · ');
  const add = () => {
    const qty = parseInt(form.qty, 10);
    if (!qty) return;
    const key = { garmentTypeId: form.garmentTypeId, colorId: form.colorId, sizeId: form.sizeId, locationId: form.locationId };
    setLines(lines.some((l) => same(l, key)) ? lines.map((l) => (same(l, key) ? { ...l, qty: l.qty + qty } : l)) : [{ ...key, qty }, ...lines]);
    setPosted(null);
  };
  const post = async () => {
    setBusy(true);
    await attempt('receive', async () => {
      const key = sessionStorage.getItem('gi.postKey') ?? newKey();
      sessionStorage.setItem('gi.postKey', key); // same key on retry → no double post (NFR-06)
      const added = perUnit(lines.map((l) => ({ unit: unitOf(l), qty: l.qty })));
      await api('/deliveries', { method: 'POST', json: { lines }, headers: { 'Idempotency-Key': key } });
      sessionStorage.removeItem('gi.postKey');
      setLines([]);
      setPosted(`${added} added to stock`);
      reload('/deliveries', '/stock', '/trends');
    });
    setBusy(false);
  };

  return [
    h('div', { class: 'p-body' },
      posted && Msg({ tag: 'Posted', text: posted }),
      ErrorNote(errorOf('receive')),
      Seg({ label: 'Entry', value: mode, onChange: setMode, optStyle: { minHeight: 36, fontSize: 13.5 },
        options: [{ value: 'grid', label: 'Size × color grid' }, { value: 'lines', label: 'One line at a time' }] }),
      mode === 'grid' ? GridEntry({ meta, form, setForm, lines, setLines, unitOf }) : [
      h('div', { class: 'fields' },
        Dropdown({ label: 'Garment', value: form.garmentTypeId, onChange: set('garmentTypeId'), options: meta.types.map((t) => ({ value: t.id, label: typeName(t), icon: t.icon })) }),
        Dropdown({ label: 'Color', value: form.colorId, onChange: set('colorId'), options: colors.map((c) => ({ value: c.id, label: c.name })) }),
        Dropdown({ label: 'Size', value: form.sizeId, onChange: set('sizeId'), options: sizes.map((s) => ({ value: s.id, label: s.code })) }),
        Dropdown({ label: 'Location', value: form.locationId, onChange: set('locationId'), options: meta.locations.map((l) => ({ value: l.id, label: l.code })) }),
        QtyField({ id: 'rcv-qty', label: `Quantity (${formUnit})`, value: form.qty, onChange: set('qty') }),
        h('div', { style: { display: 'flex', alignItems: 'flex-end' } },
          h('button', { class: 'btn btn-secondary', onClick: add, style: { width: '100%', minHeight: 54, borderRadius: 'var(--radius-lg)' } }, ph('plus', 18), 'Add line'))),
      h('div', { style: { display: 'flex', flexDirection: 'column' } },
        lines.map((l, i) => h('div', { class: 'line' },
          GIcon({ name: type(l)?.icon, size: 28, color: 'var(--color-accent-700)' }),
          h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'line-name' }, type(l) ? typeName(type(l)) : ''), h('div', { class: 'line-meta' }, metaText(l))),
          Stepper({ label: 'quantity', step: 5, value: l.qty, onChange: (q) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: q } : x)).filter((x) => x.qty > 0)) }),
          Unit(unitOf(l)))),
        !lines.length && h('div', { style: { fontSize: 14, color: 'var(--color-neutral-700)', padding: '8px 0' } }, 'No lines yet. Add each garment, color, size and location from the delivery.'))]),
    h('div', { class: 'p-foot' },
      h('div', { style: { flex: 1, fontSize: 13, color: 'var(--color-neutral-700)' } },
        `${lines.length} lines`, h('br'), h('span', { style: { fontSize: 17, fontWeight: 600, color: 'var(--color-text)' } }, perUnit(lines.map((l) => ({ unit: unitOf(l), qty: l.qty }))))),
      h('button', { class: 'btn btn-primary', onClick: post, disabled: !lines.length || busy || !canPost, style: { minHeight: 48, fontSize: 15, padding: '0 22px' } }, busy ? 'Posting…' : 'Post delivery')),
  ];
}

/** Delivery entry as a size × color grid for one garment type and location (UX plan 2.1). Each cell is the
 *  quantity of one draft line, so switching garment, location or entry mode keeps everything typed. Only the
 *  sizes and colors stocked at that location are shown (plus any already typed); Show all adds the rest. */
function GridEntry({ meta, form, setForm, lines, setLines, unitOf }) {
  const [showAll, setShowAll] = state('receive.gridAll', false);
  const g = load(`/stock/grid?garmentTypeId=${form.garmentTypeId}&locationId=${form.locationId}`, 'receive.grid');
  const here = (l) => l.garmentTypeId === form.garmentTypeId && l.locationId === form.locationId;
  const qtyOf = (sizeId, colorId) => lines.find((l) => here(l) && l.sizeId === sizeId && l.colorId === colorId)?.qty;
  const setQty = (sizeId, colorId, text) => {
    const qty = parseInt(text, 10) || 0;
    const key = { garmentTypeId: form.garmentTypeId, colorId, sizeId, locationId: form.locationId };
    const rest = lines.filter((l) => !same(l, key));
    const at = lines.findIndex((l) => same(l, key));
    if (!qty) setLines(rest);
    else if (at >= 0) setLines(lines.map((l, i) => (i === at ? { ...l, qty } : l)));
    else setLines([...lines, { ...key, qty }]);
  };
  // Enter (or the keyboard's Next) moves to the next cell.
  const next = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const cells = [...document.querySelectorAll('.entry-cell')];
    cells[cells.indexOf(e.target) + 1]?.focus();
  };
  const t = meta.types.find((x) => x.id === form.garmentTypeId);
  const tg = g.data && trimGrid({ ...g.data, rows: g.data.rows.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, sizeId: r.sizeId })) })) },
    (c) => !!c.stockItemId || !!qtyOf(c.sizeId, c.colorId), showAll);
  const cols = `52px repeat(${tg?.colors.length || 1}, minmax(0, 1fr))`;
  const mine = lines.filter(here);
  // Totals per garment and location typed so far; tap one to go back to it.
  const groups = [];
  for (const l of lines) {
    const k = `${l.garmentTypeId}|${l.locationId}`;
    let grp = groups.find((x) => x.k === k);
    if (!grp) groups.push(grp = { k, garmentTypeId: l.garmentTypeId, locationId: l.locationId, qty: 0, n: 0, unit: unitOf(l) });
    grp.qty += l.qty; grp.n += 1;
  }
  return [
    h('div', { style: { display: 'flex', gap: 8 } },
      Seg({ label: 'Delivery garment', style: { flex: 1 }, optStyle: { padding: '7px 2px', gap: 4, fontSize: 13.5 }, value: form.garmentTypeId,
        onChange: (v) => setForm({ ...form, garmentTypeId: v }), options: meta.types.map((x) => ({ value: x.id, label: x.plural, icon: x.icon })) }),
      Seg({ label: 'Delivery location', optStyle: { flex: 'none', padding: '7px 8px' }, value: form.locationId,
        onChange: (v) => setForm({ ...form, locationId: v }), options: meta.locations.map((l) => ({ value: l.id, label: l.code })) })),
    ErrorNote(g.error),
    tg && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, role: 'grid', 'aria-label': `Quantities delivered, ${t?.plural}` },
      tg.colors.length ? GridHead(tg.colors, cols) : h('div', { class: 'note' }, 'Nothing stocked here yet: tap Show all to enter any size and color.'),
      tg.rows.map((r) => h('div', { style: { display: 'grid', gridTemplateColumns: cols, gap: 4 } },
        h('span', { class: 'grid-size' }, r.size),
        r.cells.map((c) => {
          const v = qtyOf(r.sizeId, c.colorId);
          const color = tg.colors.find((x) => x.id === c.colorId)?.name;
          return h('input', {
            class: 'input num entry-cell', inputmode: 'numeric', enterkeyhint: 'next', 'aria-label': `${r.size} ${color}`,
            value: v ? String(v) : '', placeholder: '·',
            onInput: (e) => setQty(r.sizeId, c.colorId, e.target.value.replace(/\D/g, '')), onKeyDown: next,
            style: { minHeight: 48, textAlign: 'center', fontWeight: 600, fontSize: 18, padding: '6px 2px',
              background: v ? 'var(--color-accent-100)' : null, borderColor: v ? 'var(--color-accent)' : null },
          });
        }))),
      ShowAll(tg.hidden, showAll, setShowAll)),
    h('div', { style: { fontSize: 15, fontWeight: 600 } },
      `${t?.plural ?? ''} · ${meta.locations.find((l) => l.id === form.locationId)?.code}: `,
      h('span', { class: 'num' }, `${fmtNum(mine.reduce((a, l) => a + l.qty, 0))} ${t?.unit ?? 'pieces'} in ${mine.length} ${mine.length === 1 ? 'line' : 'lines'}`)),
    groups.length > 0 && h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
      groups.map((grp) => {
        const gt = meta.types.find((x) => x.id === grp.garmentTypeId);
        const cur = grp.garmentTypeId === form.garmentTypeId && grp.locationId === form.locationId;
        return h('button', { type: 'button', class: `btn ${cur ? 'btn-primary' : 'btn-secondary'}`, style: { minHeight: 40, fontSize: 13.5, padding: '0 10px', gap: 6 },
          onClick: () => setForm({ ...form, garmentTypeId: grp.garmentTypeId, locationId: grp.locationId }) },
        GIcon({ name: gt?.icon, size: 16 }), `${gt?.plural} ${meta.locations.find((l) => l.id === grp.locationId)?.code} · ${fmtNum(grp.qty)}`);
      })),
    h('div', { class: 'note' }, 'Type how many came for each size and color. Switch garment or location above; what you typed is kept. Clear a box to remove it.'),
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
      const total = perUnit(d.lines.map((l) => ({ unit: l.unit, qty: l.qty_current })));
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
          h('div', { class: 'line-meta' }, `${total} · ${d.lines.length} lines · ${[...new Set(d.lines.map((l) => l.location))].join(', ')}`)),
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
                : h('span', { class: 'num', style: { fontWeight: 600 } }, q),
              Unit(l.unit));
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
