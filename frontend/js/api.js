// Thin client for the GI API. In development the signed-in user is chosen with X-Dev-User.
import { setFetcher } from './dom.js';

const USER_KEY = 'gi.devUser';
const ADMIN_TOKEN_KEY = 'gi.adminToken'; // from the admin passcode (dev sign-in)

function adminToken() {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(t) {
  try {
    if (t) localStorage.setItem(ADMIN_TOKEN_KEY, t);
    else localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function devUser() {
  try {
    return localStorage.getItem(USER_KEY) ?? 'dev-lead';
  } catch {
    return 'dev-lead';
  }
}

export function setDevUser(s) {
  try {
    localStorage.setItem(USER_KEY, s);
  } catch {
    /* ignore */
  }
}

/** Demo build (GitHub Pages): reads recorded API responses; nothing can be changed. Set in config.js. */
export const DEMO = !!(window.GI_CONFIG && window.GI_CONFIG.demo);

/** File name of a recorded response; must match backend/gi/cli/export_demo.py. */
export const demoFile = (path) => path.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '_') + '.json';

/** Paths are relative to the page, so the app also works under a sub-path (e.g. /GI/ on GitHub Pages). */
export const demoFetch = (path) => fetch(`demo-data/${demoFile(path)}`);

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data; // the error response, e.g. { error, problems } from a CSV upload
  }
}

/** The test users (backend/db/seed/dev-users.sql). In the demo, choosing one only changes what the screens allow. */
export const DEV_USERS = [
  { value: 'dev-floor', label: 'Floor staff', user: { id: 1, name: 'Dana (floor staff)', role: 'floor' } },
  { value: 'dev-lead', label: 'Cleanroom lead', user: { id: 2, name: 'Lee (cleanroom lead)', role: 'lead' } },
  { value: 'dev-admin', label: 'Admin', locked: true, user: { id: 3, name: 'Avery (admin)', role: 'admin' } },
  { value: 'dev-viewer', label: 'Viewer', user: { id: 4, name: 'Vic (viewer)', role: 'viewer' } },
];

export async function api(path, init = {}) {
  if (DEMO) {
    if ((init.method ?? 'GET') !== 'GET') throw new ApiError(403, 'This is a read-only demo with mock data — changes are not saved.');
    if (path === '/me') return (DEV_USERS.find((u) => u.value === devUser()) ?? DEV_USERS[1]).user;
    const res = await demoFetch(path);
    if (!res.ok) throw new ApiError(404, `Not available in the demo (${path})`);
    return res.json();
  }
  const headers = { ...authHeaders(), ...(init.headers || {}) };
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`api${path}`, { ...init, headers, body });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (res.status === 401 && devUser() === 'dev-admin') lockAdmin(); // passcode token missing or expired
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data);
  return data;
}

setFetcher((path) => api(path));

export function authHeaders() {
  const h = { 'X-Dev-User': devUser() };
  const t = devUser() === 'dev-admin' && adminToken();
  if (t) h['X-Admin-Token'] = t;
  return h;
}

/** Checks the admin passcode; on success the page may act as the dev admin. The demo accepts any passcode. */
export async function unlockAdmin(passcode) {
  if (DEMO) {
    setAdminToken('demo');
    return;
  }
  const r = await api('/dev/admin-unlock', { method: 'POST', json: { passcode } });
  setAdminToken(r.token);
}

/** Back to the cleanroom lead when the admin token is missing or expired. */
function lockAdmin() {
  setAdminToken(null);
  setDevUser('dev-lead');
  location.reload();
}

/** Sends a file as the request body and reports upload progress (0–1); fetch() cannot report it, XMLHttpRequest can. */
export function apiUpload(path, file, headers, onProgress) {
  if (DEMO) return Promise.reject(new ApiError(403, 'This is a read-only demo with mock data — changes are not saved.'));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `api${path}`);
    for (const [k, v] of Object.entries({ ...authHeaders(), ...headers })) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error ?? xhr.statusText, data));
    };
    xhr.onerror = () => reject(new ApiError(0, 'The upload failed: the connection was interrupted.'));
    xhr.send(file);
  });
}

/** A random key for Idempotency-Key; crypto.randomUUID needs HTTPS, so fall back on plain HTTP. */
export const newKey = () =>
  (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

// Absolute URL: a relative url() inside a CSS variable would resolve against the stylesheet, not the page.
export const icon = (name) => (name ? new URL(`icons/${name}.svg`, document.baseURI).href : undefined);

const SITE_TZ = 'America/Phoenix';
export const fmtClock = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: SITE_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
/** "Thu 12 Nov" for a YYYY-MM-DD day. */
export const fmtDayLong = (day) => {
  const d = new Date(day + 'T12:00:00Z');
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${d.getUTCDate()} ${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
};
export const fmtDay = (day) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const fmtNum = (n) => Number(n).toLocaleString('en-US');
/** "Thu 19 Nov" in site time, as in the mockup kickers. */
export const fmtToday = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: SITE_TZ, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`;
};
/** "Fri 2 Oct, 06:40" in site time. */
export const fmtWhen = (iso) => `${fmtToday(new Date(iso))}, ${fmtClock(iso)}`;
