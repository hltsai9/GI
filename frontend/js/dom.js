// A very small view layer, so the app needs no framework and no build step.
//   h(tag, props, ...children) describes an element; render(tree, root) makes the page match it,
//   reusing the elements already there (so an input keeps its focus while you type).
//   update() re-renders the whole app right after the current event; state(), load() and flash() hold the data.

const SVG_NS = 'http://www.w3.org/2000/svg';
const UNITLESS = new Set(['flex', 'flexGrow', 'flexShrink', 'opacity', 'fontWeight', 'lineHeight', 'zIndex', 'order']);

export function h(tag, props, ...children) {
  return { tag, props: props || {}, children: flatten(children) };
}

function flatten(list, out = []) {
  for (const c of list) {
    if (Array.isArray(c)) flatten(c, out);
    else if (c === null || c === undefined || c === false || c === true || c === '') continue;
    else if (typeof c === 'object') out.push(c);
    else out.push({ text: String(c) });
  }
  return out;
}

function styleText(s) {
  if (!s) return '';
  if (typeof s === 'string') return s;
  let css = '';
  for (const [k, v] of Object.entries(s)) {
    if (v === null || v === undefined || v === false) continue;
    const prop = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    css += `${prop}:${typeof v === 'number' && !UNITLESS.has(k) ? v + 'px' : v};`;
  }
  return css;
}

function setProps(el, props, old) {
  for (const k of Object.keys(old)) {
    if (k in props) continue;
    if (k.startsWith('on')) el[k.toLowerCase()] = null;
    else if (k === 'style') { el.removeAttribute('style'); el._css = ''; }
    else if (k === 'class') el.removeAttribute('class');
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = k === 'value' ? '' : false;
    else el.removeAttribute(k);
  }
  for (const [k, v] of Object.entries(props)) {
    if (k === 'key') continue;
    // Handlers are wrapped so their return value is ignored: a DOM handler returning false would cancel the
    // browser's default action (e.g. typing a character when an onKeyDown check returns false).
    if (k.startsWith('on')) el[k.toLowerCase()] = v ? (e) => { v(e); } : null;
    else if (k === 'style') {
      const css = styleText(v);
      if (el._css !== css) { el.style.cssText = css; el._css = css; }
    } else if (k === 'value') {
      if (el.value !== String(v ?? '')) el.value = v ?? '';
    } else if (k === 'checked' || k === 'disabled') el[k] = !!v;
    else if (v === null || v === undefined || v === false) el.removeAttribute(k);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function create(v, svg) {
  if (v.text !== undefined) return document.createTextNode(v.text);
  const isSvg = svg || v.tag === 'svg';
  const el = isSvg ? document.createElementNS(SVG_NS, v.tag) : document.createElement(v.tag);
  setProps(el, v.props, {});
  el._props = v.props;
  patchChildren(el, v.children, isSvg);
  return el;
}

function patch(el, v, svg) {
  if (v.text !== undefined) {
    if (el.nodeType === 3) { if (el.data !== v.text) el.data = v.text; return el; }
  } else if (el.nodeType === 1 && el.localName === v.tag) {
    setProps(el, v.props, el._props || {});
    el._props = v.props;
    patchChildren(el, v.children, svg || v.tag === 'svg');
    return el;
  }
  const fresh = create(v, svg);
  el.replaceWith(fresh);
  return fresh;
}

function patchChildren(parent, vs, svg) {
  const kids = parent.childNodes;
  for (let i = 0; i < vs.length; i++) {
    if (i < kids.length) patch(kids[i], vs[i], svg);
    else parent.appendChild(create(vs[i], svg));
  }
  while (kids.length > vs.length) parent.removeChild(parent.lastChild);
}

let root = null;
let rootView = null;
let queued = false;

/** Renders view() into the element now and after every update(). */
export function mount(el, view) {
  root = el;
  rootView = view;
  draw();
}

function draw() {
  queued = false;
  patchChildren(root, flatten([rootView()]), false);
}

/** Re-renders once the current event handler has finished, before the browser handles the next event,
 *  so every handler always sees the state left by the previous one. */
export function update() {
  if (queued || !root) return;
  queued = true;
  queueMicrotask(draw);
}

// ---- state that survives re-renders, by name
const states = new Map();
export function state(key, initial) {
  if (!states.has(key)) states.set(key, typeof initial === 'function' ? initial() : initial);
  return [states.get(key), (v) => { states.set(key, typeof v === 'function' ? v(states.get(key)) : v); update(); }];
}
export function clearState(prefix) {
  for (const k of [...states.keys()]) if (k.startsWith(prefix)) states.delete(k);
}

/** A confirmation message that clears itself after a few seconds. */
const timers = new Map();
export function flash(key) {
  const [msg, set] = state(`flash:${key}`, null);
  return [msg, (m) => {
    clearTimeout(timers.get(key));
    set(m);
    if (m) timers.set(key, setTimeout(() => set(null), 6000));
  }];
}

// ---- data loaded from the API, cached by path. While a path reloads, the old data stays on screen.
const cache = new Map(); // path → { data, error, loading, stale }
const lastBySlot = new Map();
let fetcher = null;
export function setFetcher(fn) { fetcher = fn; }

/** Returns { data, error } for an API path, starting the request the first time. `slot` keeps the
 *  previous path's data on screen while a new path (e.g. another garment type) loads. */
export function load(path, slot) {
  let e = cache.get(path);
  if (!e || (e.stale && !e.loading)) {
    e = { data: e?.data, error: null, loading: true, stale: false };
    cache.set(path, e);
    const entry = e;
    fetcher(path)
      .then((d) => { entry.data = d; entry.error = null; })
      .catch((err) => { entry.error = String(err.message || err); })
      .finally(() => { entry.loading = false; update(); });
  }
  if (slot) {
    if (e.data !== undefined) lastBySlot.set(slot, e.data);
    return { data: e.data ?? lastBySlot.get(slot), error: e.error };
  }
  return { data: e.data, error: e.error };
}

/** Marks cached paths starting with the prefix for reloading (they refresh on the next render). */
export function reload(...prefixes) {
  for (const [k, e] of cache) if (prefixes.some((p) => k.startsWith(p))) e.stale = true;
  update();
}
export function clearCache() {
  cache.clear();
  lastBySlot.clear();
}
