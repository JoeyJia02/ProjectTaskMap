import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, Request } from 'express';
import type { Config } from './config.js';
import { OAuthStore, type RefreshGrant } from './oauth-store.js';

const opaque = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
export const OWNER = 'personal-owner';
export const MCP_SCOPE = 'projects:read projects:write';
export interface Principal { ownerId: string; kind: 'owner' | 'project' | 'oauth'; projectId?: string; familyId?: string }
interface Claims { iss: string; aud: string; sub: string; kind: 'project' | 'oauth'; projectId?: string; familyId?: string; scope: string; exp: number; iat: number }
export class AuthError extends Error { status = 401 }
export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

export class Auth {
  constructor(readonly config: Config, private readonly oauth?: OAuthStore) {}
  issue(kind: 'project' | 'oauth', projectId?: string, lifetime = 3600, familyId?: string): string {
    const claims: Claims = { iss: this.config.publicUrl, aud: `${this.config.publicUrl}/${kind === 'oauth' ? 'mcp' : 'api'}`, sub: OWNER, kind, projectId, familyId, scope: MCP_SCOPE, iat: now(), exp: now() + lifetime };
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', this.config.signingSecret).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${signature}`;
  }
  verify(token: string, audience: 'api' | 'mcp'): Principal {
    return this.verifyClaims(token, audience, false);
  }
  /** An authenticated MCP request may renew its own signed project scope.
   * Expiry is relaxed only here, never for direct HTTP or the outer OAuth grant. */
  verifyUiCapability(token: string, host: Principal): Principal {
    if (host.kind !== 'oauth') throw new AuthError('有效的宿主授权是恢复地图连接的必要条件。');
    const capability = this.verifyClaims(token, 'api', true);
    if (capability.kind !== 'project' || capability.ownerId !== host.ownerId || capability.familyId !== host.familyId) {
      throw new AuthError('地图所属授权已改变，请重新打开此地图。');
    }
    return capability;
  }
  private verifyClaims(token: string, audience: 'api' | 'mcp', renewingUi: boolean): Principal {
    if (!renewingUi && audience === 'api' && safeEqual(token, this.config.ownerSecret)) return { ownerId: OWNER, kind: 'owner' };
    try {
      const [h, p, s, extra] = token.split('.');
      if (!h || !p || !s || extra) throw new Error();
      const expected = createHmac('sha256', this.config.signingSecret).update(`${h}.${p}`).digest('base64url');
      if (!safeEqual(expected, s)) throw new Error();
      const header = JSON.parse(Buffer.from(h, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Claims;
      if (header.alg !== 'HS256' || claims.iss !== this.config.publicUrl || claims.sub !== OWNER || claims.aud !== `${this.config.publicUrl}/${audience}` || !Number.isFinite(claims.exp) || (!renewingUi && claims.exp <= now()) || claims.iat > now() + 30 || claims.scope !== MCP_SCOPE) throw new Error();
      if ((audience === 'mcp' && claims.kind !== 'oauth') || (audience === 'api' && (claims.kind !== 'project' || !claims.projectId))) throw new Error();
      if (claims.familyId !== undefined && (typeof claims.familyId !== 'string' || !this.oauth?.isActive(claims.familyId, now()))) throw new Error();
      return { ownerId: claims.sub, kind: claims.kind, projectId: claims.projectId, familyId: claims.familyId };
    } catch { throw new AuthError('Authentication expired or invalid. Reconnect to Project Task Map.'); }
  }
  request(req: Request, audience: 'api' | 'mcp'): Principal {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ') || header.length > 8192) throw new AuthError('Bearer authentication required.');
    return this.verify(header.slice(7), audience);
  }
}

interface Intent { clientId: string; redirect: string; state: string; challenge: string; exp: number }
interface Code extends Intent { code: string }
const htmlEscape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function cspRedirectOrigin(uri: string): string | undefined {
  // URL parsing accepts characters in hostnames that are CSP delimiters or
  // wildcards. Only a concrete serialized HTTP(S) origin may enter the policy.
  if (/[\u0000-\u0020\u007f]/.test(uri)) return;
  try {
    const origin = new URL(uri).origin;
    return /^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]{1,5})?$/i.test(origin) ? origin : undefined;
  } catch { return; }
}

/** RFC 8252 permits a different port only for a native app's literal loopback IP. */
const redirectMatches = (registered: string, requested: string): boolean => {
  if (registered === requested) return true;
  try {
    const a = new URL(registered); const b = new URL(requested);
    return a.protocol === 'http:' && b.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(a.hostname)
      && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search
      && !b.hash && !b.username && !b.password;
  } catch { return false; }
};

/** Single-owner OAuth: durable clients/refresh grants; short-lived consent and codes stay in memory. */
export function installOAuth(app: Express, auth: Auth, clients: OAuthStore): void {
  const base = auth.config.publicUrl;
  const resource = `${base}/mcp`;
  const intents = new Map<string, Intent>();
  const codes = new Map<string, Code>();
  const attempts = new Map<string, { count: number; end: number }>();
  const prune = () => {
    for (const [key, value] of intents) if (value.exp < now()) intents.delete(key);
    for (const [key, value] of codes) if (value.exp < now()) codes.delete(key);
    for (const [key, value] of attempts) if (value.end < now()) attempts.delete(key);
    clients.prune(now());
  };
  const limit = (req: Request, bucket: string, max: number) => {
    prune();
    const key = `${bucket}:${req.ip}`;
    const old = attempts.get(key) ?? { count: 0, end: now() + 600 };
    attempts.set(key, { ...old, count: old.count + 1 });
    return old.count < max;
  };
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json({ resource, authorization_servers: [base], scopes_supported: MCP_SCOPE.split(' '), bearer_methods_supported: ['header'] }));
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: MCP_SCOPE.split(' '), authorization_response_iss_parameter_supported: true }));
  app.post('/register', (req, res) => {
    if (!limit(req, 'register', 30) || clients.clientCount() >= 500) { res.status(429).json({ error: 'rate_limited' }); return; }
    const redirects = req.body?.redirect_uris;
    if (!Array.isArray(redirects) || !redirects.length || redirects.length > 8 || redirects.some(uri => {
      try { const url = new URL(uri); return typeof uri !== 'string' || uri.length > 2000 || !cspRedirectOrigin(uri) || url.hash || url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))); } catch { return true; }
    }) || (req.body.token_endpoint_auth_method && req.body.token_endpoint_auth_method !== 'none')) { res.status(400).json({ error: 'invalid_client_metadata' }); return; }
    const client = clients.register(redirects, now());
    res.status(201).json({ client_id: client.clientId, client_id_issued_at: client.created, redirect_uris: redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  });
  app.get('/authorize', (req, res) => {
    if (!limit(req, 'authorize', 40) || intents.size > 1000) { res.status(429).send('Too many requests.'); return; }
    const q = req.query;
    const client = typeof q.client_id === 'string' ? clients.getClient(q.client_id) : undefined;
    const redirectOrigin = typeof q.redirect_uri === 'string' ? cspRedirectOrigin(q.redirect_uri) : undefined;
    const requestedScopes = typeof q.scope === 'string' ? [...new Set(q.scope.split(' ').filter(Boolean))].sort().join(' ') : MCP_SCOPE;
    // This personal deployment has one complete read/write grant. Reject partial scopes instead of silently escalating them.
    if (!client || !redirectOrigin || typeof q.redirect_uri !== 'string' || !client.redirects.some(uri => redirectMatches(uri, q.redirect_uri as string)) || q.response_type !== 'code' || q.code_challenge_method !== 'S256' || typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge) || q.resource !== resource || requestedScopes !== MCP_SCOPE || (q.scope !== undefined && typeof q.scope !== 'string')) { res.status(400).send('Invalid authorization request; both projects:read and projects:write scopes are required.'); return; }
    const id = opaque();
    intents.set(id, { clientId: client.clientId, redirect: q.redirect_uri, state: typeof q.state === 'string' ? q.state : '', challenge: q.code_challenge, exp: now() + 300 });
    res.cookie('taskmap_oauth', id, { httpOnly: true, sameSite: 'lax', secure: base.startsWith('https:'), path: '/authorize', maxAge: 300000 });
    // Native form POSTs use Origin:null under no-referrer and fail our origin
    // check. Preserve the same-origin form source; the redirect keeps no-referrer.
    res.set('Referrer-Policy', 'same-origin');
    // Chromium also checks form-action on the 303 redirect to the OAuth client.
    res.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'`);
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
    target.searchParams.set('iss', base);
    if (intent.state) target.searchParams.set('state', intent.state);
    res.clearCookie('taskmap_oauth', { path: '/authorize' });
    res.redirect(303, target.toString());
  });
  app.post('/token', (req, res) => {
    if (!limit(req, 'token', 80)) { res.status(429).json({ error: 'rate_limited' }); return; }
    const b = req.body ?? {};
    const reply = (grant: RefreshGrant) => {
      const lifetime = Math.min(3600, grant.expires - now());
      res.set('Pragma', 'no-cache').json({ access_token: auth.issue('oauth', undefined, lifetime, grant.familyId), token_type: 'Bearer', expires_in: lifetime, refresh_token: grant.refreshToken, scope: MCP_SCOPE });
    };
    if (b.grant_type === 'refresh_token') {
      if (b.scope !== undefined && (typeof b.scope !== 'string' || [...new Set(b.scope.split(' ').filter(Boolean))].sort().join(' ') !== MCP_SCOPE)) { res.status(400).json({ error: 'invalid_scope' }); return; }
      if (typeof b.refresh_token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(b.refresh_token) || typeof b.client_id !== 'string' || !clients.getClient(b.client_id) || (b.resource !== undefined && b.resource !== resource)) { res.status(400).json({ error: 'invalid_grant' }); return; }
      // Omitted resource/scope retain the original grant; supplied values may not broaden it.
      const grant = clients.rotate(b.refresh_token, b.client_id, resource, MCP_SCOPE, now());
      if (!grant) { res.status(400).json({ error: 'invalid_grant' }); return; }
      reply(grant); return;
    }
    const code = typeof b.code === 'string' ? codes.get(b.code) : undefined;
    if (b.grant_type !== 'authorization_code' || !code || code.exp < now() || b.client_id !== code.clientId || b.redirect_uri !== code.redirect || b.resource !== resource || typeof b.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(b.code_verifier) || !safeEqual(createHash('sha256').update(b.code_verifier).digest('base64url'), code.challenge)) { res.status(400).json({ error: 'invalid_grant' }); return; }
    codes.delete(b.code);
    reply(clients.createGrant(code.clientId, resource, MCP_SCOPE, now()));
  });
}
