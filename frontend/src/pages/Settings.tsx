import { useMemo, useState } from 'react';
import { api, DEMO, demoFetch, fmtNum, fmtWhen, type Me, type Meta } from '../api';
import type { Device } from '../device';
import { Dropdown, ErrorNote, GIcon, Msg, PageHead, Seg, useFlash, useLoad, Warn } from '../components/ui';

type View = 'values' | 'correct' | 'count' | 'oracle' | 'quality' | 'import' | 'device';
const VIEWS: { value: View; label: string; kicker: string; title: string }[] = [
  { value: 'values', label: 'Sizes & colors', kicker: 'Settings', title: 'Sizes and colors' },
  { value: 'correct', label: 'Correct stock', kicker: 'Settings · stock correction', title: 'Correct a count' },
  { value: 'count', label: 'Full count', kicker: 'Settings · full count', title: 'Count everything' },
  { value: 'oracle', label: 'Oracle values', kicker: 'Settings · issue import', title: 'Oracle values' },
  { value: 'quality', label: 'Data quality', kicker: 'Settings · data quality', title: 'Unregistered garments' },
  { value: 'import', label: 'Import', kicker: 'Settings · issue import', title: 'Import status' },
  { value: 'device', label: 'This device', kicker: 'Settings · this device', title: 'View and user' },
];

interface Props {
  meta: Meta; me: Me; device: Device; reloadMeta: () => void;
  onSwitchView: (d: Device) => void; user: string; onChooseUser: (u: string) => void;
}

export function Settings(p: Props) {
  const [view, setView] = useState<View>('values');
  const v = VIEWS.find((x) => x.value === view)!;
  const lead = p.me.role === 'lead' || p.me.role === 'admin';
  return (
    <>
      <PageHead kicker={v.kicker} title={v.title} />
      <div className="p-seg">
        {p.device === 'laptop'
          ? <Seg label="Settings section" value={view} onChange={setView} optStyle={{ padding: '7px 4px' }} options={VIEWS.map((x) => ({ value: x.value, label: x.label }))} />
          : <Dropdown label="Section" value={view} onChange={setView} options={VIEWS.map((x) => ({ value: x.value, label: x.label }))} />}
      </div>
      <div className="p-body" style={view === 'values' ? { gap: 'var(--space-6)' } : undefined}>
        {!lead && ['values', 'correct', 'count', 'oracle'].includes(view) && <Warn>Only the cleanroom lead can change these settings.</Warn>}
        {view === 'values' && <Values meta={p.meta} canEdit={lead} reloadMeta={p.reloadMeta} />}
        {view === 'correct' && <CorrectStock meta={p.meta} canEdit={lead} />}
        {view === 'count' && <FullCount meta={p.meta} canEdit={lead} />}
        {view === 'oracle' && <OracleValues meta={p.meta} canEdit={lead} />}
        {view === 'quality' && <DataQuality />}
        {view === 'import' && <ImportStatus isAdmin={p.me.role === 'admin'} />}
        {view === 'device' && <ThisDevice {...p} />}
      </div>
    </>
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
  const block = (kind: 'size' | 'color', title: string, items: { id: number; label: string; active: number }[], placeholder: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h4 style={{ margin: 0 }}>{title}</h4>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.map((it) => (
          <span key={it.id} className={it.active ? 'chip' : 'chip off'}>
            {it.label}
            <button className="btn btn-ghost" disabled={!canEdit} aria-label={it.active ? `Hide ${it.label}` : `Restore ${it.label}`} title={it.active ? 'Hide' : 'Restore'}
              onClick={() => act(() => api(`/${kind}s/${it.id}/${it.active ? 'hide' : 'restore'}`, { method: 'POST' }))}
              style={{ minWidth: 36, minHeight: 40, padding: 0, color: 'var(--color-neutral-700)', fontSize: 16 }}>{it.active ? '×' : '↺'}</button>
          </span>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
        <input className="input" placeholder={placeholder} value={text[kind]} onChange={(e) => setText((t) => ({ ...t, [kind]: e.target.value }))} style={{ minHeight: 44 }} />
        <button className="btn btn-secondary" disabled={!canEdit || !text[kind].trim()} style={{ minHeight: 44 }}
          onClick={() => act(async () => { await api(`/${kind}s`, { method: 'POST', json: { value: text[kind] } }); setText((t) => ({ ...t, [kind]: '' })); })}>
          Add {kind}
        </button>
      </div>
    </div>
  );
  return (
    <>
      <ErrorNote error={err} />
      {block('size', 'Sizes', meta.sizes.map((s) => ({ id: s.id, label: s.code, active: s.active })), 'New size, e.g. 5XLG')}
      {block('color', 'Colors', meta.colors.map((c) => ({ id: c.id, label: c.name, active: c.active })), 'New color, e.g. Grey')}
      <div className="note">New sizes and colors show up straight away in Receive, Stock and stock correction. Removing one only hides it from those screens — its stock records are kept.</div>
    </>
  );
}

interface Grid { rows: { size: string; cells: { colorId: number; onHand: number }[] }[] }
interface Correction { id: number; at: string; reason: string; counted: number; system_qty: number; user_name: string; garment: string; is_system: number; color: string; size: string; location: string }
const REASONS = [
  { value: 'spot_check', label: 'Spot check' }, { value: 'damaged', label: 'Damaged' }, { value: 'found', label: 'Found' },
  { value: 'miscount_at_delivery', label: 'Miscount at delivery' }, { value: 'other', label: 'Other' },
];
const ICON_BY_GARMENT: Record<string, string> = { Gown: 'gown', Hood: 'hood', Boots: 'boot' };

function CorrectStock({ meta, canEdit }: { meta: Meta; canEdit: boolean }) {
  const colors = meta.colors.filter((c) => c.active), sizes = meta.sizes.filter((s) => s.active);
  const [f, setF] = useState({ garmentTypeId: meta.types[0].id, colorId: colors[0].id, sizeId: sizes[0].id, locationId: meta.locations[0].id, counted: '', reason: 'spot_check', note: '' });
  const grid = useLoad(() => api<Grid>(`/stock/grid?garmentTypeId=${f.garmentTypeId}&locationId=${f.locationId}`), [f.garmentTypeId, f.locationId]);
  const log = useLoad(() => api<Correction[]>('/corrections'), []);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useFlash();
  const sizeCode = sizes.find((s) => s.id === f.sizeId)?.code;
  const sys = grid.data?.rows.find((r) => r.size === sizeCode)?.cells.find((c) => c.colorId === f.colorId)?.onHand ?? 0;
  const counted = f.counted === '' ? null : Number(f.counted);
  const pick = (k: 'garmentTypeId' | 'colorId' | 'sizeId' | 'locationId') => (v: number) => setF((x) => ({ ...x, [k]: v, counted: '' }));
  const diff = counted === null ? null : counted - sys;
  const save = async () => {
    setErr(null);
    try {
      await api('/corrections', { method: 'POST', json: { reason: f.reason, note: f.note || undefined, locationId: f.locationId, items: [{ garmentTypeId: f.garmentTypeId, colorId: f.colorId, sizeId: f.sizeId, qty: counted }] } });
      setSaved(`${sys} → ${counted}`);
      setF((x) => ({ ...x, counted: '' }));
      grid.reload();
      log.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <>
      <Warn>Only for when the system count is wrong. To fix a delivery, use Receive › History instead. Every correction is logged.</Warn>
      {saved && <Msg tag="Saved" text={saved} />}
      <ErrorNote error={err} />
      <div className="fields">
        <Dropdown label="Garment" value={f.garmentTypeId} onChange={pick('garmentTypeId')} options={meta.types.map((t) => ({ value: t.id, label: t.code === 'BOOT' ? 'Boots' : t.name, icon: t.icon }))} />
        <Dropdown label="Color" value={f.colorId} onChange={pick('colorId')} options={colors.map((c) => ({ value: c.id, label: c.name }))} />
        <Dropdown label="Size" value={f.sizeId} onChange={pick('sizeId')} options={sizes.map((s) => ({ value: s.id, label: s.code }))} />
        <Dropdown label="Location" value={f.locationId} onChange={pick('locationId')} options={meta.locations.map((l) => ({ value: l.id, label: l.code }))} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'end' }}>
        <div><div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>In system</div><div className="num" style={{ fontSize: 40, lineHeight: 1.1, fontWeight: 600 }}>{sys}</div></div>
        <div className="field">
          <label htmlFor="counted">Counted on the shelf</label>
          <input id="counted" className="input num" inputMode="numeric" placeholder={String(sys)} value={f.counted} onChange={(e) => setF((x) => ({ ...x, counted: e.target.value.replace(/\D/g, '') }))}
            style={{ minHeight: 56, fontSize: 28, fontWeight: 600 }} />
        </div>
      </div>
      <div style={{ fontSize: 15, color: diff ? 'var(--color-accent-2-700)' : 'var(--color-neutral-700)' }}>
        {diff === null ? 'Enter what is on the shelf.' : diff === 0 ? 'Matches the system.' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} — stock will be set to ${counted}`}
      </div>
      <Dropdown label="Reason" value={f.reason} onChange={(v) => setF((x) => ({ ...x, reason: v }))} options={REASONS} />
      {f.reason === 'other' && <input className="input" aria-label="Note" placeholder="Why the count was wrong" value={f.note} onChange={(e) => setF((x) => ({ ...x, note: e.target.value }))} style={{ minHeight: 44 }} />}
      <button className="btn btn-primary" disabled={!canEdit || counted === null || diff === 0 || (f.reason === 'other' && !f.note)} onClick={save} style={{ minHeight: 48, fontSize: 15 }}>Save correction</button>
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
        <h6 style={{ margin: '0 0 4px', color: 'var(--color-neutral-700)' }}>Recent corrections</h6>
        {log.data?.map((l) => (
          <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '28px 1fr auto', gap: 8, alignItems: 'center', padding: '6px 0', fontSize: 14 }}>
            <GIcon name={l.is_system ? null : ICON_BY_GARMENT[l.garment]} size={22} color="var(--color-accent-700)" />
            <div>
              <div style={{ fontWeight: 600 }}>{l.is_system ? `Unregistered · ${l.location}` : `${l.garment} · ${l.color} · ${l.size} · ${l.location}`}</div>
              <div style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>{REASONS.find((r) => r.value === l.reason)?.label ?? 'Starting count'} · {fmtWhen(l.at)} · {l.user_name}</div>
            </div>
            <div className="num" style={{ textAlign: 'right' }}>{l.system_qty} → <b>{l.counted}</b></div>
          </div>
        ))}
      </div>
    </>
  );
}

// Site time is Phoenix (UTC−7 all year, no daylight saving), so a local time converts with a fixed offset.
const phoenixToIso = (local: string) => new Date(`${local}:00-07:00`).toISOString();
const nowPhoenixLocal = () => new Date(Date.now() - 7 * 3600_000).toISOString().slice(0, 16);

/** Starting count (ADJ-05) or a full spot check that also clears the unregistered count (DQ-06). */
function FullCount({ meta, canEdit }: { meta: Meta; canEdit: boolean }) {
  const starts = useLoad(() => api<{ locationId: number; asOf: string | null }[]>('/starting-counts'), []);
  const [locId, setLocId] = useState(meta.locations[0].id);
  const [typeId, setTypeId] = useState(meta.types[0].id);
  const [asOf, setAsOf] = useState(nowPhoenixLocal());
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useFlash();
  const colors = meta.colors.filter((c) => c.active), sizes = meta.sizes.filter((s) => s.active);
  const started = starts.data?.find((s) => s.locationId === locId)?.asOf;
  const entries = useMemo(() => Object.entries(counts).filter(([, v]) => v !== ''), [counts]);
  const cols = `44px repeat(${colors.length}, minmax(0, 1fr))`;
  const save = async () => {
    setErr(null);
    const items = entries.map(([k, v]) => {
      const [t, c, s] = k.split('|').map(Number);
      return { garmentTypeId: t, colorId: c, sizeId: s, qty: Number(v) };
    });
    try {
      if (!started) {
        const r = await api<{ issuesApplied: number }>('/starting-counts', { method: 'POST', json: { locationId: locId, asOf: phoenixToIso(asOf), counts: items } });
        setSaved(`Starting count · ${r.issuesApplied} issues since then applied`);
      } else {
        await api('/corrections', { method: 'POST', json: { reason: 'spot_check', locationId: locId, items, clearUnregistered: true } });
        setSaved('Full spot check · unregistered count reset to 0');
      }
      setCounts({});
      starts.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <>
      <div style={{ display: 'flex', gap: 8 }}>
        <Seg label="Garment" style={{ flex: 1 }} optStyle={{ padding: '7px 2px', gap: 4, fontSize: 12.5 }} value={typeId} onChange={setTypeId} options={meta.types.map((t) => ({ value: t.id, label: t.plural, icon: t.icon }))} />
        <Seg label="Location" optStyle={{ flex: 'none', padding: '7px 8px' }} value={locId} onChange={setLocId} options={meta.locations.map((l) => ({ value: l.id, label: l.code }))} />
      </div>
      {started ? (
        <div className="note">Starting count done {fmtWhen(started)}. Use this for a <b>full spot check</b>: enter what is on the shelf for every garment type, then save — the unregistered count for this fab goes back to 0. Empty cells keep their current number.</div>
      ) : (
        <>
          <Warn>No starting count yet for this fab. Count everything, then enter the counts with the time counting <b>finished</b>. Issues scanned after that time reduce stock; empty cells count as 0.</Warn>
          <div className="field" style={{ maxWidth: 280 }}><label htmlFor="asof">Counting finished at (Phoenix time)</label><input id="asof" className="input" type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ minHeight: 44 }} /></div>
        </>
      )}
      {saved && <Msg tag="Saved" text={saved} />}
      <ErrorNote error={err} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 4, fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-neutral-700)' }}>
          <span />{colors.map((c) => <span key={c.id} style={{ textAlign: 'center' }}>{c.name}</span>)}
        </div>
        {sizes.map((s) => (
          <div key={s.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, alignSelf: 'center' }}>{s.code}</span>
            {colors.map((c) => {
              const k = `${typeId}|${c.id}|${s.id}`;
              return <input key={k} className="input num" inputMode="numeric" aria-label={`${s.code} ${c.name}`} value={counts[k] ?? ''} onChange={(e) => setCounts((x) => ({ ...x, [k]: e.target.value.replace(/\D/g, '') }))}
                style={{ minHeight: 40, textAlign: 'center', fontWeight: 600, fontSize: 15 }} />;
            })}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, fontSize: 13, color: 'var(--color-neutral-700)' }}>{entries.length} items entered</div>
        <button className="btn btn-primary" style={{ minHeight: 48, fontSize: 15, padding: '0 22px' }} disabled={!canEdit || (!!started && !entries.length)}
          onClick={() => confirm(started ? 'Save the full spot check?' : 'Save the starting count? This can only be done once per fab.') && save()}>
          {started ? 'Save spot check' : 'Save starting count'}
        </button>
      </div>
    </>
  );
}

interface OValue { id: number; oracle_column: string; oracle_value: string; is_ignored: number; row_count: number; gi_id: number | null; mapped: boolean; heldRows: number }

function OracleValues({ meta, canEdit }: { meta: Meta; canEdit: boolean }) {
  const { data, error, reload } = useLoad(() => api<OValue[]>('/oracle-values'), []);
  const [saved, setSaved] = useFlash();
  const [err, setErr] = useState<string | null>(null);
  const options = (col: string): { value: string; label: string }[] => {
    const list = col === 'SUIT_TYPE' ? meta.types.map((t) => ({ value: String(t.id), label: t.name }))
      : col === 'SUIT_COLOR' ? meta.colors.map((c) => ({ value: String(c.id), label: c.name }))
      : col === 'SUIT_SIZE' ? meta.sizes.map((s) => ({ value: String(s.id), label: s.code }))
      : meta.locations.map((l) => ({ value: String(l.id), label: l.code }));
    return [{ value: '', label: 'Not mapped' }, ...list, { value: 'ignore', label: 'Ignore' }];
  };
  const change = async (v: OValue, choice: string) => {
    if (!choice) return;
    setErr(null);
    try {
      const r = await api<{ reclassified: number }>(`/oracle-values/${v.id}`, { method: 'PUT', json: choice === 'ignore' ? { ignore: true } : { targetId: Number(choice) } });
      setSaved(`${v.oracle_column} ${v.oracle_value} · ${r.reclassified} held rows applied`);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <>
      <div className="note">How each value in the Oracle issue table translates to GI. New values appear first; rows that use them are held until they are mapped.</div>
      {saved && <Msg tag="Saved" text={saved} />}
      <ErrorNote error={error ?? err} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {data?.map((v) => (
          <div key={v.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10, alignItems: 'center', padding: '6px 0' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{v.oracle_value} {!v.mapped && <span className="tag tag-accent-2">New</span>}</div>
              <div style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>{v.oracle_column} · {fmtNum(v.row_count)} rows{v.heldRows ? ` · ${v.heldRows} held` : ''}</div>
            </div>
            {canEdit
              ? <Dropdown label="GI value" value={v.is_ignored ? 'ignore' : v.gi_id === null ? '' : String(v.gi_id)} onChange={(c) => change(v, c)} options={options(v.oracle_column)} />
              : <span>{v.is_ignored ? 'Ignore' : options(v.oracle_column).find((o) => o.value === String(v.gi_id))?.label ?? 'Not mapped'}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

interface DQ { perDay: { day: string; incomplete: number; total: number }[]; unregisteredBarcodes: { barcode: string; times: number; last_seen: string; locations: string }[] }

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
  const download = async () => {
    const res = DEMO ? await demoFetch('/data-quality/unregistered.csv')
      : await fetch('/api/data-quality/unregistered.csv', { headers: { 'X-Dev-User': localStorage.getItem('gi.devUser') ?? 'dev-lead' } });
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: 'unregistered-barcodes.csv' }).click();
  };
  return (
    <>
      <div className="note">Garments whose barcode is not in the suit master come through as GOWN / OTHER / OTHER. They count in issued per day and per fab, but not per garment type, size or color.</div>
      <ErrorNote error={error} />
      <table className="table num">
        <thead><tr><th>Day</th><th style={{ textAlign: 'right' }}>Unregistered</th><th style={{ textAlign: 'right' }}>All issues</th><th style={{ textAlign: 'right' }}>%</th></tr></thead>
        <tbody>{days.map(([d, v]) => <tr key={d}><td>{d}</td><td style={{ textAlign: 'right' }}>{v.incomplete}</td><td style={{ textAlign: 'right' }}>{fmtNum(v.total)}</td><td style={{ textAlign: 'right' }}>{v.total ? ((v.incomplete / v.total) * 100).toFixed(1) : '0'}</td></tr>)}</tbody>
      </table>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h4 style={{ margin: 0 }}>Unregistered barcodes <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--color-neutral-700)' }}>· {data?.unregisteredBarcodes.length ?? 0} for the vendor to register</span></h4>
        <button className="btn btn-secondary" onClick={download} style={{ minHeight: 44 }}>Download CSV</button>
      </div>
      <table className="table num">
        <thead><tr><th>Barcode</th><th style={{ textAlign: 'right' }}>Times</th><th>Last seen</th><th>Where</th></tr></thead>
        <tbody>{data?.unregisteredBarcodes.slice(0, 50).map((b) => <tr key={b.barcode}><td>{b.barcode}</td><td style={{ textAlign: 'right' }}>{b.times}</td><td>{fmtWhen(b.last_seen)}</td><td>{b.locations}</td></tr>)}</tbody>
      </table>
    </>
  );
}

interface Run { id: number; kind: string; started_at: string; status: string; rows_read: number; rows_new: number; rows_applied: number; rows_held: number; rows_incomplete: number; rows_time_check_failed: number }
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
  const s = status.data;
  return (
    <>
      {s && (s.stale ? <Warn>No successful import for a while — last {s.lastSuccessfulImport ? fmtWhen(s.lastSuccessfulImport) : 'never'}.</Warn>
        : <Msg tag="OK" text={<>Last import {s.lastSuccessfulImport ? fmtWhen(s.lastSuccessfulImport) : '—'} · issues up to {s.issuesUpTo ? fmtWhen(s.issuesUpTo) : '—'} · every {Math.round(s.pollSeconds / 60)} min</>} />)}
      {isAdmin && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" disabled={busy} onClick={() => run('/sync/run')} style={{ minHeight: 44 }}>Run import now</button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => run('/sync/sweep')} style={{ minHeight: 44 }}>Run catch-up sweep</button>
        </div>
      )}
      <ErrorNote error={err} />
      <div>
        <h4 className="sec">Alerts</h4>
        {alerts.data?.map((a) => (
          <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', fontSize: 14 }}>
            <div style={{ flex: 1 }}>
              <div><span className={a.acknowledged_at ? 'tag tag-neutral' : 'tag tag-accent-2'}>{a.kind.replace(/_/g, ' ')}</span> {a.message}</div>
              <div style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>{fmtWhen(a.at)}</div>
            </div>
            {isAdmin && !a.acknowledged_at && <button className="btn btn-ghost" onClick={async () => { await api(`/alerts/${a.id}/ack`, { method: 'POST' }); alerts.reload(); }}>Mark checked</button>}
          </div>
        ))}
        {!alerts.data?.length && <div className="note">No alerts.</div>}
      </div>
      <table className="table num">
        <thead><tr><th>Recent runs</th><th>Kind</th><th style={{ textAlign: 'right' }}>New</th><th style={{ textAlign: 'right' }}>Applied</th><th style={{ textAlign: 'right' }}>Held</th><th>Status</th></tr></thead>
        <tbody>{runs.data?.map((r) => <tr key={r.id}><td>{fmtWhen(r.started_at)}</td><td>{r.kind}</td><td style={{ textAlign: 'right' }}>{fmtNum(r.rows_new)}</td><td style={{ textAlign: 'right' }}>{fmtNum(r.rows_applied)}</td><td style={{ textAlign: 'right' }}>{r.rows_held}</td><td>{r.status}</td></tr>)}</tbody>
      </table>
    </>
  );
}

const DEV_USERS = [
  { value: 'dev-floor', label: 'Floor staff' }, { value: 'dev-lead', label: 'Cleanroom lead' },
  { value: 'dev-admin', label: 'Admin' }, { value: 'dev-viewer', label: 'Viewer' },
];

function ThisDevice({ device, onSwitchView, user, onChooseUser, me }: Props) {
  return (
    <>
      <div className="note">The layout is chosen from the type of device. Change it here if this device got the wrong one; the choice is remembered on this device.</div>
      <Seg label="Layout" value={device} onChange={onSwitchView} options={[{ value: 'phone', label: 'Phone layout' }, { value: 'laptop', label: 'Laptop layout' }]} />
      {DEMO ? (
        <div className="note">Demo: signed in as {me.name}.</div>
      ) : (
        <>
          <div className="note">Company sign-in (SSO) is not connected yet. For development, choose who you are:</div>
          <Dropdown label="Signed in as (dev)" value={user} onChange={onChooseUser} options={DEV_USERS} />
        </>
      )}
    </>
  );
}
