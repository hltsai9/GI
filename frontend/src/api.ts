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

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
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

export const icon = (name?: string | null) => (name ? `/icons/${name}.svg` : undefined);

const SITE_TZ = 'America/Phoenix';
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { timeZone: SITE_TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtClock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: SITE_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtDay = (day: string) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const fmtNum = (n: number) => n.toLocaleString('en-US');
