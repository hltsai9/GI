import { useState } from 'react';
import { api, fmtClock, fmtNum, fmtTime, icon, type Me, type Meta } from '../api';
import type { Device } from '../device';
import { ErrorNote, Segmented, Stepper, statusText, useLoad } from '../components/ui';

interface Summary {
  totals: { garmentTypeId: number; name: string; plural: string; icon: string; onHand: number; byLocation: Record<string, number>; daysOfCover: number | null; deliveredToday: number; issuedToday: number }[];
  unregistered: { location: string; onHand: number; sinceLastCheck: number }[];
  unregisteredToday: number;
  reorder: { id: number; garment: string; icon: string; color: string; size: string; location: string; on_hand: number; min_qty: number; status: string }[];
  belowMinCount: number;
  negativeCount: number;
  asOf: string;
  sync: { issuesUpTo: string | null; lastSuccessfulImport: string | null; stale: boolean };
}

export function Stock({ meta, me, device }: { meta: Meta; me: Me; device: Device }) {
  const [view, setView] = useState<'summary' | 'grid'>('summary');
  const summary = useLoad(() => api<Summary>('/stock/summary'), []);
  if (device === 'laptop') {
    return (
      <div className="stack">
        <Header summary={summary.data} />
        <ErrorNote error={summary.error} />
        <div className="grid-2">
          {summary.data && <SummaryView s={summary.data} />}
          <GridView meta={meta} me={me} onChange={summary.reload} />
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <Header summary={summary.data} />
      <Segmented label="Stock view" value={view} onChange={setView} options={[{ value: 'summary', label: 'Summary' }, { value: 'grid', label: 'Grid' }]} />
      <ErrorNote error={summary.error} />
      {view === 'summary' ? summary.data && <SummaryView s={summary.data} /> : <GridView meta={meta} me={me} onChange={summary.reload} />}
    </div>
  );
}

function Header({ summary }: { summary?: Summary }) {
  return (
    <div>
      <h1>Stock</h1>
      {summary && (
        <p className="muted small">
          Fab1 + Fab2 · as of {fmtClock(summary.asOf)}
          {summary.sync.issuesUpTo && <> · issues up to {fmtTime(summary.sync.issuesUpTo)}</>}
        </p>
      )}
      {summary?.sync.stale && <p className="notice warn">The issue import has not run successfully for a while — stock may be too high.</p>}
    </div>
  );
}

function SummaryView({ s }: { s: Summary }) {
  const unreg = s.unregistered.reduce((a, u) => a + u.sinceLastCheck, 0);
  return (
    <div className="stack">
      <div className="stack">
        {s.totals.map((t) => (
          <div key={t.garmentTypeId} className="total-card">
            <img src={icon(t.icon)} alt="" />
            <div className="grow">
              <div className="big">{fmtNum(t.onHand)}</div>
              <div><b>{t.plural}</b> <span className="muted small">{t.daysOfCover !== null ? `· about ${t.daysOfCover} days at the usual rate` : ''}</span></div>
              <div className="muted small">Today: +{fmtNum(t.deliveredToday)} delivered · −{fmtNum(t.issuedToday)} issued</div>
            </div>
          </div>
        ))}
      </div>
      {unreg > 0 && (
        <p className="notice warn">
          {fmtNum(unreg)} garments issued since the last full check were not registered
          ({s.unregistered.map((u) => `${u.location} ${u.sinceLastCheck}`).join(', ')}). Stock per type, size and color may be too high by up to {fmtNum(unreg)} in total.
        </p>
      )}
      <section>
        <h2>Reorder <span className="muted small">· {s.belowMinCount} below minimum{s.negativeCount ? `, ${s.negativeCount} negative` : ''}</span></h2>
        <ul className="list">
          {s.reorder.map((r) => (
            <li key={r.id}>
              <img className="garment-icon" src={icon(r.icon)} alt="" />
              <span className="grow">{r.garment} · {r.color} · {r.size} · {r.location}<br /><span className="small muted">{statusText(r.status)}</span></span>
              <span className="num"><b>{r.on_hand}</b> / {r.min_qty}</span>
            </li>
          ))}
          {!s.reorder.length && <li className="muted">Nothing below its minimum.</li>}
        </ul>
      </section>
      <section>
        <h2>By location</h2>
        <table className="tbl">
          <thead><tr><th /><th>Fab1</th><th>Fab2</th></tr></thead>
          <tbody>
            {s.totals.map((t) => <tr key={t.garmentTypeId}><td>{t.plural}</td><td>{fmtNum(t.byLocation.Fab1 ?? 0)}</td><td>{fmtNum(t.byLocation.Fab2 ?? 0)}</td></tr>)}
            <tr><td className="muted">Unregistered</td>{['Fab1', 'Fab2'].map((l) => <td key={l} className="muted">{s.unregistered.find((u) => u.location === l)?.onHand ?? 0}</td>)}</tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

interface Grid { sizes: { id: number; code: string }[]; colors: { id: number; name: string }[]; rows: { size: string; cells: { stockItemId: number | null; colorId: number; onHand: number; min: number | null; status: string }[] }[] }
interface Detail { id: number; garment: string; color: string; size: string; location: string; on_hand: number; min_qty: number | null; status: string; issuedToday: number; lastDelivery: { at: string; qty: number } | null }

function GridView({ meta, me, onChange }: { meta: Meta; me: Me; onChange: () => void }) {
  const [typeId, setTypeId] = useState(meta.types[0].id);
  const [locId, setLocId] = useState(meta.locations[0].id);
  const [sel, setSel] = useState<number | null>(null);
  const grid = useLoad(() => api<Grid>(`/stock/grid?garmentTypeId=${typeId}&locationId=${locId}`), [typeId, locId]);
  const detail = useLoad(() => (sel ? api<Detail>(`/stock/items/${sel}`) : Promise.resolve(undefined)), [sel]);
  const canEdit = me.role === 'lead' || me.role === 'admin';

  const setMin = async (min: number) => {
    if (!sel) return;
    await api(`/stock/items/${sel}/min`, { method: 'PATCH', json: { min } });
    detail.reload();
    grid.reload();
    onChange();
  };
  const cols = `52px repeat(${grid.data?.colors.length ?? 4}, minmax(0, 1fr))`;
  return (
    <div className="stack">
      <div className="row">
        <Segmented label="Garment" value={typeId} onChange={(v) => { setTypeId(v); setSel(null); }} options={meta.types.map((t) => ({ value: t.id, label: t.plural, icon: t.icon }))} />
        <Segmented label="Location" value={locId} onChange={(v) => { setLocId(v); setSel(null); }} options={meta.locations.map((l) => ({ value: l.id, label: l.code }))} />
      </div>
      <ErrorNote error={grid.error} />
      {grid.data && (
        <div className="grid-table" style={{ gridTemplateColumns: cols }} role="grid" aria-label="Stock by size and color">
          <span />
          {grid.data.colors.map((c) => <span key={c.id} className="small muted" style={{ textAlign: 'center' }}>{c.name}</span>)}
          {grid.data.rows.map((r) => (
            <div key={r.size} style={{ display: 'contents' }}>
              <span className="small" style={{ alignSelf: 'center' }}>{r.size}</span>
              {r.cells.map((c) => (
                <button key={c.colorId} className="cell" data-status={c.status} aria-pressed={c.stockItemId !== null && c.stockItemId === sel}
                  disabled={c.stockItemId === null} onClick={() => setSel(c.stockItemId)} aria-label={`${r.size}: ${c.stockItemId ? `${c.onHand} on hand, ${statusText(c.status)}` : 'not stocked'}`}>
                  {c.stockItemId === null ? '—' : c.onHand}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="legend">
        <span><i style={{ background: 'var(--color-accent-2-500)' }} />Below min / negative</span>
        <span><i style={{ background: 'var(--color-accent-2-200)' }} />Close to min</span>
        <span><i style={{ background: 'var(--color-accent-200)' }} />Plenty</span>
      </div>
      {detail.data && (
        <div className="card stack">
          <div className="spread">
            <div><b>{detail.data.garment} · {detail.data.color} · {detail.data.size}</b><br /><span className="small muted">{statusText(detail.data.status)}</span></div>
            <div className="big">{detail.data.on_hand}</div>
          </div>
          <div className="spread">
            <span>Alert below</span>
            {canEdit ? <Stepper label="minimum" min={1} value={detail.data.min_qty ?? 0} onChange={setMin} /> : <b>{detail.data.min_qty ?? '—'}</b>}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {detail.data.location} · Issued today {detail.data.issuedToday}
            {detail.data.lastDelivery && <> · Last delivery +{detail.data.lastDelivery.qty} on {fmtTime(detail.data.lastDelivery.at)}</>}
          </p>
        </div>
      )}
    </div>
  );
}
