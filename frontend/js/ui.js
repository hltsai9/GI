// Components matching design/mockups/Garment Inventory App.dc.html, built on broadsheet.css.
import { h, state } from './dom.js';
import { icon } from './api.js';
import { ph } from './icons.js';

/** Page title block: small accent kicker above the title. */
export const PageHead = ({ kicker, title }) => h('div', { class: 'p-head' }, h('div', { class: 'kicker' }, kicker), h('h3', null, title));

/** Full-width segmented control (Broadsheet .seg / .seg-opt). Values may be numbers or strings. */
export function Seg({ options, value, onChange, label, style, optStyle }) {
  const name = `seg-${label.replace(/\W+/g, '-')}`;
  return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label, style },
    options.map((o) => h('label', { class: 'seg-opt', style: optStyle },
      h('input', { type: 'radio', name, checked: o.value === value, onChange: () => onChange(o.value) }),
      o.icon && GIcon({ name: o.icon, size: 16 }),
      o.label)));
}

/** Garment icon tinted with the current color (CSS mask over the SVG). */
export function GIcon({ name, size = 28, color }) {
  if (!name) return h('span', { style: { width: size, height: size, flex: 'none' } });
  return h('span', { class: 'gicon', 'aria-hidden': 'true', style: { width: size, height: size, color, '--src': `url(${icon(name)})` } });
}

/** Dropdown with the label inside the box, as in the mockup. `id` tells apart several with the same label. */
export function Dropdown({ label, value, options, onChange, id = '' }) {
  const [open, setOpen] = state(`dd:${label}:${id}`, false);
  const cur = options.find((o) => o.value === value);
  return h('div', { class: 'dd' },
    h('button', { type: 'button', class: 'dd-btn', 'aria-haspopup': 'listbox', 'aria-expanded': String(open), onClick: () => setOpen(!open) },
      h('span', { class: 'dd-label' }, label),
      cur?.label ?? '—',
      h('span', { class: 'dd-caret' }, ph(open ? 'caretUp' : 'caretDown', 16))),
    open && [
      h('div', { class: 'dd-scrim', onClick: () => setOpen(false) }),
      h('div', { class: 'dd-menu', role: 'listbox', 'aria-label': label },
        options.map((o) => h('button', { type: 'button', role: 'option', 'aria-selected': String(o.value === value), onClick: () => { setOpen(false); onChange(o.value); } },
          o.icon && GIcon({ name: o.icon, size: 22 }),
          h('span', { style: { flex: 1 } }, o.label),
          o.trailing,
          o.value === value && ph('check', 16, 'var(--color-accent-700)')))),
    ]);
}

/** Number field with the label inside the box. */
export const QtyField = ({ label, value, onChange, placeholder, id }) =>
  h('label', { class: 'qty' },
    h('span', { class: 'dd-label' }, label),
    h('input', { id, inputmode: 'numeric', value, placeholder, onInput: (e) => onChange(e.target.value.replace(/\D/g, '')) }));

export const Stepper = ({ value, onChange, step = 1, min = 0, label, size = 17, width = 40 }) => [
  h('button', { type: 'button', class: 'btn btn-secondary btn-icon stepbtn', 'aria-label': `decrease ${label}`, onClick: () => onChange(Math.max(min, value - step)) }, '−'),
  h('span', { class: 'num', style: { width, textAlign: 'center', fontSize: size, fontWeight: 600 } }, value),
  h('button', { type: 'button', class: 'btn btn-secondary btn-icon stepbtn', 'aria-label': `increase ${label}`, onClick: () => onChange(value + step) }, '+'),
];

/** "Posted · 205 items added" style confirmation (mockup tag + text). */
export const Msg = ({ tag, text, tone = 'accent' }) => h('div', { class: 'msg' }, h('span', { class: `tag tag-${tone}` }, tag), h('span', null, text));

export const Warn = (...children) => h('div', { class: 'warn' }, ph('warning', 20), h('span', null, children));

export const ErrorNote = (error) => (error ? h('div', { role: 'alert' }, Warn(error)) : null);

const STATUS_TEXT = {
  negative: 'Negative — check deliveries', below_min: 'Below minimum', close_to_min: 'Close to minimum', plenty: 'OK', not_stocked: 'Not stocked — set a minimum to start',
};
export const statusText = (s) => STATUS_TEXT[s] ?? s;

/** Cell colors from the mockup grid. */
export function cellColors(status) {
  if (status === 'negative' || status === 'below_min') return { bg: 'var(--color-accent-2-200)', fg: 'var(--color-accent-2-800)' };
  if (status === 'close_to_min') return { bg: 'var(--color-neutral-200)', fg: 'var(--color-neutral-800)' };
  if (status === 'plenty') return { bg: 'var(--color-accent-100)', fg: 'var(--color-accent-800)' };
  return { bg: 'transparent', fg: 'var(--color-neutral-500)' };
}

/** Runs an async action, reporting its error in the named error slot. */
export async function attempt(errKey, fn) {
  const [, setErr] = state(`err:${errKey}`, null);
  setErr(null);
  try {
    return await fn();
  } catch (e) {
    setErr(e.message);
    return undefined;
  }
}
export const errorOf = (errKey) => state(`err:${errKey}`, null)[0];

/** True on the phone layout (set on <html> by app.js from the device type or the user's choice). */
export const isPhone = () => document.documentElement.dataset.device === 'phone';

/** Grid without the colors and sizes that have nothing in them (`used(cell)` false for every cell), unless
 * showAll. Cells are in the same order as data.colors. Returns { colors, rows, hidden }. */
export function trimGrid(data, used, showAll) {
  const keep = data.colors.map((_, i) => showAll || data.rows.some((r) => used(r.cells[i])));
  const rows = data.rows.filter((r) => showAll || r.cells.some(used)).map((r) => ({ ...r, cells: r.cells.filter((_, i) => keep[i]) }));
  const colors = data.colors.filter((_, i) => keep[i]);
  return { colors, rows, hidden: data.colors.length - colors.length + data.rows.length - rows.length };
}

/** Column names over a size × color grid: full names, wrapping when narrow (never cut off). */
export const GridHead = (colors, cols) => h('div', { class: 'grid-head', style: { gridTemplateColumns: cols } },
  h('span'), colors.map((c) => h('span', null, c.name)));

/** "Show all sizes and colors" switch under a trimmed grid. */
export const ShowAll = (hidden, showAll, setShowAll) => (hidden || showAll) && h('button', {
  type: 'button', class: 'btn btn-ghost', style: { minHeight: 44, alignSelf: 'flex-start', padding: '0 4px' }, onClick: () => setShowAll(!showAll),
}, showAll ? 'Hide empty sizes and colors' : `Show all sizes and colors (${hidden} hidden)`);

/** Stock state as a mark, so it does not depend on color alone. */
export const stateMark = (status) => (status === 'negative' || status === 'below_min' ? '▼' : status === 'close_to_min' ? '▽' : '');

/** Panel that slides up from the bottom of the screen (phone); `onClose` on the scrim, the × or Escape. */
export function Sheet({ title, onClose, children }) {
  return [
    h('div', { class: 'sheet-scrim', onClick: onClose }),
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onKeyDown: (e) => e.key === 'Escape' && onClose() },
      h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('h4', { style: { margin: 0, flex: 1 } }, title),
        h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': 'Close', onClick: onClose, style: { minWidth: 44, minHeight: 44 } }, ph('x', 20))),
      children),
  ];
}

/** Help text folded away behind "How this works" (it stays open while the page updates). */
export const Help = (...children) => HelpAs('How this works', ...children);
export const HelpAs = (summary, ...children) => h('details', { class: 'help' }, h('summary', null, summary), h('div', { class: 'note' }, children));
