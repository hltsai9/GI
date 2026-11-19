import { useEffect, useState } from 'react';
import { CaretDown, CaretUp, Plus } from '@phosphor-icons/react';
import { api, fmtNum, fmtToday, fmtWhen, type Me, type Meta } from '../api';
import { Dropdown, ErrorNote, GIcon, Msg, PageHead, QtyField, Seg, Stepper, useFlash, useLoad } from '../components/ui';

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
    <>
      <PageHead kicker={view === 'new' ? `Receive · ${fmtToday()}` : 'Receive · history'} title={view === 'new' ? 'Morning delivery' : 'Past deliveries'} />
      <div className="p-seg">
        <Seg label="Receive view" value={view} onChange={setView} options={[{ value: 'new', label: 'New delivery' }, { value: 'history', label: 'History' }]} />
      </div>
      {view === 'new' ? <NewDelivery meta={meta} canPost={canPost} /> : <History canEdit={canPost} />}
    </>
  );
}

function NewDelivery({ meta, canPost }: { meta: Meta; canPost: boolean }) {
  const colors = meta.colors.filter((c) => c.active);
  const sizes = meta.sizes.filter((s) => s.active);
  const [form, setForm] = useState({ garmentTypeId: meta.types[0].id, colorId: colors[0].id, sizeId: sizes[0].id, locationId: meta.locations[0].id, qty: '20' });
  const [lines, setLines] = useState<Line[]>(loadDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useFlash();

  // RCV-07: the draft survives a reload or a dropped connection.
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(lines));
    } catch {
      /* ignore */
    }
  }, [lines]);

  const type = (l: Line) => meta.types.find((t) => t.id === l.garmentTypeId);
  const metaText = (l: Line) => [meta.colors.find((c) => c.id === l.colorId)?.name, meta.sizes.find((s) => s.id === l.sizeId)?.code, meta.locations.find((x) => x.id === l.locationId)?.code].join(' · ');
  const same = (a: Line, b: Omit<Line, 'qty'>) => a.garmentTypeId === b.garmentTypeId && a.colorId === b.colorId && a.sizeId === b.sizeId && a.locationId === b.locationId;
  const add = () => {
    const qty = parseInt(form.qty, 10);
    if (!qty) return;
    const key = { garmentTypeId: form.garmentTypeId, colorId: form.colorId, sizeId: form.sizeId, locationId: form.locationId };
    setLines((ls) => (ls.some((l) => same(l, key)) ? ls.map((l) => (same(l, key) ? { ...l, qty: l.qty + qty } : l)) : [{ ...key, qty }, ...ls]));
    setPosted(null);
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
      setPosted(`${fmtNum(r.total ?? total)} items added to stock`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const typeName = (t: Meta['types'][number]) => (t.code === 'BOOT' ? 'Boots' : t.name);
  return (
    <>
      <div className="p-body">
        {posted && <Msg tag="Posted" text={posted} />}
        <ErrorNote error={error} />
        <div className="fields">
          <Dropdown label="Garment" value={form.garmentTypeId} onChange={(v) => setForm({ ...form, garmentTypeId: v })} options={meta.types.map((t) => ({ value: t.id, label: typeName(t), icon: t.icon }))} />
          <Dropdown label="Color" value={form.colorId} onChange={(v) => setForm({ ...form, colorId: v })} options={colors.map((c) => ({ value: c.id, label: c.name }))} />
          <Dropdown label="Size" value={form.sizeId} onChange={(v) => setForm({ ...form, sizeId: v })} options={sizes.map((s) => ({ value: s.id, label: s.code }))} />
          <Dropdown label="Location" value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} options={meta.locations.map((l) => ({ value: l.id, label: l.code }))} />
          <QtyField label="Quantity" value={form.qty} onChange={(v) => setForm({ ...form, qty: v })} />
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={add} style={{ width: '100%', minHeight: 54, borderRadius: 'var(--radius-lg)' }}><Plus size={18} />Add line</button>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {lines.map((l, i) => (
            <div key={i} className="line">
              <GIcon name={type(l)?.icon} size={28} color="var(--color-accent-700)" />
              <div style={{ flex: 1, minWidth: 0 }}><div className="line-name">{type(l) ? typeName(type(l)!) : ''}</div><div className="line-meta">{metaText(l)}</div></div>
              <Stepper label="quantity" step={5} value={l.qty} onChange={(q) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: q } : x)).filter((x) => x.qty > 0))} />
            </div>
          ))}
          {!lines.length && <div style={{ fontSize: 14, color: 'var(--color-neutral-700)', padding: '8px 0' }}>No lines yet. Add each garment, color, size and location from the delivery.</div>}
        </div>
      </div>
      <div className="p-foot">
        <div style={{ flex: 1, fontSize: 13, color: 'var(--color-neutral-700)' }}>
          {lines.length} lines<br /><span style={{ fontSize: 17, fontWeight: 600, color: 'var(--color-text)' }}>{fmtNum(total)} items</span>
        </div>
        <button className="btn btn-primary" onClick={post} disabled={!lines.length || busy || !canPost} style={{ minHeight: 48, fontSize: 15, padding: '0 22px' }}>{busy ? 'Posting…' : 'Post delivery'}</button>
      </div>
    </>
  );
}

interface Delivery {
  id: number; receivedAt: string; status: string; createdBy: string;
  lines: { id: number; garment: string; icon: string; color: string; size: string; location: string; qty_current: number }[];
  corrections: { at: string; isVoid: boolean; totalDelta: number; by: string }[];
}

function History({ canEdit }: { canEdit: boolean }) {
  const { data, error, reload } = useLoad(() => api<Delivery[]>('/deliveries?limit=30'), []);
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<number, number>>({});
  const [saved, setSaved] = useFlash();
  const [err, setErr] = useState<string | null>(null);
  const plural = (g: string) => (g === 'Boots' ? 'Boots' : g);

  const save = async (d: Delivery, voidAll = false) => {
    setErr(null);
    try {
      const r = await api<{ totalDelta: number }>(`/deliveries/${d.id}/correction`, { method: 'POST', json: { void: voidAll, lines: Object.entries(draft).map(([lineId, qty]) => ({ lineId: Number(lineId), qty })) } });
      setSaved(`${fmtWhen(d.receivedAt)} · stock ${r.totalDelta >= 0 ? '+' : '−'}${Math.abs(r.totalDelta)}`);
      setOpen(null);
      setDraft({});
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="p-body" style={{ gap: 'var(--space-2)' }}>
      {saved && <div style={{ paddingBottom: 6 }}><Msg tag="Saved" text={saved} /></div>}
      <ErrorNote error={error ?? err} />
      {data?.map((d) => {
        const total = d.lines.reduce((s, l) => s + l.qty_current, 0);
        const isOpen = open === d.id;
        const diff = d.lines.reduce((s, l) => s + ((draft[l.id] ?? l.qty_current) - l.qty_current), 0);
        const changed = d.lines.some((l) => draft[l.id] !== undefined && draft[l.id] !== l.qty_current);
        const last = d.corrections.at(-1);
        return (
          <div key={d.id} style={{ display: 'flex', flexDirection: 'column' }}>
            <button onClick={() => { setOpen(isOpen ? null : d.id); setDraft({}); setErr(null); }} aria-expanded={isOpen}
              style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 60, padding: '8px 0', border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', color: 'var(--color-text)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="line-name">{fmtWhen(d.receivedAt)}</div>
                <div className="line-meta">{fmtNum(total)} items · {d.lines.length} lines · {[...new Set(d.lines.map((l) => l.location))].join(', ')}</div>
              </div>
              {d.status !== 'posted' && <span className="tag tag-neutral">{d.status === 'voided' ? 'Voided' : 'Edited'}</span>}
              <span style={{ color: 'var(--color-accent-700)' }}>{isOpen ? <CaretUp size={18} /> : <CaretDown size={18} />}</span>
            </button>
            {isOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 0 14px' }}>
                {last && <div style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--color-neutral-700)', paddingBottom: 4 }}>{last.isVoid ? 'Voided' : 'Corrected'} {fmtWhen(last.at)} by {last.by} · {last.totalDelta >= 0 ? '+' : '−'}{Math.abs(last.totalDelta)} items</div>}
                {d.lines.map((l) => {
                  const q = draft[l.id] ?? l.qty_current;
                  const moved = q !== l.qty_current;
                  return (
                    <div key={l.id} className="line" style={{ padding: '6px 0' }}>
                      <GIcon name={l.icon} size={24} color="var(--color-accent-700)" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{plural(l.garment)}</div>
                        <div style={{ fontSize: 12, color: moved ? 'var(--color-accent-2-700)' : 'var(--color-neutral-700)' }}>{l.color} · {l.size} · {l.location}{moved ? ` · was ${l.qty_current}` : ''}</div>
                      </div>
                      {canEdit && d.status !== 'voided'
                        ? <Stepper label="quantity" value={q} size={16} width={36} onChange={(v) => setDraft((x) => ({ ...x, [l.id]: v }))} />
                        : <span className="num" style={{ fontWeight: 600 }}>{q}</span>}
                    </div>
                  );
                })}
                <div style={{ fontSize: 14, padding: '6px 0', color: changed ? 'var(--color-accent-2-700)' : 'var(--color-neutral-700)' }}>
                  {!changed ? 'Tap − / + to fix a quantity.' : diff === 0 ? 'Quantities moved, total unchanged.' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} items will be ${diff > 0 ? 'added to' : 'taken out of'} stock`}
                </div>
                {canEdit && d.status !== 'voided' && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button className="btn btn-primary" disabled={!changed} onClick={() => save(d)} style={{ minHeight: 44 }}>Save correction</button>
                    <button className="btn btn-ghost" onClick={() => setOpen(null)} style={{ minHeight: 44 }}>Cancel</button>
                    <button className="btn btn-ghost" onClick={() => confirm('Void this delivery? All its items are taken out of stock.') && save(d, true)} style={{ minHeight: 44, marginLeft: 'auto', color: 'var(--color-accent-2-700)' }}>Void delivery</button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="note" style={{ paddingTop: 6 }}>Open a delivery to fix a wrong count. Saving changes stock by the difference and keeps a note of the change.</div>
    </div>
  );
}
