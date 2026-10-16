import { spawn } from 'node:child_process';
import { existsSync, readFileSync, openSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createServer } from 'node:net';
import { parsePublicRuntime } from './public-runtime-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = parsePublicRuntime(JSON.parse(readFileSync(resolve(root, 'data/public-runtime.json'), 'utf8')));
const local = `http://127.0.0.1:${config.port}`;
async function ready() {
  try {
    const response = await fetch(`${local}/.well-known/oauth-authorization-server`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!response.ok || (await response.json()).issuer !== config.origin) throw new Error('Incompatible listener on fixed-entry port.');
    return true;
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw new Error('Fixed-entry port is occupied or unavailable; existing processes were preserved.');
  }
}
if (await ready()) {
  console.log(JSON.stringify({ ok: true, reused: true, origin: config.origin, port: config.port }));
} else {
  await new Promise((done, fail) => {
    const probe = createServer(); probe.once('error', fail);
    probe.listen(config.port, '127.0.0.1', () => probe.close(done));
  });
  const env = parseEnv(readFileSync(resolve(root, '.env'), 'utf8'));
  const entry = resolve(root, 'dist/server/server/index.js');
  if (!existsSync(entry)) throw new Error('Build missing.');
  mkdirSync(resolve(root, '.tmp'), { recursive: true });
  const out = openSync(resolve(root, '.tmp/fixed-server.stdout.log'), 'a');
  const err = openSync(resolve(root, '.tmp/fixed-server.stderr.log'), 'a');
  const child = spawn(process.execPath, [entry], {
    cwd: root, windowsHide: true, detached: true, stdio: ['ignore', out, err],
    env: { ...process.env, ...env, TASK_MAP_PUBLIC_URL: config.origin, TASK_MAP_ALLOWED_ORIGINS: config.origin,
      TASK_MAP_HOST: '127.0.0.1', PORT: String(config.port), TASK_MAP_DB: resolve(root, env.TASK_MAP_DB || 'data/task-map.sqlite') },
  });
  closeSync(out); closeSync(err);
  let failed = false; child.once('error', () => { failed = true; }); child.unref();
  let healthy = false;
  for (let attempt = 0; attempt < 30 && !failed; attempt++) {
    if (child.exitCode !== null) break;
    try { healthy = await ready(); } catch { break; }
    if (healthy) break;
    await new Promise(done => setTimeout(done, 250));
  }
  if (!healthy) { child.kill(); throw new Error('Fixed-entry backend did not become ready.'); }
  writeFileSync(resolve(root, '.tmp/fixed-runtime.json'), JSON.stringify({ ...config, serverPid: child.pid, startedAt: new Date().toISOString() }) + '\n');
  console.log(JSON.stringify({ ok: true, origin: config.origin, port: config.port, serverPid: child.pid }));
}
