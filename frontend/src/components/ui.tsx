import { useEffect, useState, type ReactNode } from 'react';
import { icon } from '../api';

export function Segmented<T extends string | number>({ options, value, onChange, label }: {
  options: { value: T; label: ReactNode; icon?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.icon && <img src={icon(o.icon)} alt="" width={20} height={20} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({ value, onChange, step = 1, min = 0, label }: { value: number; onChange: (v: number) => void; step?: number; min?: number; label: string }) {
  return (
    <span className="stepper" aria-label={label}>
      <button type="button" aria-label={`decrease ${label}`} onClick={() => onChange(Math.max(min, value - step))}>−</button>
      <output>{value}</output>
      <button type="button" aria-label={`increase ${label}`} onClick={() => onChange(value + step)}>+</button>
    </span>
  );
}

export function Select({ label, value, onChange, options }: { label: string; value: number | string; onChange: (v: string) => void; options: { value: number | string; label: string }[] }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

const STATUS_TEXT: Record<string, string> = {
  negative: 'Negative — check deliveries', below_min: 'Below min', close_to_min: 'Close to min', plenty: 'Plenty', not_stocked: 'Not stocked',
};
export const statusText = (s: string) => STATUS_TEXT[s] ?? s;

export function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 3500);
    return () => clearTimeout(t);
  }, [message, onDone]);
  return message ? <div className="toast" role="status">{message}</div> : null;
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
  return error ? <p className="notice warn" role="alert">{error}</p> : null;
}
