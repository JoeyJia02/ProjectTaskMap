export interface Config {
  ownerSecret: string;
  signingSecret: string;
  publicUrl: string;
  widgetOrigin: string;
  allowedOrigins: string[];
  dbPath: string;
  host: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ownerSecret = env.TASK_MAP_OWNER_SECRET ?? '';
  const signingSecret = env.TASK_MAP_SIGNING_SECRET ?? '';
  if (ownerSecret.length < 32 || signingSecret.length < 32 || ownerSecret === signingSecret) {
    throw new Error('Configure independent TASK_MAP_OWNER_SECRET and TASK_MAP_SIGNING_SECRET (32+ characters) in .env.');
  }
  const url = new URL(env.TASK_MAP_PUBLIC_URL ?? 'http://127.0.0.1:3000');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('TASK_MAP_PUBLIC_URL must be an origin.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('HTTPS is required outside localhost.');
  }
  const widgetOrigin = env.TASK_MAP_WIDGET_ORIGIN ?? 'https://web-sandbox.oaiusercontent.com';
  if (new URL(widgetOrigin).origin !== widgetOrigin || !widgetOrigin.startsWith('https://')) throw new Error('TASK_MAP_WIDGET_ORIGIN must be an HTTPS origin.');
  const allowedOrigins = [...new Set([...(env.TASK_MAP_ALLOWED_ORIGINS ?? url.origin).split(',').map(s => s.trim()).filter(Boolean), widgetOrigin])];
  for (const origin of allowedOrigins) if (new URL(origin).origin !== origin) throw new Error('CORS entries must be explicit origins.');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  return { ownerSecret, signingSecret, publicUrl: url.origin, widgetOrigin, allowedOrigins, dbPath: env.TASK_MAP_DB ?? 'data/task-map.sqlite', host: env.TASK_MAP_HOST ?? '127.0.0.1', port };
}
