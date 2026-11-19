// Instant hover / tap read-out for the Trends charts: tracks which point is under the pointer and shows
// a small panel with that point's date and numbers.
import { h, state } from './dom.js';

/**
 * Mouse: follows the pointer and hides when it leaves. Touch: a tap shows the read-out, which stays
 * until the next tap (browsers fire "leave" right after every touch).
 * `count` points spread across the width. `mode` "bars": point i covers the i-th slice;
 * "line": points sit at i / (count − 1), the nearest one wins.
 * title(i) and rows(i) → [{ label, value, color?, strong? }]; body(active) draws the chart.
 */
export function HoverArea({ id, count, mode = 'bars', height, title, rows, body, label }) {
  const [stored, setActive] = state(`hover:${id}`, null);
  const active = stored !== null && stored < count ? stored : null;
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const i = mode === 'line' ? Math.round(f * (count - 1)) : Math.min(count - 1, Math.floor(f * count));
    const next = count ? i : null;
    if (next !== active) setActive(next);
  };
  const x = active === null ? 0 : mode === 'line' ? (count > 1 ? (active / (count - 1)) * 100 : 50) : ((active + 0.5) / count) * 100;
  return h('div', {
    role: 'img', 'aria-label': label, onPointerMove: pick, onPointerDown: pick,
    onPointerLeave: (e) => e.pointerType !== 'touch' && setActive(null),
    style: { position: 'relative', height, touchAction: 'pan-y', cursor: 'crosshair' },
  },
  body(active),
  active !== null && h('div', {
    role: 'tooltip',
    style: {
      position: 'absolute', bottom: 'calc(100% + 8px)', left: `clamp(80px, ${x}%, calc(100% - 80px))`, transform: 'translateX(-50%)',
      minWidth: 150, padding: '8px 10px', background: 'var(--color-bg)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md)',
      fontSize: 13, lineHeight: 1.4, pointerEvents: 'none', zIndex: 5, whiteSpace: 'nowrap',
    },
  },
  h('div', { style: { fontWeight: 600, marginBottom: 4 } }, title(active)),
  rows(active).map((r) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
    r.color && h('span', { style: { width: 10, height: 10, borderRadius: 2, background: r.color, flex: 'none' } }),
    h('span', { style: { flex: 1, color: 'var(--color-neutral-700)' } }, r.label),
    h('span', { class: 'num', style: { fontWeight: r.strong === false ? 400 : 600 } }, r.value)))));
}

/** Vertical guide line at a horizontal position (percent). */
export const Guide = (x) => h('div', { style: { position: 'absolute', top: 0, bottom: 0, left: `${x}%`, width: 1, background: 'var(--color-neutral-500)', pointerEvents: 'none' } });
