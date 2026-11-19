import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react';
import { CaretDown, CaretUp, Check, Warning } from '@phosphor-icons/react';
import { icon } from '../api';

// Components matching design/mockups/Garment Inventory App.dc.html, built on broadsheet.css.

/** Page title block: small accent kicker above the title. */
export function PageHead({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="p-head">
      <div className="kicker">{kicker}</div>
      <h3>{title}</h3>
    </div>
  );
}

/** Full-width segmented control (Broadsheet .seg / .seg-opt). */
export function Seg<T extends string | number>({ options, value, onChange, label, style, optStyle }: {
  options: { value: T; label: ReactNode; icon?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  style?: CSSProperties;
  optStyle?: CSSProperties;
}) {
  const name = useId();
  return (
    <div className="seg" role="radiogroup" aria-label={label} style={style}>
      {options.map((o) => (
        <label key={String(o.value)} className="seg-opt" style={optStyle}>
          <input type="radio" name={name} checked={o.value === value} onChange={() => onChange(o.value)} />
          {o.icon && <GIcon name={o.icon} size={16} />}
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** Garment icon tinted with the current color (CSS mask over the SVG). */
export function GIcon({ name, size = 28, color }: { name?: string | null; size?: number; color?: string }) {
  if (!name) return <span style={{ width: size, height: size, flex: 'none' }} />;
  return <span className="gicon" aria-hidden style={{ width: size, height: size, color, ['--src' as string]: `url(${icon(name)})` }} />;
}

/** Dropdown with the label inside the box, as in the mockup. */
export function Dropdown<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: string }[];
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.value === value);
  return (
    <div className="dd">
      <button type="button" className="dd-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="dd-label">{label}</span>
        {cur?.label ?? '—'}
        <span className="dd-caret">{open ? <CaretUp size={16} /> : <CaretDown size={16} />}</span>
      </button>
      {open && (
        <>
          <div className="dd-scrim" onClick={() => setOpen(false)} />
          <div className="dd-menu" role="listbox" aria-label={label}>
            {options.map((o) => (
              <button key={String(o.value)} type="button" role="option" aria-selected={o.value === value} onClick={() => { onChange(o.value); setOpen(false); }}>
                {o.icon && <GIcon name={o.icon} size={22} />}
                <span style={{ flex: 1 }}>{o.label}</span>
                {o.value === value && <Check size={16} color="var(--color-accent-700)" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Number field with the label inside the box. */
export function QtyField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="qty">
      <span className="dd-label">{label}</span>
      <input inputMode="numeric" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} />
    </label>
  );
}

export function Stepper({ value, onChange, step = 1, min = 0, label, size = 17, width = 40 }: {
  value: number; onChange: (v: number) => void; step?: number; min?: number; label: string; size?: number; width?: number;
}) {
  return (
    <>
      <button type="button" className="btn btn-secondary btn-icon stepbtn" aria-label={`decrease ${label}`} onClick={() => onChange(Math.max(min, value - step))}>−</button>
      <span className="num" style={{ width, textAlign: 'center', fontSize: size, fontWeight: 600 }}>{value}</span>
      <button type="button" className="btn btn-secondary btn-icon stepbtn" aria-label={`increase ${label}`} onClick={() => onChange(value + step)}>+</button>
    </>
  );
}

/** "Posted · 205 items added" style confirmation (mockup tag + text). */
export function Msg({ tag, text, tone = 'accent' }: { tag: string; text: ReactNode; tone?: 'accent' | 'accent-2' | 'neutral' }) {
  return <div className="msg"><span className={`tag tag-${tone}`}>{tag}</span><span>{text}</span></div>;
}

export function Warn({ children }: { children: ReactNode }) {
  return <div className="warn"><Warning size={20} /><span>{children}</span></div>;
}

const STATUS_TEXT: Record<string, string> = {
  negative: 'Negative — check deliveries', below_min: 'Below minimum', close_to_min: 'Close to minimum', plenty: 'OK', not_stocked: 'Not stocked — set a minimum to start',
};
export const statusText = (s: string) => STATUS_TEXT[s] ?? s;

/** Cell colors from the mockup grid. */
export function cellColors(status: string) {
  if (status === 'negative' || status === 'below_min') return { bg: 'var(--color-accent-2-200)', fg: 'var(--color-accent-2-800)' };
  if (status === 'close_to_min') return { bg: 'var(--color-neutral-200)', fg: 'var(--color-neutral-800)' };
  if (status === 'plenty') return { bg: 'var(--color-accent-100)', fg: 'var(--color-accent-800)' };
  return { bg: 'transparent', fg: 'var(--color-neutral-500)' };
}

/** Loads data from an async function, re-running when deps change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((d) => live && (setData(d), setError(null))).catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <div role="alert"><Warn>{error}</Warn></div> : null;
}

/** Clears a confirmation message after a few seconds. */
export function useFlash(): [string | null, (m: string | null) => void] {
  const [m, setM] = useState<string | null>(null);
  useEffect(() => {
    if (!m) return;
    const t = setTimeout(() => setM(null), 6000);
    return () => clearTimeout(t);
  }, [m]);
  return [m, setM];
}
