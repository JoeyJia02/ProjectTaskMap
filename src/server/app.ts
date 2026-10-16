import express, { type NextFunction, type Request, type Response } from 'express';
import { resolve } from 'node:path';
import { ZodError, z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ProjectStore, StoreError } from '../store/index.js';
import { bindSchema, deltaSchema, assessmentSchema, overviewSchema } from '../domain/schema.js';
import { renderMarkdown, renderHtml } from '../artifacts/index.js';
import { Auth, AuthError, installOAuth, type Principal } from './auth.js';
import type { Config } from './config.js';
import { createMcpServer } from './mcp.js';
import { OAuthStore } from './oauth-store.js';

export function createApp(config: Config, store = new ProjectStore(config.dbPath)) {
  const app = express();
  const oauth = new OAuthStore(config);
  const auth = new Auth(config, oauth);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    const origin = req.get('origin');
    if (origin && !config.allowedOrigins.includes(origin)) { res.status(403).json({ error: 'Origin is not allowed.' }); return; }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Session-Id');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    if (req.method === 'POST' && (req.path.startsWith('/api/') || req.path === '/register') && !req.is('application/json')) { res.status(415).json({ error: 'Use application/json.' }); return; }
    next();
  });
  // Hosts can probe without a JSON body before OAuth. Challenge first, before
  // media-type checks or parsing, so discovery never depends on a valid payload.
  app.post('/mcp', (req, res, next) => {
    try {
      res.locals.mcpPrincipal = auth.request(req, 'mcp');
      if (!req.is('application/json')) { res.status(415).json({ error: 'Use application/json.' }); return; }
      next();
    } catch (error) { next(error); }
  });
  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));
  installOAuth(app, auth, oauth);
  app.get('/health', (_req, res) => res.json({ ok: true, version: '0.1.0' }));
  app.use('/api', (req, res, next) => { try { res.locals.principal = auth.request(req, 'api'); next(); } catch (e) { next(e); } });
  app.post('/api/bind', (req, res) => {
    const p = res.locals.principal as Principal;
    if (p.kind !== 'owner') { res.status(403).json({ error: 'Binding requires owner authentication.' }); return; }
    const bound = store.bind(p.ownerId, bindSchema.parse(req.body));
    res.json({ ...bound, projectToken: auth.issue('project', bound.state.projectId), apiBaseUrl: config.publicUrl });
  });
  app.use('/api/projects/:id', (req, res, next) => {
    const p = res.locals.principal as Principal;
    if (p.projectId && p.projectId !== req.params.id) { res.status(403).json({ error: 'Project scope mismatch.' }); return; }
    try { store.get(p.ownerId, String(req.params.id)); next(); } catch (e) { next(e); }
  });
  const owner = (res: Response) => (res.locals.principal as Principal).ownerId;
  const pathId = (req: Request) => String(req.params.id);
  const sameProject = (req: Request) => { if (req.body?.projectId !== pathId(req)) throw Object.assign(new Error('Route and body projectId must match.'), { status: 400 }); };
  app.get('/api/projects/:id', (req, res) => res.json({ state: store.get(owner(res), pathId(req)) }));
  app.post('/api/projects/:id/deltas', (req, res) => { sameProject(req); res.json(store.apply(owner(res), deltaSchema.parse({ ...req.body, source: 'ai' }))); });
  app.post('/api/projects/:id/manual', (req, res) => { sameProject(req); res.json(store.apply(owner(res), deltaSchema.parse({ ...req.body, source: 'manual', confidence: 1 }))); });
  app.post('/api/projects/:id/turns', (req, res) => { sameProject(req); res.json(store.assess(owner(res), assessmentSchema.parse(req.body))); });
  app.post('/api/projects/:id/reconcile', (req, res) => { sameProject(req); res.json(store.reconcile(owner(res), overviewSchema.parse(req.body))); });
  app.get('/api/projects/:id/history', (req, res) => res.json({ history: store.history(owner(res), pathId(req)) }));
  app.get('/api/projects/:id/conflicts', (req, res) => res.json({ conflicts: store.conflicts(owner(res), pathId(req)) }));
  app.post('/api/projects/:id/reviews/:conflictId', (req, res) => {
    const b = z.object({ action: z.enum(['approve', 'reject']), expectedVersion: z.number().int().nonnegative() }).strict().parse(req.body);
    res.json(store.review(owner(res), pathId(req), String(req.params.conflictId), b.action, b.expectedVersion));
  });
  app.post('/api/projects/:id/rollback', (req, res) => {
    const b = z.object({ targetVersion: z.number().int().nonnegative(), expectedVersion: z.number().int().nonnegative() }).strict().parse(req.body);
    res.json(store.rollback(owner(res), pathId(req), b.targetVersion, b.expectedVersion));
  });
  app.get('/api/projects/:id/artifact.md', (req, res) => res.type('text/markdown').attachment('task-map.md').send(renderMarkdown(store.get(owner(res), pathId(req)))));
  app.get('/api/projects/:id/artifact.html', (req, res) => res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'").type('html').attachment('task-map.html').send(renderHtml(store.get(owner(res), pathId(req)))));
  app.post('/mcp', async (req, res, next) => {
    try {
      const principal = res.locals.mcpPrincipal as Principal;
      const server = createMcpServer(store, auth, principal);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) { next(e); }
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Stateless streamable HTTP: POST only.' }));
  app.use(express.static(resolve('dist/ui'), { etag: false, maxAge: 0 }));
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof AuthError) { res.set('WWW-Authenticate', `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`).status(401).json({ error: err.message }); return; }
    if (err instanceof ZodError) { res.status(400).json({ error: 'Invalid request.', issues: err.issues }); return; }
    if (err instanceof StoreError) { res.status((err as StoreError & { status?: number }).status ?? 400).json({ error: err.message }); return; }
    const e = err as { status?: number; message?: string };
    const status = typeof e.status === 'number' && e.status >= 400 && e.status < 500 ? e.status : 500;
    // No request bodies, credentials, or stack traces in the response/log.
    if (status === 500) console.error(`Unhandled request failure: ${req.method} ${req.path}`);
    res.status(status).json({ error: status === 500 ? 'Internal server error.' : e.message ?? 'Request failed.' });
  });
  const close = () => { oauth.close(); store.close(); };
  return { app, store, auth, oauth, close };
}
