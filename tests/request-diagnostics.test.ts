import { afterEach, describe, expect, it } from 'vitest';
import express, { type RequestHandler } from 'express';
import { createServer, type Server } from 'node:http';
import { requestDiagnostics } from '../src/server/request-diagnostics.js';

const servers: Server[] = [];
async function start(handler: RequestHandler, writeLine: (line: string) => void) {
  const wrapper = express();
  const server = createServer(wrapper);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Test server address unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  wrapper.use(requestDiagnostics({ publicOrigin: origin, writeLine }));
  const inner = express();
  inner.use(express.text({ type: '*/*' }));
  inner.use(handler);
  wrapper.use(inner);
  return origin;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('strictly redacted request diagnostics', () => {
  it('logs normal completion and rejected Origin without copying URL, query, headers, body or response', async () => {
    const logs: string[] = [];
    const secrets = {
      query: 'SENTINEL_QUERY_CLIENT_CODE',
      origin: 'SENTINEL-ORIGIN-SECRET',
      bearer: 'SENTINEL_BEARER_SECRET',
      cookie: 'SENTINEL_COOKIE_SECRET',
      body: 'SENTINEL_BODY_OWNER_SECRET',
      response: 'SENTINEL_RESPONSE_TOKEN',
      path: 'SENTINEL_PATH_SECRET',
      ip: 'SENTINEL_FORWARDED_IP',
    };
    const origin = await start((req, res) => {
      if (req.get('origin') === 'null' || req.get('origin')?.includes(secrets.origin)) {
        res.status(403).json({ error: 'Origin is not allowed.', detail: secrets.response });
      } else res.status(201).send(secrets.response);
    }, line => logs.push(line));
    const makeRequest = (path: string, requestOrigin?: string) => fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${secrets.bearer}`,
        Cookie: `session=${secrets.cookie}`,
        'X-Forwarded-For': secrets.ip,
        ...(requestOrigin === undefined ? {} : { Origin: requestOrigin }),
      },
      body: `ownerSecret=${secrets.body}`,
    });

    expect((await makeRequest(`/authorize?code=${secrets.query}`, origin)).status).toBe(201);
    expect((await makeRequest(`/authorize?client_id=${secrets.query}`, 'null')).status).toBe(403);
    expect((await makeRequest(`/register?code=${secrets.query}`, `https://${secrets.origin}.example`)).status).toBe(403);
    expect((await makeRequest(`/authorize/${secrets.path}?code=${secrets.query}`)).status).toBe(201);

    const records = logs.map(line => JSON.parse(line));
    expect(records).toHaveLength(4);
    expect(records.map(({ method, route, status, origin: classification }) => ({ method, route, status, origin: classification }))).toEqual([
      { method: 'POST', route: 'authorize', status: 201, origin: 'public' },
      { method: 'POST', route: 'authorize', status: 403, origin: 'null' },
      { method: 'POST', route: 'register', status: 403, origin: 'other' },
      { method: 'POST', route: 'other', status: 201, origin: 'none' },
    ]);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(['durationMs', 'method', 'origin', 'route', 'status', 'timestamp']);
      expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Number.isInteger(record.durationMs)).toBe(true);
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
    }
    const serialized = logs.join('\n');
    for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(origin);
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('ownerSecret');
    expect(serialized).not.toContain('?');
  });

  it('uses fixed labels for discovery, MCP and OAuth routes and collapses other paths and methods', async () => {
    const logs: string[] = [];
    const origin = await start((_req, res) => { res.sendStatus(204); }, line => logs.push(line));
    const cases = [
      ['/.well-known/oauth-protected-resource', 'oauth-protected-resource'],
      ['/.well-known/oauth-protected-resource/mcp', 'oauth-protected-resource-mcp'],
      ['/.well-known/oauth-authorization-server', 'oauth-authorization-server'],
      ['/.well-known/openid-configuration', 'openid-configuration'],
      ['/authorize', 'authorize'], ['/register', 'register'], ['/token', 'token'], ['/mcp', 'mcp'], ['/health', 'health'],
      ['/.well-known/oauth-protected-resource/SECRET_CLIENT', 'other'],
      ['/api/projects/SECRET_PROJECT/history', 'other'],
    ];
    for (const [path] of cases) expect((await fetch(`${origin}${path}?secret=SENTINEL_QUERY`)).status).toBe(204);
    expect((await fetch(`${origin}/health`, { method: 'SEARCH' })).status).toBe(204);
    expect(logs.map(line => JSON.parse(line).route)).toEqual([...cases.map(([, label]) => label), 'health']);
    expect(JSON.parse(logs.at(-1)!).method).toBe('other');
    expect(logs.join('\n')).not.toMatch(/SECRET_CLIENT|SECRET_PROJECT|SENTINEL_QUERY|SEARCH/);
  });

  it('does not disrupt a completed response when the diagnostic sink throws', async () => {
    let calls = 0;
    const origin = await start((_req, res) => { res.status(200).send('ok'); }, () => {
      calls++;
      throw new Error('SENTINEL_SINK_ERROR');
    });
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(calls).toBe(1);
  });
});
