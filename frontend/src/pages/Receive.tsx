import { useEffect, useState } from 'react';
import { api, fmtNum, fmtTime, icon, type Me, type Meta } from '../api';
import { ErrorNote, Segmented, Select, Stepper, Toast, useLoad } from '../components/ui';

interface Line { garmentTypeId: number; colorId: number; sizeId: number; locationId: number; qty: number }
const DRAFT_KEY = 'gi.deliveryDraft';

function loadDraft(): Line[] {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function Receive({ meta, me }: { meta: Meta; me: Me }) {
  const [view, setView] = useState<'new' | 'history'>('new');
  const canPost = me.role !== 'viewer';
  return (
    <div className="stack">
      <div className="spread">
        <h1>Receive</h1>
        <Segmented label="Receive view" value={view} onChange={setView} options={[{ value: 'new', label: 'New delivery' }, { value: 'history', label: 'History' }]} />
      </div>
      {view === 'new' ? (canPost ? <NewDelivery meta={meta} /> : <p className="muted">Viewers cannot enter deliveries.</p>) : <History canEdit={canPost} />}
    </div>
  );
}

function NewDelivery({ meta }: { meta: Meta }) {
  const activeColors = meta.colors.filter((c) => c.active);
  const activeSizes = meta.sizes.filter((s) => s.active);
  const [form, setForm] = useState({ garmentTypeId: meta.types[0].id, colorId: activeColors[0].id, sizeId: activeSizes[0].id, locationId: meta.locations[0].id, qty: '20' });
  const [lines, setLines] = useState<Line[]>(loadDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // RCV-07: the draft survives a reload or a dropped connection.
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(lines));
    } catch {
      /* ignore */
    }
  }, [lines]);

  const name = (l: Line) => meta.types.find((t) => t.id === l.garmentTypeId);
  const meta2 = (l: Line) => [meta.colors.find((c) => c.id === l.colorId)?.name, meta.sizes.find((s) => s.id === l.sizeId)?.code, meta.locations.find((x) => x.id === l.locationId)?.code].join(' · ');
  const same = (a: Line, b: Omit<Line, 'qty'>) => a.garmentTypeId === b.garmentTypeId && a.colorId === b.colorId && a.sizeId === b.sizeId && a.locationId === b.locationId;

  const add = () => {
    const qty = parseInt(form.qty, 10);
    if (!qty || qty < 1) return;
    const key = { garmentTypeId: form.garmentTypeId, colorId: form.colorId, sizeId: form.sizeId, locationId: form.locationId };
    setLines((ls) => (ls.some((l) => same(l, key)) ? ls.map((l) => (same(l, key) ? { ...l, qty: l.qty + qty } : l)) : [{ ...key, qty }, ...ls]));
  };
  const total = lines.reduce((s, l) => s + l.qty, 0);

  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      const key = sessionStorage.getItem('gi.postKey') ?? crypto.randomUUID();
      sessionStorage.setItem('gi.postKey', key); // same key on retry → no double post (NFR-06)
      const r = await api<{ total: number }>('/deliveries', { method: 'POST', json: { lines }, headers: { 'Idempotency-Key': key } });
      sessionStorage.removeItem('gi.postKey');
      setLines([]);
      setToast(`${fmtNum(r.total ?? total)} items added to stock`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: k === 'qty' ? v : Number(v) }));
  return (
    <div className="stack">
      <div className="form-grid">
        <Select label="Garment" value={form.garmentTypeId} onChange={set('garmentTypeId')} options={meta.types.map((t) => ({ value: t.id, label: t.plural === 'Boots' ? 'Boots' : t.name }))} />
        <Select label="Color" value={form.colorId} onChange={set('colorId')} options={activeColors.map((c) => ({ value: c.id, label: c.name }))} />
        <Select label="Size" value={form.sizeId} onChange={set('sizeId')} options={activeSizes.map((s) => ({ value: s.id, label: s.code }))} />
        <Select label="Location" value={form.locationId} onChange={set('locationId')} options={meta.locations.map((l) => ({ value: l.id, label: l.code }))} />
        <label className="field"><span>Quantity</span><input className="input num" inputMode="numeric" pattern="[0-9]*" value={form.qty} onChange={(e) => set('qty')(e.target.value.replace(/\D/g, ''))} /></label>
        <button className="btn" type="button" onClick={add}>Add line</button>
      </div>
      {lines.length === 0 ? (
        <p className="muted">No lines yet. Add each garment, color, size and location from the delivery.</p>
      ) : (
        <ul className="list">
          {lines.map((l, i) => (
            <li key={i}>
              <img className="garment-icon" src={icon(name(l)?.icon)} alt="" />
              <span className="grow"><b>{name(l)?.name}</b><br /><span className="muted small">{meta2(l)}</span></span>
              <Stepper label="quantity" step={5} value={l.qty} onChange={(q) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: q } : x)).filter((x) => x.qty > 0))} />
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={error} />
      <div className="spread card">
        <span><b>{lines.length}</b> lines · <b>{fmtNum(total)}</b> items</span>
        <button className="btn primary" disabled={!lines.length || busy} onClick={post}>{busy ? 'Posting…' : 'Post delivery'}</button>
      </div>
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

interface Delivery {
  id: number; receivedAt: string; status: string; createdBy: string;
  lines: { id: number; garment: string; icon: string; color: string; size: string; location: string; qty_original: number; qty_current: number }[];
  corrections: { at: string; isVoid: boolean; totalDelta: number; by: string }[];
}

function History({ canEdit }: { canEdit: boolean }) {
  const { data, error, reload } = useLoad(() => api<Delivery[]>('/deliveries?limit=30'), []);
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<number, number>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const save = async (d: Delivery, voidAll = false) => {
    setErr(null);
    try {
      const r = await api<{ totalDelta: number }>(`/deliveries/${d.id}/correction`, { method: 'POST', json: { void: voidAll, lines: Object.entries(draft).map(([lineId, qty]) => ({ lineId: Number(lineId), qty })) } });
      setMsg(`Saved · stock ${r.totalDelta >= 0 ? '+' : '−'}${Math.abs(r.totalDelta)}`);
      setOpen(null);
      setDraft({});
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="stack">
      <p className="muted small">Open a delivery to fix a wrong count. Saving changes stock by the difference and keeps a note of the change.</p>
      <ErrorNote error={error} />
      <ul className="list">
        {data?.map((d) => {
          const total = d.lines.reduce((s, l) => s + l.qty_current, 0);
          const isOpen = open === d.id;
          const diff = d.lines.reduce((s, l) => s + ((draft[l.id] ?? l.qty_current) - l.qty_current), 0);
          const changed = d.lines.some((l) => draft[l.id] !== undefined && draft[l.id] !== l.qty_current);
          const last = d.corrections.at(-1);
          return (
            <li key={d.id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <button className="spread" style={{ background: 'none', border: 0, padding: 0, minHeight: 44, cursor: 'pointer', textAlign: 'left' }}
                onClick={() => { setOpen(isOpen ? null : d.id); setDraft({}); setErr(null); }} aria-expanded={isOpen}>
                <span>
                  <b>{fmtTime(d.receivedAt)}</b> {d.status !== 'posted' && <span className="badge warn">{d.status === 'voided' ? 'Voided' : 'Edited'}</span>}<br />
                  <span className="muted small">{fmtNum(total)} items · {d.lines.length} lines · {[...new Set(d.lines.map((l) => l.location))].join(', ')} · {d.createdBy}</span>
                  {last && <><br /><span className="small muted">{last.isVoid ? 'Voided' : 'Corrected'} {fmtTime(last.at)} by {last.by} · {last.totalDelta >= 0 ? '+' : '−'}{Math.abs(last.totalDelta)} items</span></>}
                </span>
                <span aria-hidden>{isOpen ? '▴' : '▾'}</span>
              </button>
              {isOpen && (
                <div className="stack" style={{ paddingTop: 'var(--space-2)' }}>
                  <ul className="list">
                    {d.lines.map((l) => {
                      const q = draft[l.id] ?? l.qty_current;
                      return (
                        <li key={l.id}>
                          <img className="garment-icon" src={icon(l.icon)} alt="" />
                          <span className="grow">{l.garment}<br /><span className="small" style={{ color: q !== l.qty_current ? 'var(--color-accent-2-700)' : undefined }}>{l.color} · {l.size} · {l.location}{q !== l.qty_current ? ` · was ${l.qty_current}` : ''}</span></span>
                          {canEdit && d.status !== 'voided' ? <Stepper label="quantity" value={q} onChange={(v) => setDraft((x) => ({ ...x, [l.id]: v }))} /> : <b className="num">{q}</b>}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="small" style={{ color: changed ? 'var(--color-accent-2-700)' : undefined }}>
                    {!changed ? 'Tap − / + to fix a quantity.' : diff === 0 ? 'Quantities moved, total unchanged.' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} items will be ${diff > 0 ? 'added to' : 'taken out of'} stock`}
                  </p>
                  <ErrorNote error={err} />
                  {canEdit && d.status !== 'voided' && (
                    <div className="row">
                      <button className="btn primary" disabled={!changed} onClick={() => save(d)}>Save correction</button>
                      <button className="btn" onClick={() => setOpen(null)}>Cancel</button>
                      <button className="btn danger" onClick={() => confirm('Void this delivery? All its items are taken out of stock.') && save(d, true)}>Void delivery</button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Toast message={msg} onDone={() => setMsg(null)} />
    </div>
  );
}
