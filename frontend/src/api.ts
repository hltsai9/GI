// Thin client for the GI API. In development the signed-in user is chosen with X-Dev-User.
const USER_KEY = 'gi.devUser';

export function devUser(): string {
  try {
    return localStorage.getItem(USER_KEY) ?? 'dev-lead';
  } catch {
    return 'dev-lead';
  }
}

export function setDevUser(s: string) {
  try {
    localStorage.setItem(USER_KEY, s);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Static demo build (GitHub Pages): reads recorded API responses; nothing can be changed. */
export const DEMO = import.meta.env.VITE_DEMO === 'true';
export const BASE = import.meta.env.BASE_URL;

/** File name of a recorded response; must match backend/src/cli/exportDemo.ts. */
export const demoFile = (path: string) => path.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '_') + '.json';

export async function demoFetch(path: string): Promise<Response> {
  return fetch(`${BASE}demo-data/${demoFile(path)}`);
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  if (DEMO) {
    if ((init.method ?? 'GET') !== 'GET') throw new ApiError(403, 'This is a read-only demo with mock data — changes are not saved.');
    const res = await demoFetch(path);
    if (!res.ok) throw new ApiError(404, `Not available in the demo (${path})`);
    return (await res.json()) as T;
  }
  const headers: Record<string, string> = { 'X-Dev-User': devUser(), ...(init.headers as Record<string, string>) };
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`/api${path}`, { ...init, headers, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

export interface Meta {
  types: { id: number; code: string; name: string; plural: string; icon: string }[];
  colors: { id: number; name: string; active: number }[];
  sizes: { id: number; code: string; active: number }[];
  locations: { id: number; code: string; name: string }[];
}

export interface Me {
  id: number;
  name: string;
  role: 'floor' | 'lead' | 'viewer' | 'admin';
}

export const icon = (name?: string | null) => (name ? `${import.meta.env.BASE_URL}icons/${name}.svg` : undefined);

const SITE_TZ = 'America/Phoenix';
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { timeZone: SITE_TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtClock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: SITE_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtDay = (day: string) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const fmtNum = (n: number) => n.toLocaleString('en-US');
