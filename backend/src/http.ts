import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { getPool, one } from './db.js';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export type Role = 'floor' | 'lead' | 'viewer' | 'admin';
export interface User {
  id: number;
  name: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

/**
 * Resolves the signed-in user. Company SSO (OIDC) is not wired yet; in development the
 * X-Dev-User header names a seeded user (DEV_AUTH=true).
 */
export async function authenticate(req: FastifyRequest): Promise<void> {
  if (!config.DEV_AUTH) throw new HttpError(401, 'SSO sign-in is not configured yet (set DEV_AUTH=true for development)');
  const subject = (req.headers['x-dev-user'] as string | undefined) ?? 'dev-lead';
  const u = await one<User>(getPool(), 'SELECT id, name, role FROM app_user WHERE sso_subject = ? AND active', [subject]);
  if (!u) throw new HttpError(401, `unknown user ${subject}`);
  req.user = u;
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) throw new HttpError(401, 'not signed in');
    if (req.user.role !== 'admin' && !roles.includes(req.user.role)) {
      throw new HttpError(403, `needs role ${roles.join(' or ')}`);
    }
  };
}
