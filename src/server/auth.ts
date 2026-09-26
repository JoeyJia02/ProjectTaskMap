import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, Request } from 'express';
import type { Config } from './config.js';

const opaque = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
export const OWNER = 'personal-owner';
export const MCP_SCOPE = 'projects:read projects:write';
export interface Principal { ownerId: string; kind: 'owner' | 'project' | 'oauth'; projectId?: string }
interface Claims { iss: string; aud: string; sub: string; kind: 'project' | 'oauth'; projectId?: string; scope: string; exp: number; iat: number }
export class AuthError extends Error { status = 401 }
export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

export class Auth {
  constructor(readonly config: Config) {}
  issue(kind: 'project' | 'oauth', projectId?: string, lifetime = 3600): string {
    const claims: Claims = { iss: this.config.publicUrl, aud: `${this.config.publicUrl}/${kind === 'oauth' ? 'mcp' : 'api'}`, sub: OWNER, kind, projectId, scope: MCP_SCOPE, iat: now(), exp: now() + lifetime };
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', this.config.signingSecret).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${signature}`;
  }
  verify(token: string, audience: 'api' | 'mcp'): Principal {
    if (audience === 'api' && safeEqual(token, this.config.ownerSecret)) return { ownerId: OWNER, kind: 'owner' };
    try {
      const [h, p, s, extra] = token.split('.');
      if (!h || !p || !s || extra) throw new Error();
      const expected = createHmac('sha256', this.config.signingSecret).update(`${h}.${p}`).digest('base64url');
      if (!safeEqual(expected, s)) throw new Error();
      const header = JSON.parse(Buffer.from(h, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Claims;
      if (header.alg !== 'HS256' || claims.iss !== this.config.publicUrl || claims.sub !== OWNER || claims.aud !== `${this.config.publicUrl}/${audience}` || !Number.isFinite(claims.exp) || claims.exp <= now() || claims.iat > now() + 30 || claims.scope !== MCP_SCOPE) throw new Error();
      if ((audience === 'mcp' && claims.kind !== 'oauth') || (audience === 'api' && (claims.kind !== 'project' || !claims.projectId))) throw new Error();
      return { ownerId: claims.sub, kind: claims.kind, projectId: claims.projectId };
    } catch { throw new AuthError('Authentication expired or invalid. Reconnect to Project Task Map.'); }
  }
  request(req: Request, audience: 'api' | 'mcp'): Principal {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ') || header.length > 8192) throw new AuthError('Bearer authentication required.');
    return this.verify(header.slice(7), audience);
  }
}

interface Client { clientId: string; redirects: string[]; created: number }
interface Intent { clientId: string; redirect: string; state: string; challenge: string; exp: number }
interface Code extends Intent { code: string }
const htmlEscape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A single-owner OAuth authorization server. Transient grants expire on restart. */
export function installOAuth(app: Express, auth: Auth): void {
  const base = auth.config.publicUrl;
  const resource = `${base}/mcp`;
  const clients = new Map<string, Client>();
  const intents = new Map<string, Intent>();
  const codes = new Map<string, Code>();
  const attempts = new Map<string, { count: number; end: number }>();
  const prune = () => {
    for (const [key, value] of intents) if (value.exp < now()) intents.delete(key);
    for (const [key, value] of codes) if (value.exp < now()) codes.delete(key);
    for (const [key, value] of attempts) if (value.end < now()) attempts.delete(key);
    for (const [key, value] of clients) if (value.created < now() - 86400) clients.delete(key);
  };
  const limit = (req: Request, bucket: string, max: number) => {
    prune();
    const key = `${bucket}:${req.ip}`;
    const old = attempts.get(key) ?? { count: 0, end: now() + 600 };
    attempts.set(key, { ...old, count: old.count + 1 });
    return old.count < max;
  };
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json({ resource, authorization_servers: [base], scopes_supported: MCP_SCOPE.split(' '), bearer_methods_supported: ['header'] }));
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: MCP_SCOPE.split(' ') }));
  app.post('/register', (req, res) => {
    if (!limit(req, 'register', 30) || clients.size >= 500) { res.status(429).json({ error: 'rate_limited' }); return; }
    const redirects = req.body?.redirect_uris;
    if (!Array.isArray(redirects) || !redirects.length || redirects.length > 8 || redirects.some(uri => {
      try { const url = new URL(uri); return typeof uri !== 'string' || uri.length > 2000 || url.hash || url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))); } catch { return true; }
    }) || (req.body.token_endpoint_auth_method && req.body.token_endpoint_auth_method !== 'none')) { res.status(400).json({ error: 'invalid_client_metadata' }); return; }
    const clientId = opaque();
    clients.set(clientId, { clientId, redirects, created: now() });
    res.status(201).json({ client_id: clientId, client_id_issued_at: now(), redirect_uris: redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] });
  });
  app.get('/authorize', (req, res) => {
    if (!limit(req, 'authorize', 40) || intents.size > 1000) { res.status(429).send('Too many requests.'); return; }
    const q = req.query;
    const client = typeof q.client_id === 'string' ? clients.get(q.client_id) : undefined;
    const requestedScopes = typeof q.scope === 'string' ? [...new Set(q.scope.split(' ').filter(Boolean))].sort().join(' ') : MCP_SCOPE;
    // This personal deployment has one complete read/write grant. Reject partial scopes instead of silently escalating them.
    if (!client || typeof q.redirect_uri !== 'string' || !client.redirects.includes(q.redirect_uri) || q.response_type !== 'code' || q.code_challenge_method !== 'S256' || typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge) || q.resource !== resource || requestedScopes !== MCP_SCOPE || (q.scope !== undefined && typeof q.scope !== 'string')) { res.status(400).send('Invalid authorization request; both projects:read and projects:write scopes are required.'); return; }
    const id = opaque();
    intents.set(id, { clientId: client.clientId, redirect: q.redirect_uri, state: typeof q.state === 'string' ? q.state : '', challenge: q.code_challenge, exp: now() + 300 });
    res.cookie('taskmap_oauth', id, { httpOnly: true, sameSite: 'lax', secure: base.startsWith('https:'), path: '/authorize', maxAge: 300000 });
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>连接 Project Task Map</title><style>body{font:16px system-ui;max-width:460px;margin:10vh auto;padding:24px;color:#202624}input,button{box-sizing:border-box;width:100%;padding:12px;margin:10px 0}button{background:#167c5b;color:white;border:0;border-radius:8px}small{overflow-wrap:anywhere}</style><h1>连接 Project Task Map</h1><p>授权此客户端读取和更新你的项目任务地图。</p><small>返回地址：${htmlEscape(q.redirect_uri)}</small><form method="post" action="/authorize"><input type="hidden" name="intent" value="${id}"><label>部署者访问密钥<input name="ownerSecret" type="password" required autocomplete="current-password"></label><button>授权连接</button></form></html>`);
  });
  app.post('/authorize', (req, res) => {
    if (!limit(req, 'login', 10)) { res.status(429).send('Too many attempts. Retry in ten minutes.'); return; }
    const id = req.body?.intent;
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('taskmap_oauth='))?.slice('taskmap_oauth='.length);
    const intent = typeof id === 'string' && cookie === id ? intents.get(id) : undefined;
    if (!intent || intent.exp < now() || typeof req.body.ownerSecret !== 'string' || !safeEqual(req.body.ownerSecret, auth.config.ownerSecret)) { res.status(401).send('Invalid or expired authorization.'); return; }
    intents.delete(id);
    const code = opaque();
    codes.set(code, { ...intent, code, exp: now() + 120 });
    const target = new URL(intent.redirect);
    target.searchParams.set('code', code);
    if (intent.state) target.searchParams.set('state', intent.state);
    res.clearCookie('taskmap_oauth', { path: '/authorize' });
    res.redirect(303, target.toString());
  });
  app.post('/token', (req, res) => {
    if (!limit(req, 'token', 80)) { res.status(429).json({ error: 'rate_limited' }); return; }
    const b = req.body ?? {};
    const code = typeof b.code === 'string' ? codes.get(b.code) : undefined;
    if (b.grant_type !== 'authorization_code' || !code || code.exp < now() || b.client_id !== code.clientId || b.redirect_uri !== code.redirect || b.resource !== resource || typeof b.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(b.code_verifier) || !safeEqual(createHash('sha256').update(b.code_verifier).digest('base64url'), code.challenge)) { res.status(400).json({ error: 'invalid_grant' }); return; }
    codes.delete(b.code);
    res.json({ access_token: auth.issue('oauth'), token_type: 'Bearer', expires_in: 3600, scope: MCP_SCOPE });
  });
}
