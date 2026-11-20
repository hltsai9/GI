import { h, state, load } from '../dom.js';
import { fmtDay, fmtDayLong, fmtNum } from '../api.js';
import { Guide, HoverArea } from '../hover.js';
import { ErrorNote, PageHead, Seg } from '../ui.js';

// Line colors from the mockup: gowns cyan, hoods magenta, boots ink.
const LINE = { Gown: 'var(--color-accent)', Hood: 'var(--color-accent-2)', Boots: 'var(--color-text)' };
const PLURAL = { Gown: 'Gowns', Hood: 'Hoods', Boots: 'Boots', Unregistered: 'Unregistered' };
const TYPE_COLOR = { ...LINE, Unregistered: 'var(--color-neutral-500)' };
// The two locations in one chart: P1 solid / full color, P2 dashed or a lighter shade of the same color.
const DELIVERED = ['var(--color-accent)', 'var(--color-accent-300)'];
const ISSUED = ['var(--color-accent-2-400)', 'var(--color-accent-2-200)'];
const DASH = [null, '5 4'];
const dim = (a, k) => (a === null || a === k ? 1 : 0.35);
const sign = (n) => `${n >= 0 ? '+' : '−'}${fmtNum(Math.abs(n))}`;

export function Trends({ meta }) {
  const [view, setView] = state('trends.view', 'time');
  const [days, setDays] = state('trends.days', 14);
  return [
    PageHead({ kicker: view === 'time' ? `Trends · ${meta.locations.map((l) => l.code).join(' + ')}` : `Trends · last ${days} days`, title: view === 'time' ? 'Over time' : 'Breakdown' }),
    h('div', { class: 'p-seg' },
      Seg({ label: 'Trends view', value: view, onChange: setView, options: [{ value: 'time', label: 'Over time' }, { value: 'breakdown', label: 'Breakdown' }] })),
    h('div', { class: 'p-body' },
      Seg({ label: 'Range', value: days, onChange: setDays, options: [7, 14, 30, 90].map((d) => ({ value: d, label: `${d} days` })) }),
      view === 'time' ? OverTime(days) : BreakdownView(days, meta)),
  ];
}

const Axis = (start, end = 'Today') => h('div', { class: 'axis' }, h('span', null, start ? fmtDay(start) : ''), h('span', null, end));

/** Legend for the locations: a solid and a light swatch (bars) or a solid and a dashed line (lines). */
const LocKey = (locs, colors, line = false) => h('div', { style: { display: 'flex', gap: 14, fontSize: 13, color: 'var(--color-neutral-700)', flexWrap: 'wrap' } },
  locs.map((l, i) => h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
    line
      ? h('svg', { width: 22, height: 8, viewBox: '0 0 22 8', 'aria-hidden': 'true' },
        h('line', { x1: 0, y1: 4, x2: 22, y2: 4, stroke: 'var(--color-text)', 'stroke-width': 2, 'stroke-dasharray': DASH[i] ?? null }))
      : h('span', { style: { width: 12, height: 12, borderRadius: 2, background: colors[i] } }),
    l)));

/** Bars for several locations side by side within each slot (day, week, month). */
const GroupBars = (points, locs, get, colors, max, active) => h('div', { style: { display: 'flex', gap: 4, height: '100%', alignItems: 'flex-end' } },
  points.map((p, k) => h('div', { style: { flex: 1, display: 'flex', gap: 1, height: '100%', alignItems: 'flex-end', opacity: dim(active, k) } },
    locs.map((l, i) => h('div', { style: { flex: 1, height: `${(get(p, l) / max) * 100}%`, background: colors[i] } })))));

function OverTime(days) {
  // Paths must match backend/gi/cli/export_demo.py.
  const stk = load(`/trends/stock?days=${days}`, 'trends.stock');
  const s = stk.data;
  const locs = s?.locations ?? [];
  const at = (p, l, k) => p.byLocation?.[l]?.[k];
  let mx = 1;
  s?.points.forEach((p) => locs.forEach((l) => s.series.forEach((k) => { mx = Math.max(mx, at(p, l, k) ?? 0); })));
  mx *= 1.08;
  const xOf = (j) => (j / Math.max(1, (s?.points.length ?? 1) - 1));
  const yOf = (v) => 130 - (Math.max(0, v) / mx) * 125;
  const path = (k, l) => {
    let d = '';
    s.points.forEach((p, j) => {
      const v = at(p, l, k);
      if (v === null || v === undefined) return;
      const prev = j > 0 ? at(s.points[j - 1], l, k) : null;
      d += `${d && prev !== null && prev !== undefined ? 'L' : 'M'}${(xOf(j) * 320).toFixed(1)} ${yOf(v).toFixed(1)}`;
    });
    return d;
  };
  // A dot on every point (HTML, so it stays round when the chart stretches); P2 dots are hollow.
  const dot = (k, li, j, size) => {
    const v = at(s.points[j], locs[li], k);
    if (v === null || v === undefined) return null;
    return h('span', { style: { position: 'absolute', width: size, height: size, borderRadius: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none',
      background: li === 0 ? LINE[k] : 'var(--color-bg)', border: `2px solid ${li === 0 ? 'var(--color-bg)' : LINE[k]}`, boxSizing: 'border-box',
      left: `${xOf(j) * 100}%`, top: `${(yOf(v) / 140) * 100}%` } });
  };
  const flowMax = Math.max(1, ...(s?.flows.flatMap((f) => locs.flatMap((l) => [f.byLocation[l].delivered, f.byLocation[l].issued])) ?? [1]));
  const last = s?.points[s.points.length - 1];
  return [
    ErrorNote(stk.error),
    s && h('div', null,
      h('h4', { class: 'sec' }, 'Stock on hand'),
      // Legend as a small table: garment | today's stock per location (with that location's line style).
      h('div', { style: { display: 'grid', gridTemplateColumns: `auto repeat(${locs.length}, auto) 1fr`, columnGap: 18, rowGap: 2, fontSize: 13, marginBottom: 8, alignItems: 'center' } },
        h('span'), locs.map((l, i) => h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-neutral-700)' } },
          h('svg', { width: 22, height: 8, viewBox: '0 0 22 8', 'aria-hidden': 'true' },
            h('line', { x1: 0, y1: 4, x2: 22, y2: 4, stroke: 'var(--color-text)', 'stroke-width': 2, 'stroke-dasharray': DASH[i] ?? null })), l)), h('span'),
        s.series.map((k) => [
          h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, h('span', { style: { width: 14, height: 3, background: LINE[k] ?? 'var(--color-neutral-600)' } }), PLURAL[k] ?? k),
          locs.map((l) => h('b', { class: 'num', style: { textAlign: 'right' } }, fmtNum(at(last, l, k) ?? 0))), h('span'),
        ])),
      // Mockup proportions (320 × 140) at phone width; fixed height and 2 px lines on wider screens.
      HoverArea({
        id: 'stock', label: 'Stock on hand per garment and location', mode: 'line', count: s.points.length, height: 'clamp(150px, 42vw, 200px)',
        title: (j) => fmtDayLong(s.points[j].day),
        rows: (j) => s.series.flatMap((k) => locs.map((l, i) => ({ label: `${PLURAL[k] ?? k} ${l}`, color: LINE[k], hollow: i > 0, value: at(s.points[j], l, k) === null ? '—' : fmtNum(at(s.points[j], l, k) ?? 0) }))),
        body: (a) => [
          h('svg', { viewBox: '0 0 320 140', preserveAspectRatio: 'none', style: { width: '100%', height: '100%', display: 'block', overflow: 'visible' } },
            h('line', { x1: 0, y1: 130, x2: 320, y2: 130, stroke: 'var(--color-neutral-300)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
            s.series.flatMap((k) => locs.map((l, i) => h('path', { d: path(k, l), fill: 'none', stroke: LINE[k] ?? 'var(--color-neutral-600)', 'stroke-width': 2,
              'stroke-dasharray': DASH[i] ?? null, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' })))),
          s.points.length <= 31 && s.series.flatMap((k) => locs.flatMap((_, i) => s.points.map((__, j) => (a === j ? null : dot(k, i, j, 7))))),
          a !== null && [Guide(xOf(a) * 100), s.series.flatMap((k) => locs.map((_, i) => dot(k, i, a, 11)))],
        ],
      }),
      Axis(s.points[0]?.day),
      h('div', { class: 'note', style: { marginTop: 6 } }, "Each location starts at its starting count. Unregistered garments are not counted per type.")),
    s && h('div', null,
      h('h4', { style: { margin: '0 0 2px' } }, 'Deliveries vs issues'),
      h('div', { style: { fontSize: 13, color: 'var(--color-neutral-700)', marginBottom: 6 } },
        'Delivered ', h('b', { style: { color: 'var(--color-accent-700)' } }, fmtNum(s.totals.delivered)),
        ' · Issued ', h('b', { style: { color: 'var(--color-accent-2-700)' } }, fmtNum(s.totals.issued)),
        ' · Net ', h('b', { style: { color: 'var(--color-text)' } }, sign(s.totals.net))),
      h('div', { style: { marginBottom: 8 } }, LocKey(locs, DELIVERED)),
      HoverArea({
        id: 'flows', label: 'Delivered above the line, issued below, per location', count: s.flows.length, height: 120,
        title: (k) => fmtDayLong(s.flows[k].day),
        rows: (k) => [
          ...locs.map((l, i) => ({ label: `Delivered ${l}`, color: DELIVERED[i], value: fmtNum(s.flows[k].byLocation[l].delivered) })),
          ...locs.map((l, i) => ({ label: `Issued ${l}`, color: ISSUED[i], value: fmtNum(s.flows[k].byLocation[l].issued) })),
          { label: 'Net', value: sign(s.flows[k].delivered - s.flows[k].issued) },
        ],
        body: (a) => h('div', { style: { display: 'flex', gap: 3, height: '100%', alignItems: 'stretch' } },
          s.flows.map((f, k) => h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', opacity: dim(a, k) } },
            h('div', { style: { flex: 1, display: 'flex', gap: 1, alignItems: 'flex-end' } },
              locs.map((l, i) => h('div', { style: { flex: 1, height: `${(f.byLocation[l].delivered / flowMax) * 100}%`, background: DELIVERED[i] } }))),
            h('div', { style: { height: 1, background: 'var(--color-text)' } }),
            h('div', { style: { flex: 1, display: 'flex', gap: 1, alignItems: 'flex-start' } },
              locs.map((l, i) => h('div', { style: { flex: 1, height: `${(f.byLocation[l].issued / flowMax) * 100}%`, background: ISSUED[i] } })))))),
      }),
      Axis(s.flows[0]?.day)),
  ];
}

function BreakdownView(days, meta) {
  const [metric, setMetric] = state('trends.metric', 'delivered'); // delivered first, as on the rest of the page
  // Same range as Issued per day (the days switch at the top). Paths must match backend/gi/cli/export_demo.py.
  const del = load(`/trends/delivered?days=${days}&per=day`, 'trends.delivered');
  const dl = del.data;
  const dlocs = dl?.locations ?? [];
  const dm = Math.max(1, ...(dl?.points.flatMap((p) => dlocs.map((l) => p.byLocation[l])) ?? [1]));
  const iss = load(`/trends/issued?days=${days}`, 'trends.issued');
  const brk = load(`/trends/breakdown?days=${days}&metric=${metric}`, 'trends.breakdown');
  const i = iss.data;
  const b = brk.data;
  const ilocs = i?.locations ?? [];
  const dmx = Math.max(1, ...(i?.points.flatMap((p) => ilocs.map((l) => p.byLocation[l])) ?? [1]));
  const unreg = i ? i.points.reduce((s, p) => s + (p.values.Unregistered ?? 0), 0) : 0;
  const blocs = b?.locations ?? meta.locations.map((l) => l.code);
  const svm = Math.max(1, ...(b?.bySize.map((x) => x.n) ?? [1]));
  const [codeA, codeB] = meta.locations.map((l) => l.code);
  const locA = b?.byLocation.find((l) => l.location === codeA)?.n ?? 0;
  const locB = b?.byLocation.find((l) => l.location === codeB)?.n ?? 0;
  const colors = metric === 'issued' ? ISSUED : DELIVERED;
  return [
    ErrorNote(del.error ?? iss.error ?? brk.error),
    dl && h('div', null,
      h('h4', { class: 'sec' }, 'Delivered per day'),
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 } },
        h('span', { class: 'num', style: { fontSize: 34, fontWeight: 600, lineHeight: 1 } }, fmtNum(dl.total)),
        h('span', { style: { fontSize: 13, color: 'var(--color-neutral-700)' } }, `delivered in the range (both locations)`)),
      h('div', { style: { marginBottom: 8 } }, LocKey(dlocs, DELIVERED)),
      HoverArea({
        id: 'delivered', label: 'Items delivered per day, per location', count: dl.points.length, height: 110,
        title: (k) => `${fmtDayLong(dl.points[k].bucket)}${k === dl.points.length - 1 ? ' (so far)' : ''}`,
        rows: (k) => [
          ...dlocs.map((l, j) => ({ label: `Delivered ${l}`, color: DELIVERED[j], value: fmtNum(dl.points[k].byLocation[l]) })),
          ...dl.series.map((n) => ({ label: PLURAL[n] ?? n, color: TYPE_COLOR[n], value: fmtNum(dl.points[k].values[n] ?? 0), strong: false })),
          { label: 'Total delivered', value: fmtNum(dl.points[k].total) },
        ],
        body: (a) => GroupBars(dl.points, dlocs, (p, l) => p.byLocation[l], DELIVERED, dm, a),
      }),
      Axis(dl.points[0]?.bucket, 'Today (so far)')),
    i && h('div', null,
      h('h4', { class: 'sec' }, 'Issued per day'),
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 } },
        h('span', { class: 'num', style: { fontSize: 34, fontWeight: 600, lineHeight: 1 } }, fmtNum(i.weekdayAverage)),
        h('span', { style: { fontSize: 13, color: 'var(--color-neutral-700)' } }, 'a weekday, on average (both locations)')),
      h('div', { style: { marginBottom: 8 } }, LocKey(ilocs, ISSUED)),
      HoverArea({
        id: 'issued', label: 'Items issued per day, per location', count: i.points.length, height: 110,
        title: (k) => `${fmtDayLong(i.points[k].day)}${k === i.points.length - 1 ? ' (so far)' : ''}`,
        rows: (k) => [
          ...ilocs.map((l, j) => ({ label: `Issued ${l}`, color: ISSUED[j], value: fmtNum(i.points[k].byLocation[l]) })),
          ...i.series.filter((n) => (i.points[k].values[n] ?? 0) > 0 || n !== 'Unregistered')
            .map((n) => ({ label: PLURAL[n] ?? n, color: TYPE_COLOR[n], value: ilocs.map((l) => fmtNum(i.points[k].byLocationValues[l][n] ?? 0)).join(' / '), strong: false })),
          { label: 'Total issued', value: fmtNum(i.points[k].total) },
        ],
        body: (a) => GroupBars(i.points, ilocs, (p, l) => p.byLocation[l], ISSUED, dmx, a),
      }),
      Axis(i.points[0]?.day, 'Today (so far)'),
      h('div', { class: 'note', style: { marginTop: 6 } }, `Per garment type the read-out shows ${ilocs.join(' / ')}.`,
        unreg > 0 ? ` Includes ${fmtNum(unreg)} unregistered garments (type, size and color unknown).` : '')),
    Seg({ label: 'Metric', value: metric, onChange: setMetric, options: [{ value: 'delivered', label: `Delivered, ${days} days` }, { value: 'issued', label: `Issued, ${days} days` }] }),
    b && [
      h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 8 } },
          h('h4', { style: { margin: 0 } }, 'By size'), LocKey(blocs, colors)),
        b.bySize.map((x) => h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(64px, auto) 1fr auto', gap: 8, alignItems: 'center', padding: '3px 0', fontSize: 13 } },
          h('span', { style: { fontWeight: 600 } }, x.size),
          h('span', { style: { height: 12, display: 'flex' } }, blocs.map((l, j) => h('span', { style: { display: 'block', height: '100%', width: `${((x.byLocation[l] ?? 0) / svm) * 100}%`, background: colors[j] } }))),
          h('span', { class: 'num', style: { textAlign: 'right', whiteSpace: 'nowrap' } }, blocs.map((l, j) => [j ? ' · ' : '', h('span', { style: { color: 'var(--color-neutral-700)' } }, `${l} `), fmtNum(x.byLocation[l] ?? 0)]))))),
      h('div', null,
        h('h4', { style: { margin: '0 0 8px' } }, 'By location'),
        h('div', { style: { display: 'flex', height: 28, gap: 2 } },
          h('div', { style: { width: `${(locA / Math.max(1, locA + locB)) * 100}%`, background: colors[0] } }),
          h('div', { style: { flex: 1, background: colors[1] } })),
        h('div', { class: 'num', style: { display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 6 } },
          h('span', null, h('b', null, codeA), ` ${fmtNum(locA)}`), h('span', null, h('b', null, codeB), ` ${fmtNum(locB)}`))),
    ],
  ];
}
