import { useMemo, useState } from 'react';
import { api, DEMO, demoFetch, fmtNum, fmtTime, type Me, type Meta } from '../api';
import { ErrorNote, Segmented, Select, Toast, useLoad } from '../components/ui';

type View = 'values' | 'correct' | 'count' | 'oracle' | 'quality' | 'import';

export function Settings({ meta, me, reloadMeta }: { meta: Meta; me: Me; reloadMeta: () => void }) {
  const [view, setView] = useState<View>('values');
  const lead = me.role === 'lead' || me.role === 'admin';
  return (
    <div className="stack">
      <h1>Settings</h1>
      <Segmented label="Settings section" value={view} onChange={setView} options={[
        { value: 'values', label: 'Sizes & colors' }, { value: 'correct', label: 'Correct stock' }, { value: 'count', label: 'Full count' },
        { value: 'oracle', label: 'Oracle values' }, { value: 'quality', label: 'Data quality' }, { value: 'import', label: 'Import' },
      ]} />
      {!lead && view !== 'quality' && view !== 'import' && <p className="notice">Only the cleanroom lead can change these settings.</p>}
      {view === 'values' && <Values meta={meta} canEdit={lead} reloadMeta={reloadMeta} />}
      {view === 'correct' && <CorrectStock meta={meta} canEdit={lead} />}
      {view === 'count' && <FullCount meta={meta} canEdit={lead} />}
      {view === 'oracle' && <OracleValues meta={meta} canEdit={lead} />}
      {view === 'quality' && <DataQuality />}
      {view === 'import' && <ImportStatus isAdmin={me.role === 'admin'} />}
    </div>
  );
}

function Values({ meta, canEdit, reloadMeta }: { meta: Meta; canEdit: boolean; reloadMeta: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState({ size: '', color: '' });
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      reloadMeta();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const list = (kind: 'size' | 'color', items: { id: number; label: string; active: number }[]) => (
    <section className="stack">
      <h2>{kind === 'size' ? 'Sizes' : 'Colors'}</h2>
      <div className="row">
        {items.map((it) => (
          <span key={it.id} className="badge" style={{ padding: '6px 12px', opacity: it.active ? 1 : 0.5 }}>
            {it.label}{' '}
            {canEdit && <button className="small" style={{ border: 0, background: 'none', cursor: 'pointer', minHeight: 32 }} aria-label={it.active ? `hide ${it.label}` : `restore ${it.label}`}
              onClick={() => act(() => api(`/${kind}s/${it.id}/${it.active ? 'hide' : 'restore'}`, { method: 'POST' }))}>{it.active ? '×' : '↺'}</button>}
          </span>
        ))}
      </div>
      {canEdit && (
        <div className="row">
          <input className="input" style={{ maxWidth: 200 }} placeholder={`New ${kind}`} value={text[kind]} onChange={(e) => setText((t) => ({ ...t, [kind]: e.target.value }))} />
          <button className="btn" disabled={!text[kind].trim()} onClick={() => act(async () => { await api(`/${kind}s`, { method: 'POST', json: { value: text[kind] } }); setText((t) => ({ ...t, [kind]: '' })); })}>Add {kind}</button>
        </div>
      )}
    </section>
  );
  return (
    <div className="stack">
      <ErrorNote error={err} />
      <div className="grid-2">
        {list('size', meta.sizes.map((s) => ({ id: s.id, label: s.code, active: s.active })))}
        {list('color', meta.colors.map((c) => ({ id: c.id, label: c.name, active: c.active })))}
      </div>
      <p className="muted small">New sizes and colors show up straight away in Receive, Stock and stock correction. Removing one only hides it from those screens — its stock records are kept.</p>
    </div>
  );
}

interface Grid { rows: { size: string; cells: { stockItemId: number | null; colorId: number; onHand: number }[] }[]; colors: { id: number; name: string }[]; sizes: { id: number; code: string }[] }
const REASONS = [
  { value: 'spot_check', label: 'Spot check' }, { value: 'damaged', label: 'Damaged' }, { value: 'found', label: 'Found' },
  { value: 'miscount_at_delivery', label: 'Miscount at delivery' }, { value: 'other', label: 'Other' },
];

function CorrectStock({ meta, canEdit }: { meta: Meta; canEdit: boolean }) {
  const colors = meta.colors.filter((c) => c.active), sizes = meta.sizes.filter((s) => s.active);
  const [f, setF] = useState({ garmentTypeId: meta.types[0].id, colorId: colors[0].id, sizeId: sizes[0].id, locationId: meta.locations[0].id, counted: '', reason: 'spot_check', note: '' });
  const grid = useLoad(() => api<Grid>(`/stock/grid?garmentTypeId=${f.garmentTypeId}&locationId=${f.locationId}`), [f.garmentTypeId, f.locationId]);
  const log = useLoad(() => api<Record<string, string | number>[]>('/corrections'), []);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const sizeCode = sizes.find((s) => s.id === f.sizeId)?.code;
  const inSystem = grid.data?.rows.find((r) => r.size === sizeCode)?.cells.find((c) => c.colorId === f.colorId)?.onHand ?? 0;
  const counted = f.counted === '' ? null : Number(f.counted);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: ['reason', 'note', 'counted'].includes(k) ? v : Number(v), ...(k !== 'reason' && k !== 'note' && k !== 'counted' ? { counted: '' } : {}) }));
  const save = async () => {
    setErr(null);
    try {
      await api('/corrections', { method: 'POST', json: { reason: f.reason, note: f.note || undefined, locationId: f.locationId, items: [{ garmentTypeId: f.garmentTypeId, colorId: f.colorId, sizeId: f.sizeId, qty: counted }] } });
      setToast(`Saved · ${inSystem} → ${counted}`);
      setF((x) => ({ ...x, counted: '' }));
      grid.reload();
      log.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="stack">
      <p className="notice">Only for when the system count is wrong. To fix a delivery, use Receive › History instead. Every correction is logged.</p>
      <div className="form-grid">
        <Select label="Garment" value={f.garmentTypeId} onChange={set('garmentTypeId')} options={meta.types.map((t) => ({ value: t.id, label: t.name }))} />
        <Select label="Color" value={f.colorId} onChange={set('colorId')} options={colors.map((c) => ({ value: c.id, label: c.name }))} />
        <Select label="Size" value={f.sizeId} onChange={set('sizeId')} options={sizes.map((s) => ({ value: s.id, label: s.code }))} />
        <Select label="Location" value={f.locationId} onChange={set('locationId')} options={meta.locations.map((l) => ({ value: l.id, label: l.code }))} />
        <Select label="Reason" value={f.reason} onChange={set('reason')} options={REASONS} />
      </div>
      <div className="row">
        <span>In system <b className="num">{inSystem}</b></span>
        <label className="field" style={{ width: 160 }}><span>Counted on the shelf</span><input className="input num" inputMode="numeric" value={f.counted} onChange={(e) => set('counted')(e.target.value.replace(/\D/g, ''))} /></label>
        {counted !== null && <span className="small" style={{ color: 'var(--color-accent-2-700)' }}>{counted - inSystem >= 0 ? '+' : '−'}{Math.abs(counted - inSystem)}</span>}
        {f.reason === 'other' && <label className="field grow"><span>Note (required)</span><input className="input" value={f.note} onChange={(e) => set('note')(e.target.value)} /></label>}
      </div>
      <ErrorNote error={err} />
      <button className="btn primary" disabled={!canEdit || counted === null || counted === inSystem || (f.reason === 'other' && !f.note)} onClick={save}>Save correction</button>
      <section>
        <h2>Recent corrections</h2>
        <ul className="list">
          {log.data?.map((l) => (
            <li key={l.id}>
              <span className="grow">{l.is_system ? `Unregistered · ${l.location}` : `${l.garment} · ${l.color} · ${l.size} · ${l.location}`}<br /><span className="small muted">{String(l.reason).replace(/_/g, ' ')} · {fmtTime(String(l.at))} · {l.user_name}</span></span>
              <span className="num">{l.system_qty} → <b>{l.counted}</b></span>
            </li>
          ))}
        </ul>
      </section>
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

// Site time is Phoenix (UTC−7 all year, no daylight saving), so a local time converts with a fixed offset.
const phoenixToIso = (local: string) => new Date(`${local}:00-07:00`).toISOString();
const nowPhoenixLocal = () => new Date(Date.now() - 7 * 3600_000).toISOString().slice(0, 16);

/** Starting count (ADJ-05) or a full spot check that also clears the unregistered bucket (DQ-06). */
function FullCount({ meta, canEdit }: { meta: Meta; canEdit: boolean }) {
  const starts = useLoad(() => api<{ locationId: number; location: string; asOf: string | null }[]>('/starting-counts'), []);
  const [locId, setLocId] = useState(meta.locations[0].id);
  const [typeId, setTypeId] = useState(meta.types[0].id);
  const [asOf, setAsOf] = useState(nowPhoenixLocal());
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const colors = meta.colors.filter((c) => c.active), sizes = meta.sizes.filter((s) => s.active);
  const started = starts.data?.find((s) => s.locationId === locId)?.asOf;
  const entries = useMemo(() => Object.entries(counts).filter(([, v]) => v !== ''), [counts]);

  const save = async () => {
    setErr(null);
    const items = entries.map(([k, v]) => {
      const [t, c, s] = k.split('|').map(Number);
      return { garmentTypeId: t, colorId: c, sizeId: s, qty: Number(v) };
    });
    try {
      if (!started) {
        const r = await api<{ items: number; issuesApplied: number }>('/starting-counts', { method: 'POST', json: { locationId: locId, asOf: phoenixToIso(asOf), counts: items } });
        setToast(`Starting count saved · ${r.issuesApplied} issues since then applied`);
      } else {
        await api('/corrections', { method: 'POST', json: { reason: 'spot_check', locationId: locId, items, clearUnregistered: true } });
        setToast('Full spot check saved · unregistered count reset');
      }
      setCounts({});
      starts.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="stack">
      <div className="row">
        <Segmented label="Location" value={locId} onChange={setLocId} options={meta.locations.map((l) => ({ value: l.id, label: l.code }))} />
        <Segmented label="Garment" value={typeId} onChange={setTypeId} options={meta.types.map((t) => ({ value: t.id, label: t.plural, icon: t.icon }))} />
      </div>
      {started ? (
        <p className="notice">Starting count done {fmtTime(started)}. Use this screen for a <b>full spot check</b>: enter what is on the shelf for every garment type, then save — the location's unregistered count is reset to 0. Items left empty keep their current number.</p>
      ) : (
        <div className="stack">
          <p className="notice">No starting count yet for this location. Count everything, then enter the counts with the time counting <b>finished</b>. Issues scanned after that time reduce stock; items left empty count as 0.</p>
          <label className="field" style={{ maxWidth: 260 }}><span>Counting finished at (Phoenix time)</span><input className="input" type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        </div>
      )}
      <div className="grid-table" style={{ gridTemplateColumns: `52px repeat(${colors.length}, minmax(0, 1fr))` }}>
        <span />
        {colors.map((c) => <span key={c.id} className="small muted" style={{ textAlign: 'center' }}>{c.name}</span>)}
        {sizes.map((s) => (
          <div key={s.id} style={{ display: 'contents' }}>
            <span className="small" style={{ alignSelf: 'center' }}>{s.code}</span>
            {colors.map((c) => {
              const k = `${typeId}|${c.id}|${s.id}`;
              return <input key={k} className="input num" style={{ textAlign: 'center' }} inputMode="numeric" aria-label={`${s.code} ${c.name}`} value={counts[k] ?? ''} onChange={(e) => setCounts((x) => ({ ...x, [k]: e.target.value.replace(/\D/g, '') }))} />;
            })}
          </div>
        ))}
      </div>
      <ErrorNote error={err} />
      <div className="spread card">
        <span>{entries.length} items entered</span>
        <button className="btn primary" disabled={!canEdit || (!!started && !entries.length)} onClick={() => confirm(started ? 'Save the full spot check?' : 'Save the starting count? This can only be done once per location.') && save()}>
          {started ? 'Save spot check' : 'Save starting count'}
        </button>
      </div>
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

interface OValue { id: number; oracle_column: string; oracle_value: string; is_ignored: number; row_count: number; gi_value: string | null; gi_id: number | null; mapped: boolean; heldRows: number; last_seen: string | null }

function OracleValues({ meta, canEdit }: { meta: Meta; canEdit: boolean }) {
  const { data, error, reload } = useLoad(() => api<OValue[]>('/oracle-values'), []);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const options = (col: string) => {
    const list = col === 'SUIT_TYPE' ? meta.types.map((t) => ({ value: t.id, label: t.name }))
      : col === 'SUIT_COLOR' ? meta.colors.map((c) => ({ value: c.id, label: c.name }))
      : col === 'SUIT_SIZE' ? meta.sizes.map((s) => ({ value: s.id, label: s.code }))
      : meta.locations.map((l) => ({ value: l.id, label: l.code }));
    return [{ value: '', label: '— not mapped —' }, ...list, { value: 'ignore', label: 'Ignore' }];
  };
  const change = async (v: OValue, choice: string) => {
    setErr(null);
    try {
      const r = await api<{ reclassified: number }>(`/oracle-values/${v.id}`, { method: 'PUT', json: choice === 'ignore' ? { ignore: true } : { targetId: Number(choice) } });
      setMsg(`Saved · ${r.reclassified} held rows re-checked`);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="stack">
      <p className="muted small">How each value in the Oracle issue table translates to GI. New values appear here; rows that use them are held until they are mapped.</p>
      <ErrorNote error={error ?? err} />
      <table className="tbl">
        <thead><tr><th>Oracle column · value</th><th>Rows</th><th>Held</th><th style={{ textAlign: 'left' }}>GI value</th></tr></thead>
        <tbody>
          {data?.map((v) => (
            <tr key={v.id} style={{ background: !v.mapped ? 'var(--color-accent-2-100)' : undefined }}>
              <td>{v.oracle_column} · <b>{v.oracle_value}</b></td>
              <td>{fmtNum(v.row_count)}</td>
              <td>{v.heldRows || ''}</td>
              <td style={{ textAlign: 'left', minWidth: 160 }}>
                {canEdit ? (
                  <select className="input" value={v.is_ignored ? 'ignore' : v.gi_id ?? ''} onChange={(e) => e.target.value && change(v, e.target.value)}>
                    {options(v.oracle_column).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : v.is_ignored ? 'Ignore' : v.gi_value ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Toast message={msg} onDone={() => setMsg(null)} />
    </div>
  );
}

interface DQ { perDay: { day: string; location: string | null; incomplete: number; total: number }[]; unregisteredBarcodes: { barcode: string; times: number; first_seen: string; last_seen: string; locations: string }[] }

function DataQuality() {
  const { data, error } = useLoad(() => api<DQ>('/data-quality?days=30'), []);
  const days = useMemo(() => {
    const m = new Map<string, { incomplete: number; total: number }>();
    for (const r of data?.perDay ?? []) {
      const x = m.get(r.day) ?? { incomplete: 0, total: 0 };
      m.set(r.day, { incomplete: x.incomplete + r.incomplete, total: x.total + r.total });
    }
    return [...m].slice(-14).reverse();
  }, [data]);
  return (
    <div className="stack">
      <p className="muted small">Garments whose barcode is not registered in the suit master are reported by Oracle as GOWN / OTHER / OTHER. They count in issued per day and per location, but not per garment type, size or color.</p>
      <ErrorNote error={error} />
      <div className="grid-2">
        <section>
          <h2>Unregistered issues per day</h2>
          <table className="tbl"><thead><tr><th>Day</th><th>Unregistered</th><th>All issues</th><th>%</th></tr></thead>
            <tbody>{days.map(([d, v]) => <tr key={d}><td>{d}</td><td>{v.incomplete}</td><td>{fmtNum(v.total)}</td><td>{v.total ? ((v.incomplete / v.total) * 100).toFixed(1) : '0'}</td></tr>)}</tbody>
          </table>
        </section>
        <section>
          <div className="spread"><h2>Unregistered barcodes</h2><a className="btn" href="#" onClick={async (e) => {
            e.preventDefault();
            const res = DEMO ? await demoFetch('/data-quality/unregistered.csv')
              : await fetch('/api/data-quality/unregistered.csv', { headers: { 'X-Dev-User': localStorage.getItem('gi.devUser') ?? 'dev-lead' } });
            const url = URL.createObjectURL(await res.blob());
            Object.assign(document.createElement('a'), { href: url, download: 'unregistered-barcodes.csv' }).click();
          }} style={{ display: 'inline-flex', alignItems: 'center' }}>Download CSV</a></div>
          <p className="muted small">{data?.unregisteredBarcodes.length ?? 0} barcodes for the vendor to register</p>
          <table className="tbl"><thead><tr><th>Barcode</th><th>Times</th><th>Last seen</th><th>Where</th></tr></thead>
            <tbody>{data?.unregisteredBarcodes.slice(0, 50).map((b) => <tr key={b.barcode}><td>{b.barcode}</td><td>{b.times}</td><td>{fmtTime(b.last_seen)}</td><td>{b.locations}</td></tr>)}</tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

interface Run { id: number; kind: string; started_at: string; status: string; rows_read: number; rows_new: number; rows_applied: number; rows_held: number; rows_incomplete: number; rows_time_check_failed: number; error: string | null }
interface Alert { id: number; at: string; kind: string; message: string; acknowledged_at: string | null }

function ImportStatus({ isAdmin }: { isAdmin: boolean }) {
  const status = useLoad(() => api<{ lastSuccessfulImport: string | null; issuesUpTo: string | null; stale: boolean; pollSeconds: number }>('/sync/status'), []);
  const runs = useLoad(() => api<Run[]>('/sync/runs'), []);
  const alerts = useLoad(() => api<Alert[]>('/alerts'), []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (path: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api(path, { method: 'POST' });
      status.reload(); runs.reload(); alerts.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      {status.data && (
        <p className={status.data.stale ? 'notice warn' : 'notice'}>
          Last successful import {status.data.lastSuccessfulImport ? fmtTime(status.data.lastSuccessfulImport) : 'never'} · issues up to {status.data.issuesUpTo ? fmtTime(status.data.issuesUpTo) : '—'} · every {Math.round(status.data.pollSeconds / 60)} min
        </p>
      )}
      {isAdmin && <div className="row"><button className="btn" disabled={busy} onClick={() => run('/sync/run')}>Run import now</button><button className="btn" disabled={busy} onClick={() => run('/sync/sweep')}>Run catch-up sweep</button></div>}
      <ErrorNote error={err} />
      <section>
        <h2>Alerts</h2>
        <ul className="list">
          {alerts.data?.map((a) => (
            <li key={a.id}>
              <span className="grow"><span className={a.acknowledged_at ? 'badge' : 'badge warn'}>{a.kind.replace(/_/g, ' ')}</span> {a.message}<br /><span className="small muted">{fmtTime(a.at)}</span></span>
              {isAdmin && !a.acknowledged_at && <button className="btn" onClick={async () => { await api(`/alerts/${a.id}/ack`, { method: 'POST' }); alerts.reload(); }}>Mark checked</button>}
            </li>
          ))}
          {!alerts.data?.length && <li className="muted">No alerts.</li>}
        </ul>
      </section>
      <section>
        <h2>Recent runs</h2>
        <table className="tbl"><thead><tr><th>Started</th><th>Kind</th><th>Read</th><th>New</th><th>Applied</th><th>Held</th><th>Unreg.</th><th>Time check</th><th>Status</th></tr></thead>
          <tbody>{runs.data?.map((r) => <tr key={r.id}><td>{fmtTime(r.started_at)}</td><td>{r.kind}</td><td>{fmtNum(r.rows_read)}</td><td>{fmtNum(r.rows_new)}</td><td>{fmtNum(r.rows_applied)}</td><td>{r.rows_held}</td><td>{r.rows_incomplete}</td><td>{r.rows_time_check_failed}</td><td>{r.status}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
}
