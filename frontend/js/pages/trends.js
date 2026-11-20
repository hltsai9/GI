import { h, state, load } from '../dom.js';
import { fmtDay, fmtDayLong, fmtNum } from '../api.js';
import { Guide, HoverArea } from '../hover.js';
import { ErrorNote, PageHead, Seg } from '../ui.js';

// Line colors from the mockup: gowns cyan, hoods magenta, boots ink.
const LINE = { Gown: 'var(--color-accent)', Hood: 'var(--color-accent-2)', Boots: 'var(--color-text)' };
const PLURAL = { Gown: 'Gowns', Hood: 'Hoods', Boots: 'Boots', Unregistered: 'Unregistered' };
const TYPE_COLOR = { ...LINE, Unregistered: 'var(--color-neutral-500)' };
const sign = (n) => `${n >= 0 ? '+' : '−'}${fmtNum(Math.abs(n))}`;

function bucketTitle(bucket, per) {
  if (per === 'day') return fmtDayLong(bucket);
  if (per === 'week') return `Week of ${fmtDayLong(bucket)}`;
  const [y, m] = bucket.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function Trends({ meta }) {
  const [view, setView] = state('trends.view', 'time');
  const [days, setDays] = state('trends.days', 14);
  return [
    PageHead({ kicker: view === 'time' ? `Trends · ${meta.locations.map((l) => l.code).join(' + ')}` : `Trends · last ${days} days`, title: view === 'time' ? 'Over time' : 'Breakdown' }),
    h('div', { class: 'p-body' },
      Seg({ label: 'Trends view', value: view, onChange: setView, options: [{ value: 'time', label: 'Over time' }, { value: 'breakdown', label: 'Breakdown' }] }),
      Seg({ label: 'Range', value: days, onChange: setDays, options: [7, 14, 30, 90].map((d) => ({ value: d, label: `${d} days` })) }),
      view === 'time' ? OverTime(days) : BreakdownView(days, meta)),
  ];
}

const Axis = (start, end = 'Today') => h('div', { class: 'axis' }, h('span', null, start ? fmtDay(start) : ''), h('span', null, end));

function OverTime(days) {
  const [per, setPer] = state('trends.per', 'day');
  const stk = load(`/trends/stock?days=${days}`, 'trends.stock');
  // Paths must match backend/gi/cli/export_demo.py.
  const del = load(`/trends/delivered?days=${per === 'day' ? days : Math.max(days, per === 'week' ? 56 : 180)}&per=${per}`, 'trends.delivered');
  const s = stk.data;
  let mx = 1;
  s?.points.forEach((p) => s.series.forEach((k) => { mx = Math.max(mx, p.values[k] ?? 0); }));
  mx *= 1.08;
  const xOf = (j) => (j / Math.max(1, (s?.points.length ?? 1) - 1));
  const yOf = (v) => 130 - (Math.max(0, v) / mx) * 125;
  const path = (k) => {
    let d = '';
    s.points.forEach((p, j) => {
      const v = p.values[k];
      if (v === null || v === undefined) return;
      const prev = j > 0 ? s.points[j - 1].values[k] : null;
      d += `${d && prev !== null && prev !== undefined ? 'L' : 'M'}${(xOf(j) * 320).toFixed(1)} ${yOf(v).toFixed(1)}`;
    });
    return d;
  };
  const bm = Math.max(1, ...(s?.flows.flatMap((f) => [f.delivered, f.issued]) ?? [1]));
  const dl = del.data;
  const dm = Math.max(1, ...(dl?.points.map((p) => p.total) ?? [1]));
  return [
    ErrorNote(stk.error ?? del.error),
    s && h('div', null,
      h('h4', { class: 'sec' }, 'Stock on hand'),
      h('div', { style: { display: 'flex', gap: 16, fontSize: 13, marginBottom: 8, flexWrap: 'wrap' } },
        s.series.map((k) => h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('span', { style: { width: 14, height: 3, background: LINE[k] ?? 'var(--color-neutral-600)' } }),
          `${PLURAL[k] ?? k} `, h('b', { class: 'num' }, fmtNum(s.points[s.points.length - 1]?.values[k] ?? 0))))),
      // Mockup proportions (320 × 140) at phone width; fixed height and 2 px lines on wider screens.
      HoverArea({
        id: 'stock', label: 'Stock on hand per garment', mode: 'line', count: s.points.length, height: 'clamp(140px, 40vw, 180px)',
        title: (k) => fmtDayLong(s.points[k].day),
        rows: (k) => s.series.map((name) => ({ label: PLURAL[name] ?? name, color: LINE[name], value: s.points[k].values[name] === null ? '—' : fmtNum(s.points[k].values[name] ?? 0) })),
        body: (a) => [
          h('svg', { viewBox: '0 0 320 140', preserveAspectRatio: 'none', style: { width: '100%', height: '100%', display: 'block', overflow: 'visible' } },
            h('line', { x1: 0, y1: 130, x2: 320, y2: 130, stroke: 'var(--color-neutral-300)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
            s.series.map((k) => h('path', { d: path(k), fill: 'none', stroke: LINE[k] ?? 'var(--color-neutral-600)', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }))),
          a !== null && [
            Guide(xOf(a) * 100),
            s.series.map((k) => {
              const v = s.points[a].values[k];
              if (v === null || v === undefined) return null;
              return h('span', { style: { position: 'absolute', width: 9, height: 9, borderRadius: '50%', background: LINE[k], border: '2px solid var(--color-bg)', transform: 'translate(-50%, -50%)', pointerEvents: 'none',
                left: `${xOf(a) * 100}%`, top: `${(yOf(v) / 140) * 100}%` } });
            }),
          ],
        ],
      }),
      Axis(s.points[0]?.day),
      h('div', { class: 'note', style: { marginTop: 6 } }, "Starts at each fab's starting count. Unregistered garments are not counted per type.")),
    s && h('div', null,
      h('h4', { style: { margin: '0 0 2px' } }, 'Deliveries vs issues'),
      h('div', { style: { fontSize: 13, color: 'var(--color-neutral-700)', marginBottom: 10 } },
        'Delivered ', h('b', { style: { color: 'var(--color-accent-700)' } }, fmtNum(s.totals.delivered)),
        ' · Issued ', h('b', { style: { color: 'var(--color-accent-2-700)' } }, fmtNum(s.totals.issued)),
        ' · Net ', h('b', { style: { color: 'var(--color-text)' } }, sign(s.totals.net))),
      HoverArea({
        id: 'flows', label: 'Delivered above the line, issued below', count: s.flows.length, height: 120,
        title: (k) => fmtDayLong(s.flows[k].day),
        rows: (k) => [
          { label: 'Delivered', color: 'var(--color-accent)', value: fmtNum(s.flows[k].delivered) },
          { label: 'Issued', color: 'var(--color-accent-2-400)', value: fmtNum(s.flows[k].issued) },
          { label: 'Net', value: sign(s.flows[k].delivered - s.flows[k].issued) },
        ],
        body: (a) => h('div', { style: { display: 'flex', gap: 2, height: '100%', alignItems: 'stretch' } },
          s.flows.map((f, k) => h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', opacity: a === null || a === k ? 1 : 0.35 } },
            h('div', { style: { flex: 1, display: 'flex', alignItems: 'flex-end' } }, h('div', { style: { width: '100%', height: `${(f.delivered / bm) * 100}%`, background: 'var(--color-accent)' } })),
            h('div', { style: { height: 1, background: 'var(--color-text)' } }),
            h('div', { style: { flex: 1 } }, h('div', { style: { width: '100%', height: `${(f.issued / bm) * 100}%`, background: 'var(--color-accent-2-400)' } }))))),
      }),
      Axis(s.flows[0]?.day)),
    dl && h('div', null,
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 } },
        h('h4', { style: { margin: 0 } }, 'Delivered'),
        Seg({ label: 'Delivered per', value: per, onChange: setPer, optStyle: { flex: 'none', minHeight: 32, padding: '4px 10px' },
          options: [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }] })),
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 } },
        h('span', { class: 'num', style: { fontSize: 34, fontWeight: 600, lineHeight: 1 } }, fmtNum(dl.total)),
        h('span', { style: { fontSize: 13, color: 'var(--color-neutral-700)' } }, `items in the range, per ${dl.per}`)),
      HoverArea({
        id: 'delivered', label: `Items delivered per ${dl.per}`, count: dl.points.length, height: 110,
        title: (k) => bucketTitle(dl.points[k].bucket, dl.per),
        rows: (k) => [{ label: 'Delivered', color: 'var(--color-accent)', value: `${fmtNum(dl.points[k].total)} items` }],
        body: (a) => h('div', { style: { display: 'flex', gap: 4, height: '100%', alignItems: 'flex-end' } },
          dl.points.map((p, k) => h('div', { style: { flex: 1, height: `${(p.total / dm) * 100}%`, background: a === k ? 'var(--color-accent-700)' : 'var(--color-accent)', opacity: a === null || a === k ? 1 : 0.35 } }))),
      }),
      Axis(dl.per === 'month' ? undefined : dl.points[0]?.bucket, dl.per === 'day' ? 'Today' : `This ${dl.per}`)),
  ];
}

function BreakdownView(days, meta) {
  const [metric, setMetric] = state('trends.metric', 'issued');
  const iss = load(`/trends/issued?days=${days}`, 'trends.issued');
  const brk = load(`/trends/breakdown?days=${days}&metric=${metric}`, 'trends.breakdown');
  const i = iss.data;
  const b = brk.data;
  const dmx = Math.max(1, ...(i?.points.map((p) => p.total) ?? [1]));
  const unreg = i ? i.points.reduce((s, p) => s + (p.values.Unregistered ?? 0), 0) : 0;
  const svm = Math.max(1, ...(b?.bySize.map((x) => x.n) ?? [1]));
  const [codeA, codeB] = meta.locations.map((l) => l.code);
  const locA = b?.byLocation.find((l) => l.location === codeA)?.n ?? 0;
  const locB = b?.byLocation.find((l) => l.location === codeB)?.n ?? 0;
  return [
    ErrorNote(iss.error ?? brk.error),
    i && h('div', null,
      h('h4', { class: 'sec' }, 'Issued per day'),
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 } },
        h('span', { class: 'num', style: { fontSize: 34, fontWeight: 600, lineHeight: 1 } }, fmtNum(i.weekdayAverage)),
        h('span', { style: { fontSize: 13, color: 'var(--color-neutral-700)' } }, 'a weekday, on average')),
      HoverArea({
        id: 'issued', label: 'Items issued per day', count: i.points.length, height: 110,
        title: (k) => `${fmtDayLong(i.points[k].day)}${k === i.points.length - 1 ? ' (so far)' : ''}`,
        rows: (k) => [
          ...i.series.filter((n) => (i.points[k].values[n] ?? 0) > 0 || n !== 'Unregistered')
            .map((n) => ({ label: PLURAL[n] ?? n, color: TYPE_COLOR[n], value: fmtNum(i.points[k].values[n] ?? 0), strong: false })),
          { label: 'Total issued', value: fmtNum(i.points[k].total) },
        ],
        body: (a) => h('div', { style: { display: 'flex', gap: 4, height: '100%', alignItems: 'flex-end' } },
          i.points.map((p, k) => h('div', { style: { flex: 1, height: `${(p.total / dmx) * 100}%`, opacity: a === null || a === k ? 1 : 0.35,
            background: a === k ? 'var(--color-accent-700)' : k === i.points.length - 1 ? 'var(--color-accent-300)' : 'var(--color-accent)' } }))),
      }),
      Axis(i.points[0]?.day, 'Today (so far)'),
      unreg > 0 && h('div', { class: 'note', style: { marginTop: 6 } }, `Includes ${fmtNum(unreg)} unregistered garments (type, size and color unknown).`)),
    Seg({ label: 'Metric', value: metric, onChange: setMetric, options: [{ value: 'issued', label: `Issued, ${days} days` }, { value: 'delivered', label: `Delivered, ${days} days` }] }),
    b && [
      h('div', null,
        h('h4', { style: { margin: '0 0 8px' } }, 'By size'),
        b.bySize.map((x) => h('div', { style: { display: 'grid', gridTemplateColumns: '84px 1fr 56px', gap: 8, alignItems: 'center', padding: '3px 0', fontSize: 13 } },
          h('span', { style: { fontWeight: 600 } }, x.size),
          h('span', { style: { height: 12 } }, h('span', { style: { display: 'block', height: '100%', width: `${(x.n / svm) * 100}%`, background: 'var(--color-accent)' } })),
          h('span', { class: 'num', style: { textAlign: 'right' } }, fmtNum(x.n))))),
      h('div', null,
        h('h4', { style: { margin: '0 0 8px' } }, 'By location'),
        h('div', { style: { display: 'flex', height: 28, gap: 2 } },
          h('div', { style: { width: `${(locA / Math.max(1, locA + locB)) * 100}%`, background: 'var(--color-accent)' } }),
          h('div', { style: { flex: 1, background: 'var(--color-accent-300)' } })),
        h('div', { class: 'num', style: { display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 6 } },
          h('span', null, h('b', null, codeA), ` ${fmtNum(locA)}`), h('span', null, h('b', null, codeB), ` ${fmtNum(locB)}`))),
    ],
  ];
}
