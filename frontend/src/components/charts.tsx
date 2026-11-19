import { fmtDay } from '../api';

// Small dependency-free SVG charts. Colors come from the Broadsheet accent ramps.
export const SERIES_COLORS: Record<string, string> = {
  Gown: 'var(--color-accent-700)',
  Hood: 'var(--color-accent-400)',
  Boots: 'var(--color-accent-2-600)',
  Unregistered: 'var(--color-neutral-500)',
};
const colorOf = (s: string, i: number) => SERIES_COLORS[s] ?? ['var(--color-accent-700)', 'var(--color-accent-2-600)', 'var(--color-neutral-600)'][i % 3];

const W = 640, H = 220, PAD = { l: 40, r: 8, t: 10, b: 24 };

function ticks(max: number) {
  const step = Math.pow(10, Math.floor(Math.log10(Math.max(1, max)))) * (max / Math.pow(10, Math.floor(Math.log10(Math.max(1, max)))) > 5 ? 2 : 1);
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

export function SeriesKey({ series }: { series: string[] }) {
  return (
    <div className="series-key">
      {series.map((s, i) => <span key={s}><i style={{ background: colorOf(s, i) }} />{s}</span>)}
    </div>
  );
}

/** Stacked bars, one per point. */
export function StackedBars({ points, series, label, highlightLast }: {
  points: { key: string; label: string; values: Record<string, number> }[];
  series: string[];
  label: string;
  highlightLast?: boolean;
}) {
  const max = Math.max(1, ...points.map((p) => series.reduce((s, k) => s + (p.values[k] ?? 0), 0)));
  const yMax = ticks(max * 1.1).at(-1)! || max;
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const bw = iw / points.length;
  const every = Math.ceil(points.length / 8);
  return (
    <figure className="chart" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {ticks(yMax).map((v) => {
          const y = PAD.t + ih - (v / yMax) * ih;
          return <g key={v}><line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} /><text className="axis" x={PAD.l - 6} y={y + 4} textAnchor="end">{v}</text></g>;
        })}
        {points.map((p, i) => {
          let y = PAD.t + ih;
          const last = highlightLast && i === points.length - 1;
          return (
            <g key={p.key} opacity={last ? 0.55 : 1}>
              <title>{`${p.label}: ${series.map((s) => `${s} ${p.values[s] ?? 0}`).join(', ')}${last ? ' (so far)' : ''}`}</title>
              {series.map((s, si) => {
                const h = ((p.values[s] ?? 0) / yMax) * ih;
                y -= h;
                return <rect key={s} x={PAD.l + i * bw + bw * 0.15} y={y} width={bw * 0.7} height={Math.max(0, h)} fill={colorOf(s, si)} />;
              })}
              {i % every === 0 && <text className="axis" x={PAD.l + i * bw + bw / 2} y={H - 6} textAnchor="middle">{p.label}</text>}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/** Lines over days; null values leave a gap (e.g. before the starting count). */
export function Lines({ points, series, label }: { points: { day: string; values: Record<string, number | null> }[]; series: string[]; label: string }) {
  const vals = points.flatMap((p) => series.map((s) => p.values[s] ?? 0));
  const yMax = ticks(Math.max(1, ...vals) * 1.1).at(-1)!;
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (points.length < 2 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (Math.max(0, v) / yMax) * ih;
  const every = Math.ceil(points.length / 8);
  return (
    <figure className="chart" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {ticks(yMax).map((v) => (
          <g key={v}><line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} /><text className="axis" x={PAD.l - 6} y={y(v) + 4} textAnchor="end">{v}</text></g>
        ))}
        {series.map((s, si) => {
          let d = '';
          points.forEach((p, i) => {
            const v = p.values[s];
            if (v === null || v === undefined) return;
            d += `${d && points[i - 1]?.values[s] != null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
          });
          return <path key={s} d={d} fill="none" stroke={colorOf(s, si)} strokeWidth={2.5} strokeLinejoin="round" />;
        })}
        {points.map((p, i) => i % every === 0 && <text key={p.day} className="axis" x={x(i)} y={H - 6} textAnchor="middle">{fmtDay(p.day)}</text>)}
      </svg>
    </figure>
  );
}

/** Deliveries up, issues down, on a shared baseline (TRD-04). */
export function MirrorBars({ flows, label }: { flows: { day: string; delivered: number; issued: number }[]; label: string }) {
  const max = Math.max(1, ...flows.flatMap((f) => [f.delivered, f.issued]));
  const iw = W - PAD.l - PAD.r, mid = H / 2;
  const bw = iw / flows.length;
  const every = Math.ceil(flows.length / 8);
  return (
    <figure className="chart" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={mid} y2={mid} />
        <text className="axis" x={PAD.l - 6} y={PAD.t + 8} textAnchor="end">in</text>
        <text className="axis" x={PAD.l - 6} y={H - PAD.b} textAnchor="end">out</text>
        {flows.map((f, i) => {
          const hd = (f.delivered / max) * (mid - PAD.t), hi = (f.issued / max) * (mid - PAD.b);
          return (
            <g key={f.day}>
              <title>{`${fmtDay(f.day)}: delivered ${f.delivered}, issued ${f.issued}`}</title>
              <rect x={PAD.l + i * bw + bw * 0.15} y={mid - hd} width={bw * 0.7} height={hd} fill="var(--color-accent-600)" />
              <rect x={PAD.l + i * bw + bw * 0.15} y={mid} width={bw * 0.7} height={hi} fill="var(--color-accent-2-500)" />
              {i % every === 0 && <text className="axis" x={PAD.l + i * bw + bw / 2} y={H - 6} textAnchor="middle">{fmtDay(f.day)}</text>}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export function HBars({ items, label }: { items: { label: string; n: number }[]; label: string }) {
  const max = Math.max(1, ...items.map((i) => i.n));
  return (
    <ul className="list" aria-label={label}>
      {items.map((it) => (
        <li key={it.label}>
          <span style={{ width: 104, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
          <span className="grow"><span style={{ display: 'block', height: 14, width: `${(it.n / max) * 100}%`, background: 'var(--color-accent-500)', borderRadius: 2 }} /></span>
          <span className="num" style={{ width: 60, textAlign: 'right' }}>{it.n.toLocaleString('en-US')}</span>
        </li>
      ))}
    </ul>
  );
}
