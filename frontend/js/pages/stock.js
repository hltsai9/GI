import { h, state, load, reload } from '../dom.js';
import { api, fmtClock, fmtNum, fmtWhen } from '../api.js';
import { attempt, cellColors, ErrorNote, errorOf, GIcon, PageHead, Seg, statusText, Stepper, Warn } from '../ui.js';

export function Stock({ meta, me }) {
  const [view, setView] = state('stock.view', 'summary');
  const [typeId] = state('stock.type', meta.types[0].id);
  const [locId] = state('stock.loc', meta.locations[0].id);
  const summary = load('/stock/summary');
  const t = meta.types.find((x) => x.id === typeId) ?? meta.types[0];
  const head = view === 'summary'
    ? { kicker: `Stock · ${meta.locations.map((l) => l.code).join(' + ')} · as of ${summary.data ? fmtClock(summary.data.asOf) : ''}`, title: 'On hand' }
    : { kicker: 'Stock · grid', title: `${t.plural} · ${meta.locations.find((l) => l.id === locId)?.code}` };
  return [
    PageHead(head),
    h('div', { class: 'p-body' },
      Seg({ label: 'Stock view', value: view, onChange: setView, options: [{ value: 'summary', label: 'Summary' }, { value: 'grid', label: 'Grid' }] }),
      ErrorNote(summary.error),
      view === 'summary' ? summary.data && SummaryView(summary.data, meta) : GridView({ meta, me })),
  ];
}

function SummaryView(s, meta) {
  const unreg = s.unregistered.reduce((a, u) => a + u.sinceLastCheck, 0);
  const locs = meta.locations.map((l) => l.code);
  // One row per garment type: name and totals on the left, each location's stock side by side on the right.
  const cols = `minmax(0, 1fr) repeat(${locs.length}, minmax(64px, 132px))`;
  const big = { fontSize: 'clamp(30px, 8vw, 50px)', lineHeight: 1, fontWeight: 600, letterSpacing: '-.02em', textAlign: 'right' };
  const muted = { fontSize: 13, color: 'var(--color-neutral-700)' };
  const locLabel = { textAlign: 'right', fontSize: 18, fontWeight: 600, letterSpacing: '.06em' };
  const right = { textAlign: 'right' };
  const phone = document.documentElement.dataset.device === 'phone';
  const nameBlock = (t) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 } },
    GIcon({ name: t.icon, size: 34, color: 'var(--color-accent-700)' }),
    h('div', { style: { minWidth: 0 } },
      h('div', { style: { fontSize: 20, fontWeight: 600 } }, t.plural, h('span', { style: { ...muted, fontWeight: 400, marginLeft: 6 } }, `in ${t.unit}`)),
      h('div', { class: 'num', style: muted }, `Total ${fmtNum(t.onHand)} · ${t.daysOfCover !== null ? `about ${t.daysOfCover} days` : 'no recent issues'}`),
      h('div', { class: 'num', style: muted }, `Today +${fmtNum(t.deliveredToday)} in · −${fmtNum(t.issuedToday)} out`)));
  // Phone: the name on its own line, the locations side by side under it.
  const phoneView = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 22 } },
    s.totals.map((t) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      nameBlock(t),
      h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${locs.length}, minmax(0, 1fr))`, gap: 12, paddingLeft: 46 } },
        locs.map((l) => h('div', null,
          h('div', { class: 'kicker', style: { ...locLabel, textAlign: 'left' } }, l),
          h('div', { class: 'num', style: { fontSize: 40, lineHeight: 1.05, fontWeight: 600, letterSpacing: '-.02em' }, 'aria-label': `${t.plural} at ${l}` }, fmtNum(t.byLocation[l] ?? 0))))))),
    h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${locs.length}, minmax(0, 1fr))`, gap: 12, paddingLeft: 46, ...muted } },
      locs.map((l) => h('div', { class: 'num' }, `Unregistered ${l}: ${fmtNum(s.unregistered.find((u) => u.location === l)?.onHand ?? 0)}`))));
  return [
    s.sync.stale && Warn('The issue import has not run for a while, so stock may be too high.'),
    phone ? phoneView : h('div', { style: { display: 'grid', gridTemplateColumns: cols, columnGap: 12, rowGap: 20, alignItems: 'center' } },
      h('span'), locs.map((l) => h('span', { class: 'kicker', style: locLabel }, l)),
      s.totals.map((t) => [
        nameBlock(t),
        locs.map((l) => h('div', { class: 'num', style: big, 'aria-label': `${t.plural} at ${l}` }, fmtNum(t.byLocation[l] ?? 0))),
      ]),
      h('div', { style: { ...muted, paddingLeft: 46 } }, 'Unregistered'),
      locs.map((l) => h('div', { class: 'num', style: { ...muted, textAlign: 'right', fontSize: 15 } }, fmtNum(s.unregistered.find((u) => u.location === l)?.onHand ?? 0)))),
    unreg > 0 && Warn(`${fmtNum(unreg)} garments issued since the last full check were not registered (${s.unregistered.map((u) => `${u.location} ${u.sinceLastCheck}`).join(', ')}). Stock per type, size and color may be too high by up to ${fmtNum(unreg)} in total.`),
    h('div', null,
      h('h4', { class: 'sec' }, 'Reorder ', h('span', { style: { fontSize: 13, fontWeight: 400, color: 'var(--color-neutral-700)' } },
        `· ${s.belowMinCount} below minimum${s.negativeCount ? `, ${s.negativeCount} negative` : ''} · most urgent first`)),
      s.reorder.length
        ? h('table', { class: 'table num' },
          // Phones: the location goes with the item, so only two number columns remain.
          h('thead', null, h('tr', null, h('th', null, phone ? 'Item · location' : 'Garment · color · size'), !phone && h('th', null, 'Location'),
            h('th', { style: right, title: 'Stock on hand now' }, 'On hand'), h('th', { style: right, title: 'Alert when stock goes below this (Stock › Grid)' }, phone ? 'Min' : 'Minimum'))),
          h('tbody', null, s.reorder.map((r) => h('tr', null,
            h('td', null, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } }, GIcon({ name: r.icon, size: 18, color: 'var(--color-neutral-700)' }),
              phone ? `${r.garment} · ${r.color} · ${r.size} · ${r.location}` : `${r.garment} · ${r.color} · ${r.size}`)),
            !phone && h('td', null, r.location),
            h('td', { style: { ...right, fontWeight: 600, color: 'var(--color-accent-2-700)' } }, r.on_hand),
            h('td', { style: right }, r.min_qty)))))
        : h('div', { class: 'note' }, 'Nothing below its minimum.')),
    h('table', { class: 'table num' },
      h('thead', null, h('tr', null, h('th', null, 'By location'), locs.map((l) => h('th', { style: right }, l)), h('th', { style: right }, 'Total'))),
      h('tbody', null,
        s.totals.map((t) => h('tr', null, h('td', null, `${t.plural} (${t.unit})`),
          locs.map((l) => h('td', { style: right }, fmtNum(t.byLocation[l] ?? 0))), h('td', { style: { ...right, fontWeight: 600 } }, fmtNum(t.onHand)))),
        h('tr', null, h('td', { class: 'muted' }, 'Unregistered'),
          locs.map((l) => h('td', { class: 'muted', style: right }, fmtNum(s.unregistered.find((u) => u.location === l)?.onHand ?? 0))),
          h('td', { class: 'muted', style: right }, fmtNum(s.unregistered.reduce((a, u) => a + u.onHand, 0)))))),
  ];
}

function GridView({ meta, me }) {
  const [typeId, setTypeId] = state('stock.type', meta.types[0].id);
  const [locId, setLocId] = state('stock.loc', meta.locations[0].id);
  const [sel, setSel] = state('stock.sel', null);
  const grid = load(`/stock/grid?garmentTypeId=${typeId}&locationId=${locId}`, 'stock.grid');
  const firstId = grid.data?.rows.flatMap((r) => r.cells).find((c) => c.stockItemId)?.stockItemId ?? null;
  const selected = sel ?? firstId;
  const detail = selected ? load(`/stock/items/${selected}`, 'stock.detail') : { data: undefined };
  const canEdit = me.role === 'lead' || me.role === 'admin';
  const setMin = (min) => {
    if (!selected || min < 1) return;
    attempt('stock.min', async () => {
      await api(`/stock/items/${selected}/min`, { method: 'PATCH', json: { min } });
      reload(`/stock/items/${selected}`, '/stock/grid', '/stock/summary');
    });
  };
  const cols = `44px repeat(${grid.data?.colors.length ?? 4}, minmax(0, 1fr))`;
  const d = detail.data;
  const low = d && (d.status === 'below_min' || d.status === 'negative');
  const swatch = (bg, text) => h('span', { style: { display: 'flex', alignItems: 'center', gap: 5 } }, h('span', { style: { width: 10, height: 10, background: bg } }), text);
  return [
    h('div', { style: { display: 'flex', gap: 8 } },
      Seg({ label: 'Garment', style: { flex: 1 }, optStyle: { padding: '7px 2px', gap: 4, fontSize: 12.5 }, value: typeId, onChange: (v) => { setTypeId(v); setSel(null); },
        options: meta.types.map((t) => ({ value: t.id, label: t.plural, icon: t.icon })) }),
      Seg({ label: 'Location', optStyle: { flex: 'none', padding: '7px 8px' }, value: locId, onChange: (v) => { setLocId(v); setSel(null); },
        options: meta.locations.map((l) => ({ value: l.id, label: l.code })) })),
    ErrorNote(grid.error ?? errorOf('stock.min')),
    grid.data && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, role: 'grid', 'aria-label': 'Stock by size and color' },
      h('div', { style: { display: 'grid', gridTemplateColumns: cols, gap: 4, fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-neutral-700)' } },
        h('span'), grid.data.colors.map((c) => h('span', { style: { textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis' } }, c.name))),
      grid.data.rows.map((r) => h('div', { style: { display: 'grid', gridTemplateColumns: cols, gap: 4, alignItems: 'stretch' } },
        h('span', { style: { fontSize: 12, fontWeight: 600, alignSelf: 'center' } }, r.size),
        r.cells.map((c) => {
          const { bg, fg } = cellColors(c.status);
          return h('button', {
            class: 'cell', disabled: !c.stockItemId, onClick: () => setSel(c.stockItemId),
            'aria-label': `${r.size}: ${c.stockItemId ? `${c.onHand} on hand, ${statusText(c.status)}` : 'not stocked'}`,
            style: { background: bg, color: fg, outline: c.stockItemId && c.stockItemId === selected ? '2px solid var(--color-text)' : 'none' },
          }, c.stockItemId ? c.onHand : '—');
        }))),
      h('div', { style: { display: 'flex', gap: 14, fontSize: 12, color: 'var(--color-neutral-700)', marginTop: 4 } },
        swatch('var(--color-accent-2-200)', 'Below min'), swatch('var(--color-neutral-200)', 'Close to min'), swatch('var(--color-accent-100)', 'Plenty'))),
    d && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
        h('h4', { style: { margin: 0 } }, `${d.garment} · ${d.color} · ${d.size}`),
        h('span', { style: { fontSize: 13, fontWeight: 600, color: low ? 'var(--color-accent-2-700)' : 'var(--color-neutral-700)' } }, statusText(d.status))),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
        h('div', { style: { flex: 1 } }, h('div', { class: 'num', style: { fontSize: 34, lineHeight: 1, fontWeight: 600 } }, d.on_hand), h('div', { style: { fontSize: 12, color: 'var(--color-neutral-700)' } }, 'on hand')),
        h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            canEdit ? Stepper({ label: 'minimum', min: 1, size: 20, width: 36, value: d.min_qty ?? 0, onChange: setMin })
              : h('span', { class: 'num', style: { fontSize: 20, fontWeight: 600 } }, d.min_qty ?? '—')),
          h('div', { style: { fontSize: 12, color: 'var(--color-neutral-700)' } }, 'Alert below'))),
      h('div', { class: 'note' }, `${d.location} · Issued today ${d.issuedToday}`, d.lastDelivery && ` · Last delivery +${d.lastDelivery.qty} on ${fmtWhen(d.lastDelivery.at)}`)),
  ];
}
