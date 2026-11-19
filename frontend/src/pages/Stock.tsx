import { useState } from 'react';
import { api, fmtClock, fmtNum, fmtWhen, type Me, type Meta } from '../api';
import { cellColors, ErrorNote, GIcon, PageHead, Seg, Stepper, statusText, useLoad, Warn } from '../components/ui';

interface Summary {
  totals: { garmentTypeId: number; name: string; plural: string; icon: string; onHand: number; byLocation: Record<string, number>; daysOfCover: number | null; deliveredToday: number; issuedToday: number }[];
  unregistered: { location: string; onHand: number; sinceLastCheck: number }[];
  reorder: { id: number; garment: string; icon: string; color: string; size: string; location: string; on_hand: number; min_qty: number; status: string }[];
  belowMinCount: number;
  negativeCount: number;
  asOf: string;
  sync: { issuesUpTo: string | null; stale: boolean };
}

export function Stock({ meta, me }: { meta: Meta; me: Me }) {
  const [view, setView] = useState<'summary' | 'grid'>('summary');
  const [typeId, setTypeId] = useState(meta.types[0].id);
  const [locId, setLocId] = useState(meta.locations[0].id);
  const summary = useLoad(() => api<Summary>('/stock/summary'), []);
  const t = meta.types.find((x) => x.id === typeId)!;
  const head = view === 'summary'
    ? { kicker: `Stock · Fab1 + Fab2 · as of ${summary.data ? fmtClock(summary.data.asOf) : ''}`, title: 'On hand' }
    : { kicker: 'Stock · grid', title: `${t.plural} · ${meta.locations.find((l) => l.id === locId)?.code}` };
  return (
    <>
      <PageHead {...head} />
      <div className="p-body">
        <Seg label="Stock view" value={view} onChange={setView} options={[{ value: 'summary', label: 'Summary' }, { value: 'grid', label: 'Grid' }]} />
        <ErrorNote error={summary.error} />
        {view === 'summary'
          ? summary.data && <SummaryView s={summary.data} />
          : <GridView meta={meta} me={me} typeId={typeId} setTypeId={setTypeId} locId={locId} setLocId={setLocId} onChange={summary.reload} />}
      </div>
    </>
  );
}

function SummaryView({ s }: { s: Summary }) {
  const unreg = s.unregistered.reduce((a, u) => a + u.sinceLastCheck, 0);
  return (
    <>
      {s.sync.stale && <Warn>The issue import has not run for a while, so stock may be too high.</Warn>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {s.totals.map((t) => (
          <div key={t.garmentTypeId} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <GIcon name={t.icon} size={34} color="var(--color-accent-700)" />
            <div className="num" style={{ fontSize: 52, lineHeight: 1, fontWeight: 600, letterSpacing: '-.02em', minWidth: 118 }}>{fmtNum(t.onHand)}</div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{t.plural}</div>
              <div style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>
                {t.daysOfCover !== null ? `About ${t.daysOfCover} days at the usual rate` : 'No recent issues'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>Today +{fmtNum(t.deliveredToday)} in · −{fmtNum(t.issuedToday)} out</div>
            </div>
          </div>
        ))}
      </div>
      {unreg > 0 && (
        <Warn>{fmtNum(unreg)} garments issued since the last full check were not registered ({s.unregistered.map((u) => `${u.location} ${u.sinceLastCheck}`).join(', ')}). Stock per type, size and color may be too high by up to {fmtNum(unreg)} in total.</Warn>
      )}
      <div>
        <h4 className="sec">Reorder <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--color-neutral-700)' }}>· {s.belowMinCount} below minimum{s.negativeCount ? `, ${s.negativeCount} negative` : ''}</span></h4>
        {s.reorder.map((r) => (
          <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 14 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><GIcon name={r.icon} size={18} color="var(--color-neutral-700)" />{r.garment} · {r.color} · {r.size} · {r.location}</span>
            <span className="num"><b style={{ color: 'var(--color-accent-2-700)' }}>{r.on_hand}</b> <span style={{ color: 'var(--color-neutral-700)' }}>/ {r.min_qty}</span></span>
          </div>
        ))}
        {!s.reorder.length && <div className="note">Nothing below its minimum.</div>}
      </div>
      <table className="table num">
        <thead><tr><th>By location</th><th style={{ textAlign: 'right' }}>Fab1</th><th style={{ textAlign: 'right' }}>Fab2</th></tr></thead>
        <tbody>
          {s.totals.map((t) => <tr key={t.garmentTypeId}><td>{t.plural}</td><td style={{ textAlign: 'right' }}>{fmtNum(t.byLocation.Fab1 ?? 0)}</td><td style={{ textAlign: 'right' }}>{fmtNum(t.byLocation.Fab2 ?? 0)}</td></tr>)}
          <tr><td className="muted">Unregistered</td>{['Fab1', 'Fab2'].map((l) => <td key={l} className="muted" style={{ textAlign: 'right' }}>{s.unregistered.find((u) => u.location === l)?.onHand ?? 0}</td>)}</tr>
        </tbody>
      </table>
    </>
  );
}

interface Grid { colors: { id: number; name: string }[]; rows: { size: string; cells: { stockItemId: number | null; colorId: number; onHand: number; min: number | null; status: string }[] }[] }
interface Detail { id: number; garment: string; color: string; size: string; location: string; on_hand: number; min_qty: number | null; status: string; issuedToday: number; lastDelivery: { at: string; qty: number } | null }

function GridView({ meta, me, typeId, setTypeId, locId, setLocId, onChange }: {
  meta: Meta; me: Me; typeId: number; setTypeId: (v: number) => void; locId: number; setLocId: (v: number) => void; onChange: () => void;
}) {
  const [sel, setSel] = useState<number | null>(null);
  const grid = useLoad(() => api<Grid>(`/stock/grid?garmentTypeId=${typeId}&locationId=${locId}`), [typeId, locId]);
  const firstId = grid.data?.rows.flatMap((r) => r.cells).find((c) => c.stockItemId)?.stockItemId ?? null;
  const selected = sel ?? firstId;
  const detail = useLoad(() => (selected ? api<Detail>(`/stock/items/${selected}`) : Promise.resolve(undefined)), [selected]);
  const canEdit = me.role === 'lead' || me.role === 'admin';
  const setMin = async (min: number) => {
    if (!selected || min < 1) return;
    await api(`/stock/items/${selected}/min`, { method: 'PATCH', json: { min } });
    detail.reload();
    grid.reload();
    onChange();
  };
  const cols = `44px repeat(${grid.data?.colors.length ?? 4}, minmax(0, 1fr))`;
  const d = detail.data;
  const low = d && (d.status === 'below_min' || d.status === 'negative');
  return (
    <>
      <div style={{ display: 'flex', gap: 8 }}>
        <Seg label="Garment" style={{ flex: 1 }} optStyle={{ padding: '7px 2px', gap: 4, fontSize: 12.5 }} value={typeId} onChange={(v) => { setTypeId(v); setSel(null); }}
          options={meta.types.map((t) => ({ value: t.id, label: t.plural, icon: t.icon }))} />
        <Seg label="Location" optStyle={{ flex: 'none', padding: '7px 8px' }} value={locId} onChange={(v) => { setLocId(v); setSel(null); }}
          options={meta.locations.map((l) => ({ value: l.id, label: l.code }))} />
      </div>
      <ErrorNote error={grid.error} />
      {grid.data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} role="grid" aria-label="Stock by size and color">
          <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 4, fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-neutral-700)' }}>
            <span />{grid.data.colors.map((c) => <span key={c.id} style={{ textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>)}
          </div>
          {grid.data.rows.map((r) => (
            <div key={r.size} style={{ display: 'grid', gridTemplateColumns: cols, gap: 4, alignItems: 'stretch' }}>
              <span style={{ fontSize: 12, fontWeight: 600, alignSelf: 'center' }}>{r.size}</span>
              {r.cells.map((c) => {
                const { bg, fg } = cellColors(c.status);
                return (
                  <button key={c.colorId} className="cell" disabled={!c.stockItemId} onClick={() => setSel(c.stockItemId)}
                    aria-label={`${r.size}: ${c.stockItemId ? `${c.onHand} on hand, ${statusText(c.status)}` : 'not stocked'}`}
                    style={{ background: bg, color: fg, outline: c.stockItemId && c.stockItemId === selected ? '2px solid var(--color-text)' : 'none' }}>
                    {c.stockItemId ? c.onHand : '—'}
                  </button>
                );
              })}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--color-neutral-700)', marginTop: 4 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, background: 'var(--color-accent-2-200)' }} />Below min</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, background: 'var(--color-neutral-200)' }} />Close to min</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, background: 'var(--color-accent-100)' }} />Plenty</span>
          </div>
        </div>
      )}
      {d && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h4 style={{ margin: 0 }}>{d.garment} · {d.color} · {d.size}</h4>
            <span style={{ fontSize: 13, fontWeight: 600, color: low ? 'var(--color-accent-2-700)' : 'var(--color-neutral-700)' }}>{statusText(d.status)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}><div className="num" style={{ fontSize: 34, lineHeight: 1, fontWeight: 600 }}>{d.on_hand}</div><div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>on hand</div></div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {canEdit ? <Stepper label="minimum" min={1} size={20} width={36} value={d.min_qty ?? 0} onChange={setMin} /> : <span className="num" style={{ fontSize: 20, fontWeight: 600 }}>{d.min_qty ?? '—'}</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>Alert below</div>
            </div>
          </div>
          <div className="note">
            {d.location} · Issued today {d.issuedToday}{d.lastDelivery && <> · Last delivery +{d.lastDelivery.qty} on {fmtWhen(d.lastDelivery.at)}</>}
          </div>
        </div>
      )}
    </>
  );
}
