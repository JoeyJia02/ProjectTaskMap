import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';

const methods = new Set(['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']);
const rpcMethods = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'resources/list', 'resources/read']);
const uiResources = new Map([
  ['ui://project-task-map/map.html', 'map-v1'],
  ['ui://project-task-map/map-v2.html', 'map-v2'],
  ['ui://project-task-map/map-v3.html', 'map-v3'],
  ['ui://project-task-map/map-v4.html', 'map-v4'],
]);
const routeLabels = new Map([
  ['/.well-known/oauth-protected-resource', 'oauth-protected-resource'],
  ['/.well-known/oauth-protected-resource/mcp', 'oauth-protected-resource-mcp'],
  ['/.well-known/oauth-authorization-server', 'oauth-authorization-server'],
  ['/.well-known/openid-configuration', 'openid-configuration'],
  ['/authorize', 'authorize'],
  ['/register', 'register'],
  ['/token', 'token'],
  ['/mcp', 'mcp'],
  ['/health', 'health'],
]);

interface DiagnosticOptions {
  publicOrigin: string;
  writeLine?: (line: string) => void;
}

/** Intentionally accepts no request/body/header serializer or free-form fields. */
export function requestDiagnostics({ publicOrigin, writeLine = line => console.log(line) }: DiagnosticOptions): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    const method = methods.has(req.method) ? req.method : 'other';
    const route = routeLabels.get(req.path) ?? 'other';
    const originHeader = req.get('origin');
    const origin = originHeader === undefined ? 'none'
      : originHeader === publicOrigin ? 'public'
      : originHeader === 'null' ? 'null' : 'other';

    res.once('finish', () => {
      const rpc = route === 'mcp' && req.body && typeof req.body === 'object' ? req.body : undefined;
      const record = {
        timestamp: new Date().toISOString(),
        method,
        route,
        status: res.statusCode,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        origin,
        ...(rpc ? { rpcMethod: rpcMethods.has(rpc.method) ? rpc.method : 'other',
          ...(rpc.method === 'resources/read' ? { uiResource: uiResources.get(rpc.params?.uri) ?? 'unknown' } : {}) } : {}),
      };
      // A failed diagnostic sink must not affect the response or print its error.
      try { writeLine(JSON.stringify(record)); } catch { /* Diagnostics are best effort. */ }
    });
    next();
  };
}
