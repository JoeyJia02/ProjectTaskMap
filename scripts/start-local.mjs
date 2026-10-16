import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const envFile = resolve(root, '.env');
if (!existsSync(envFile)) throw new Error('Missing .env. Run the project setup first.');
const env = parseEnv(readFileSync(envFile, 'utf8'));
const origin = new URL(env.TASK_MAP_PUBLIC_URL || 'http://127.0.0.1:3000');
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
  throw new Error('This launcher is only for a local 127.0.0.1 deployment.');
}
const healthy = async () => {
  try {
    const response = await fetch(new URL('/health', origin), { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const body = await response.json();
    if (response.ok && body.ok === true && body.version === '0.1.0') return true;
    throw new Error('Port responds but is not a compatible Task Map server.');
  } catch (error) {
    if (error.message?.startsWith('Port responds')) throw error;
    return false;
  }
};
if (await healthy()) {
  console.log(`Task Map is ready: ${origin.origin}`);
} else {
  const entry = resolve(root, 'dist/server/server/index.js');
  if (!existsSync(entry)) throw new Error('Missing build. Run npm run build first.');
  mkdirSync(resolve(root, '.tmp'), { recursive: true });
  const out = openSync(resolve(root, '.tmp/server.stdout.log'), 'a');
  const err = openSync(resolve(root, '.tmp/server.stderr.log'), 'a');
  // Detach only this project server, with no shell or visible helper window.
  const child = spawn(process.execPath, [entry], {
    cwd: root, env: { ...process.env, ...env }, windowsHide: true, detached: true,
    stdio: ['ignore', out, err],
  });
  closeSync(out); closeSync(err);
  let startError;
  child.once('error', error => { startError = error; });
  child.unref();
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (startError) throw startError;
    if (await healthy()) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Server did not become ready. See .tmp/server.stderr.log.');
  console.log(`Task Map started: ${origin.origin}`);
}
