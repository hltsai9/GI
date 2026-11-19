import { useState } from 'react';
import { api, fmtDay, fmtNum } from '../api';
import { ErrorNote, PageHead, Seg, useLoad } from '../components/ui';

interface Delivered { per: string; points: { bucket: string; total: number }[]; total: number }
interface Issued { series: string[]; points: { day: string; values: Record<string, number>; total: number }[]; weekdayAverage: number }
interface StockT { series: string[]; points: { day: string; values: Record<string, number | null> }[]; flows: { day: string; delivered: number; issued: number }[]; totals: { delivered: number; issued: number; net: number } }
interface Breakdown { bySize: { size: string; n: number }[]; byLocation: { location: string; n: number }[] }

// Line colors from the mockup: gowns cyan, hoods magenta, boots ink.
const LINE: Record<string, string> = { Gown: 'var(--color-accent)', Hood: 'var(--color-accent-2)', Boots: 'var(--color-text)' };
const PLURAL: Record<string, string> = { Gown: 'Gowns', Hood: 'Hoods', Boots: 'Boots' };

export function Trends() {
  const [view, setView] = useState<'time' | 'breakdown'>('time');
  const [days, setDays] = useState(14);
  return (
    <>
      <PageHead kicker={view === 'time' ? 'Trends · Fab1 + Fab2' : `Trends · last ${days} days`} title={view === 'time' ? 'Over time' : 'Breakdown'} />
      <div className="p-body">
        <Seg label="Trends view" value={view} onChange={setView} options={[{ value: 'time', label: 'Over time' }, { value: 'breakdown', label: 'Breakdown' }]} />
        <Seg label="Range" value={days} onChange={setDays} options={[7, 14, 30, 90].map((d) => ({ value: d, label: `${d} days` }))} />
        {view === 'time' ? <OverTime days={days} /> : <BreakdownView days={days} />}
      </div>
    </>
  );
}

function Axis({ start, end = 'Today' }: { start?: string; end?: string }) {
  return <div className="axis"><span>{start ? fmtDay(start) : ''}</span><span>{end}</span></div>;
}

function OverTime({ days }: { days: number }) {
  const [per, setPer] = useState<'day' | 'week' | 'month'>('day');
  const stk = useLoad(() => api<StockT>(`/trends/stock?days=${days}`), [days]);
  const del = useLoad(() => api<Delivered>(`/trends/delivered?days=${per === 'day' ? days : Math.max(days, per === 'week' ? 56 : 180)}&per=${per}`), [days, per]);
  const s = stk.data;
  let mx = 1;
  s?.points.forEach((p) => s.series.forEach((k) => { mx = Math.max(mx, p.values[k] ?? 0); }));
  mx *= 1.08;
  const path = (k: string) => {
    if (!s) return '';
    let d = '';
    s.points.forEach((p, j) => {
      const v = p.values[k];
      if (v === null || v === undefined) return;
      const prev = j > 0 ? s.points[j - 1].values[k] : null;
      d += `${d && prev !== null && prev !== undefined ? 'L' : 'M'}${((j / Math.max(1, s.points.length - 1)) * 320).toFixed(1)} ${(130 - (Math.max(0, v) / mx) * 125).toFixed(1)}`;
    });
    return d;
  };
  const bm = Math.max(1, ...(s?.flows.flatMap((f) => [f.delivered, f.issued]) ?? [1]));
  const dm = Math.max(1, ...(del.data?.points.map((p) => p.total) ?? [1]));
  return (
    <>
      <ErrorNote error={stk.error ?? del.error} />
      {s && (
        <div>
          <h4 className="sec">Stock on hand</h4>
          <div style={{ display: 'flex', gap: 16, fontSize: 13, marginBottom: 8, flexWrap: 'wrap' }}>
            {s.series.map((k) => (
              <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 14, height: 3, background: LINE[k] ?? 'var(--color-neutral-600)' }} />{PLURAL[k] ?? k} <b className="num">{fmtNum(s.points.at(-1)?.values[k] ?? 0)}</b>
              </span>
            ))}
          </div>
          {/* Mockup proportions (320 × 140) at phone width; fixed height and 2 px lines on wider screens. */}
          <svg viewBox="0 0 320 140" preserveAspectRatio="none" style={{ width: '100%', height: 'clamp(140px, 40vw, 180px)', display: 'block', overflow: 'visible' }} role="img" aria-label="Stock on hand per garment">
            <line x1="0" y1="130" x2="320" y2="130" stroke="var(--color-neutral-300)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {s.series.map((k) => <path key={k} d={path(k)} fill="none" stroke={LINE[k] ?? 'var(--color-neutral-600)'} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />)}
          </svg>
          <Axis start={s.points[0]?.day} />
          <div className="note" style={{ marginTop: 6 }}>Starts at each fab's starting count. Unregistered garments are not counted per type.</div>
        </div>
      )}
      {s && (
        <div>
          <h4 style={{ margin: '0 0 2px' }}>Deliveries vs issues</h4>
          <div style={{ fontSize: 13, color: 'var(--color-neutral-700)', marginBottom: 10 }}>
            Delivered <b style={{ color: 'var(--color-accent-700)' }}>{fmtNum(s.totals.delivered)}</b> · Issued <b style={{ color: 'var(--color-accent-2-700)' }}>{fmtNum(s.totals.issued)}</b> · Net <b style={{ color: 'var(--color-text)' }}>{s.totals.net >= 0 ? '+' : '−'}{fmtNum(Math.abs(s.totals.net))}</b>
          </div>
          <div style={{ display: 'flex', gap: 2, height: 120, alignItems: 'stretch' }} role="img" aria-label="Delivered above the line, issued below">
            {s.flows.map((f) => (
              <div key={f.day} title={`${fmtDay(f.day)}: delivered ${f.delivered}, issued ${f.issued}`} style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end' }}><div style={{ width: '100%', height: `${(f.delivered / bm) * 100}%`, background: 'var(--color-accent)' }} /></div>
                <div style={{ height: 1, background: 'var(--color-text)' }} />
                <div style={{ flex: 1 }}><div style={{ width: '100%', height: `${(f.issued / bm) * 100}%`, background: 'var(--color-accent-2-400)' }} /></div>
              </div>
            ))}
          </div>
          <Axis start={s.flows[0]?.day} />
        </div>
      )}
      {del.data && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
            <h4 style={{ margin: 0 }}>Delivered</h4>
            <Seg label="Delivered per" value={per} onChange={setPer} optStyle={{ flex: 'none', minHeight: 32, padding: '4px 10px' }}
              options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
            <span className="num" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1 }}>{fmtNum(del.data.total)}</span>
            <span style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>items in the range, per {per}</span>
          </div>
          <div style={{ display: 'flex', gap: 4, height: 110, alignItems: 'flex-end' }} role="img" aria-label={`Items delivered per ${per}`}>
            {del.data.points.map((p) => <div key={p.bucket} title={`${p.bucket}: ${p.total}`} style={{ flex: 1, height: `${(p.total / dm) * 100}%`, background: 'var(--color-accent)' }} />)}
          </div>
          <Axis start={per === 'month' ? undefined : del.data.points[0]?.bucket} end={per === 'day' ? 'Today' : `This ${per}`} />
        </div>
      )}
    </>
  );
}

function BreakdownView({ days }: { days: number }) {
  const [metric, setMetric] = useState<'issued' | 'delivered'>('issued');
  const iss = useLoad(() => api<Issued>(`/trends/issued?days=${days}`), [days]);
  const brk = useLoad(() => api<Breakdown>(`/trends/breakdown?days=${days}&metric=${metric}`), [days, metric]);
  const i = iss.data;
  const dmx = Math.max(1, ...(i?.points.map((p) => p.total) ?? [1]));
  const unreg = i ? i.points.reduce((s, p) => s + (p.values.Unregistered ?? 0), 0) : 0;
  const svm = Math.max(1, ...(brk.data?.bySize.map((b) => b.n) ?? [1]));
  const locA = brk.data?.byLocation.find((l) => l.location === 'Fab1')?.n ?? 0;
  const locB = brk.data?.byLocation.find((l) => l.location === 'Fab2')?.n ?? 0;
  return (
    <>
      <ErrorNote error={iss.error ?? brk.error} />
      {i && (
        <div>
          <h4 className="sec">Issued per day</h4>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
            <span className="num" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1 }}>{fmtNum(i.weekdayAverage)}</span>
            <span style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>a weekday, on average</span>
          </div>
          <div style={{ display: 'flex', gap: 4, height: 110, alignItems: 'flex-end' }} role="img" aria-label="Items issued per day">
            {i.points.map((p, k) => <div key={p.day} title={`${fmtDay(p.day)}: ${p.total}`} style={{ flex: 1, height: `${(p.total / dmx) * 100}%`, background: k === i.points.length - 1 ? 'var(--color-accent-300)' : 'var(--color-accent)' }} />)}
          </div>
          <Axis start={i.points[0]?.day} end="Today (so far)" />
          {unreg > 0 && <div className="note" style={{ marginTop: 6 }}>Includes {fmtNum(unreg)} unregistered garments (type, size and color unknown).</div>}
        </div>
      )}
      <Seg label="Metric" value={metric} onChange={setMetric} options={[{ value: 'issued', label: `Issued, ${days} days` }, { value: 'delivered', label: `Delivered, ${days} days` }]} />
      {brk.data && (
        <>
          <div>
            <h4 style={{ margin: '0 0 8px' }}>By size</h4>
            {brk.data.bySize.map((b) => (
              <div key={b.size} style={{ display: 'grid', gridTemplateColumns: '84px 1fr 56px', gap: 8, alignItems: 'center', padding: '3px 0', fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>{b.size}</span>
                <span style={{ height: 12 }}><span style={{ display: 'block', height: '100%', width: `${(b.n / svm) * 100}%`, background: 'var(--color-accent)' }} /></span>
                <span className="num" style={{ textAlign: 'right' }}>{fmtNum(b.n)}</span>
              </div>
            ))}
          </div>
          <div>
            <h4 style={{ margin: '0 0 8px' }}>By location</h4>
            <div style={{ display: 'flex', height: 28, gap: 2 }}>
              <div style={{ width: `${(locA / Math.max(1, locA + locB)) * 100}%`, background: 'var(--color-accent)' }} />
              <div style={{ flex: 1, background: 'var(--color-accent-300)' }} />
            </div>
            <div className="num" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 6 }}><span><b>Fab1</b> {fmtNum(locA)}</span><span><b>Fab2</b> {fmtNum(locB)}</span></div>
          </div>
        </>
      )}
    </>
  );
}
