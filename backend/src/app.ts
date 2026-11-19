import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { ZodError, z } from 'zod';
import { dbReachable, exec, getPool, rows, withNamedLock } from './db.js';
import { authenticate, HttpError, requireRole } from './http.js';
import { getIssueSource } from './import/index.js';
import { poll, sweep, syncStatus } from './import/importer.js';
import { invariantViolations } from './ledger.js';
import * as deliveries from './services/deliveries.js';
import * as counts from './services/counts.js';
import * as stock from './services/stock.js';
import * as trends from './services/trends.js';
import * as settings from './services/settings.js';
import { fromDb } from './time.js';

const id = z.coerce.number().int().positive();
const daysQ = z.coerce.number().int().min(1).max(366).default(14);

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const db = getPool();
  const lead = requireRole('lead');
  const floorOrLead = requireRole('floor', 'lead');
  const admin = requireRole('admin');

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'invalid request', issues: err.issues });
    app.log.error(err);
    return reply.status(500).send({ error: 'internal error' });
  });

  // Readiness: only send traffic to an instance that can reach the database.
  app.get('/api/health', async (_req, reply) => ((await dbReachable()) ? { ok: true } : reply.status(503).send({ ok: false, error: 'database unreachable' })));
  // Liveness: the process is up (does not depend on the database, so a database blip restarts nothing).
  app.get('/healthz', async () => 'ok\n');

  // One-image deployment: the backend also serves the built web page (STATIC_DIR).
  if (config.STATIC_DIR && existsSync(resolve(config.STATIC_DIR, 'index.html'))) {
    const root = resolve(config.STATIC_DIR);
    app.register(fastifyStatic, {
      root,
      wildcard: false,
      cacheControl: false, // set below instead of the plugin's max-age=0
      setHeaders: (res, path) => {
        // Built assets have content hashes in their names; index.html must never be cached.
        res.setHeader('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html', root); // single-page app
      }
      return reply.status(404).send({ error: 'not found' });
    });
  }
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/') && req.url !== '/api/health') await authenticate(req);
  });

  app.get('/api/me', async (req) => req.user);
  app.get('/api/meta', async () => settings.meta(db));

  // ---- Receive
  app.post('/api/deliveries', { preHandler: floorOrLead }, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) throw new HttpError(400, 'Idempotency-Key header is required');
    const r = await deliveries.postDelivery(deliveries.deliveryInput.parse(req.body), key, req.user!.id);
    return reply.status(r.duplicate ? 200 : 201).send(r);
  });
  app.get('/api/deliveries', async (req) => deliveries.listDeliveries(db, z.coerce.number().int().min(1).max(100).default(20).parse((req.query as Record<string, unknown>).limit)));
  app.post('/api/deliveries/:id/correction', { preHandler: floorOrLead }, async (req) =>
    deliveries.correctDelivery(id.parse((req.params as Record<string, unknown>).id), deliveries.correctionInput.parse(req.body), req.user!.id));

  // ---- Stock
  app.get('/api/stock/summary', async () => ({ ...(await stock.stockSummary(db)), sync: await syncStatus() }));
  app.get('/api/stock/grid', async (req) => {
    const q = z.object({ garmentTypeId: id, locationId: id }).parse(req.query);
    return stock.stockGrid(db, q.garmentTypeId, q.locationId);
  });
  app.get('/api/stock/items/:id', async (req) => stock.stockItemDetail(db, id.parse((req.params as Record<string, unknown>).id)));
  app.patch('/api/stock/items/:id/min', { preHandler: lead }, async (req) => {
    const body = z.object({ min: z.number().int().min(1).nullable() }).parse(req.body);
    return stock.setMinimum(db, id.parse((req.params as Record<string, unknown>).id), body.min, req.user!.id);
  });

  // ---- Counts and corrections
  app.get('/api/starting-counts', async () => counts.startingCounts(db));
  app.post('/api/starting-counts', { preHandler: lead }, async (req, reply) =>
    reply.status(201).send(await counts.saveStartingCount(counts.startingCountInput.parse(req.body), req.user!.id)));
  app.get('/api/corrections', async () => counts.listCorrections(db));
  app.post('/api/corrections', { preHandler: lead }, async (req, reply) =>
    reply.status(201).send(await counts.saveCorrection(counts.correctionInput.parse(req.body), req.user!.id)));

  // ---- Trends
  app.get('/api/trends/delivered', async (req) => {
    const q = z.object({ days: daysQ, per: z.enum(['day', 'week', 'month']).default('day') }).parse(req.query);
    return trends.delivered(db, q.days, q.per);
  });
  app.get('/api/trends/issued', async (req) => trends.issued(db, z.object({ days: daysQ }).parse(req.query).days));
  app.get('/api/trends/stock', async (req) => trends.stockOverTime(db, z.object({ days: daysQ }).parse(req.query).days));
  app.get('/api/trends/breakdown', async (req) => {
    const q = z.object({ days: daysQ, metric: z.enum(['issued', 'delivered']).default('issued') }).parse(req.query);
    return trends.breakdown(db, q.days, q.metric);
  });

  // ---- Settings
  for (const kind of ['color', 'size'] as const) {
    app.post(`/api/${kind}s`, { preHandler: lead }, async (req, reply) =>
      reply.status(201).send(await settings.addValue(kind, z.object({ value: z.string() }).parse(req.body).value, req.user!.id)));
    app.post(`/api/${kind}s/:id/hide`, { preHandler: lead }, async (req) => settings.setActive(kind, id.parse((req.params as Record<string, unknown>).id), false, req.user!.id));
    app.post(`/api/${kind}s/:id/restore`, { preHandler: lead }, async (req) => settings.setActive(kind, id.parse((req.params as Record<string, unknown>).id), true, req.user!.id));
  }
  app.put('/api/sizes/order', { preHandler: lead }, async (req) => settings.reorderSizes(z.object({ ids: z.array(id) }).parse(req.body).ids, req.user!.id));

  app.get('/api/oracle-values', async () => settings.oracleValues(db));
  app.put('/api/oracle-values/:id', { preHandler: lead }, async (req) =>
    settings.setMapping(id.parse((req.params as Record<string, unknown>).id), settings.mappingInput.parse(req.body), req.user!.id));
  app.get('/api/data-quality', async (req) => settings.dataQuality(db, z.object({ days: daysQ }).parse(req.query).days));
  app.get('/api/data-quality/unregistered.csv', async (_req, reply) => {
    const list = await settings.unregisteredBarcodes(db);
    const csv = ['barcode,times_issued,first_seen,last_seen,locations', ...list.map((b) => `${b.barcode},${b.times},${b.first_seen},${b.last_seen},"${b.locations}"`)].join('\n');
    return reply.header('content-type', 'text/csv').header('content-disposition', 'attachment; filename="unregistered-barcodes.csv"').send(csv);
  });

  // ---- Import status and admin
  app.get('/api/sync/status', async () => syncStatus());
  app.get('/api/sync/runs', async () => {
    const rs = await rows<Record<string, unknown> & { started_at: string; finished_at: string | null }>(db, 'SELECT * FROM sync_run ORDER BY id DESC LIMIT 20');
    return rs.map((r) => ({ ...r, started_at: fromDb(r.started_at).toISOString(), finished_at: r.finished_at ? fromDb(r.finished_at).toISOString() : null }));
  });
  const locked = async <T>(fn: () => Promise<T>) => {
    const r = await withNamedLock('import', fn);
    if (!r.ran) throw new HttpError(409, 'an import is running right now; try again in a minute');
    return r.result;
  };
  app.post('/api/sync/run', { preHandler: admin }, async () => locked(async () => poll(await getIssueSource())));
  app.post('/api/sync/sweep', { preHandler: admin }, async () => locked(async () => sweep(await getIssueSource())));
  app.get('/api/alerts', async () => {
    const rs = await rows<Record<string, unknown> & { at: string }>(db, 'SELECT id, at, kind, message, details, acknowledged_at FROM admin_alert ORDER BY id DESC LIMIT 50');
    return rs.map((r) => ({ ...r, at: fromDb(r.at).toISOString() }));
  });
  app.post('/api/alerts/:id/ack', { preHandler: admin }, async (req) => {
    await exec(db, 'UPDATE admin_alert SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?', [req.user!.id, new Date(), id.parse((req.params as Record<string, unknown>).id)]);
    return { ok: true };
  });
  app.get('/api/admin/ledger-check', { preHandler: admin }, async () => ({ violations: await invariantViolations(db) }));

  return app;
}
