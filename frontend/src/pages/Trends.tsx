import { useState } from 'react';
import { api, fmtDay, fmtNum } from '../api';
import { HBars, Lines, MirrorBars, SeriesKey, StackedBars } from '../components/charts';
import { ErrorNote, Segmented, useLoad } from '../components/ui';

interface Delivered { per: string; series: string[]; points: { bucket: string; values: Record<string, number>; total: number }[]; total: number }
interface Issued { series: string[]; points: { day: string; values: Record<string, number>; total: number }[]; weekdayAverage: number }
interface StockT { series: string[]; points: { day: string; values: Record<string, number | null> }[]; flows: { day: string; delivered: number; issued: number }[]; totals: { delivered: number; issued: number; net: number } }
interface Breakdown { bySize: { size: string; n: number }[]; byLocation: { location: string; n: number }[] }

const RANGES = [7, 14, 30, 90].map((d) => ({ value: d, label: `${d} days` }));

export function Trends() {
  const [days, setDays] = useState(14);
  const [per, setPer] = useState<'day' | 'week' | 'month'>('day');
  const [metric, setMetric] = useState<'issued' | 'delivered'>('issued');
  const del = useLoad(() => api<Delivered>(`/trends/delivered?days=${per === 'day' ? days : Math.max(days, per === 'week' ? 56 : 180)}&per=${per}`), [days, per]);
  const iss = useLoad(() => api<Issued>(`/trends/issued?days=${days}`), [days]);
  const stk = useLoad(() => api<StockT>(`/trends/stock?days=${days}`), [days]);
  const brk = useLoad(() => api<Breakdown>(`/trends/breakdown?days=${days}&metric=${metric}`), [days, metric]);
  const bucketLabel = (b: string) => (per === 'month' ? b : fmtDay(b));

  return (
    <div className="stack">
      <div className="spread"><h1>Trends</h1><Segmented label="Range" value={days} onChange={setDays} options={RANGES} /></div>
      <ErrorNote error={del.error ?? iss.error ?? stk.error} />
      <div className="grid-2">
        <section className="stack">
          <div className="spread"><h2>Delivered</h2><Segmented label="Per" value={per} onChange={setPer} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} /></div>
          {del.data && <>
            <p className="muted small">{fmtNum(del.data.total)} items in the range</p>
            <StackedBars label="Items delivered" series={del.data.series} points={del.data.points.map((p) => ({ key: p.bucket, label: bucketLabel(p.bucket), values: p.values }))} />
            <SeriesKey series={del.data.series} />
          </>}
        </section>
        <section className="stack">
          <h2>Issued per day</h2>
          {iss.data && <>
            <p className="muted small"><b>{fmtNum(iss.data.weekdayAverage)}</b> a weekday, on average · today (lighter bar) so far</p>
            <StackedBars label="Items issued per day" highlightLast series={iss.data.series} points={iss.data.points.map((p) => ({ key: p.day, label: fmtDay(p.day), values: p.values }))} />
            <SeriesKey series={iss.data.series} />
          </>}
        </section>
        <section className="stack">
          <h2>Stock on hand</h2>
          {stk.data && <>
            <Lines label="Stock on hand per garment" series={stk.data.series} points={stk.data.points} />
            <SeriesKey series={stk.data.series} />
            <p className="muted small">Starts at each fab's starting count. Unregistered garments are not included per type.</p>
          </>}
        </section>
        <section className="stack">
          <h2>Deliveries vs issues</h2>
          {stk.data && <>
            <p className="muted small">Delivered {fmtNum(stk.data.totals.delivered)} · Issued {fmtNum(stk.data.totals.issued)} · Net {stk.data.totals.net >= 0 ? '+' : '−'}{fmtNum(Math.abs(stk.data.totals.net))}</p>
            <MirrorBars label="Delivered above the line, issued below" flows={stk.data.flows} />
          </>}
        </section>
        <section className="stack">
          <div className="spread"><h2>Breakdown</h2><Segmented label="Metric" value={metric} onChange={setMetric} options={[{ value: 'issued', label: 'Issued' }, { value: 'delivered', label: 'Delivered' }]} /></div>
          {brk.data && <div className="grid-2">
            <div><h3>By size</h3><HBars label="By size" items={brk.data.bySize.map((b) => ({ label: b.size, n: b.n }))} /></div>
            <div><h3>By location</h3><HBars label="By location" items={brk.data.byLocation.map((b) => ({ label: b.location, n: b.n }))} /></div>
          </div>}
        </section>
      </div>
    </div>
  );
}
