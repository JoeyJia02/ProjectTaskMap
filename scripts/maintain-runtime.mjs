import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePublicRuntime } from './public-runtime-config.mjs';

// No credential values are read or logged here. The existing launchers load
// their configuration internally. Never replace a Quick Tunnel automatically:
// changing its address would invalidate the user's installed connection.
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = resolve(root, '.tmp');
mkdirSync(temp, { recursive: true });
const watch = process.argv.slice(2);
if (watch.length && (watch.length !== 1 || watch[0] !== '--watch')) throw new Error('Only --watch is supported.');
const previewFile = resolve(temp, 'chatgpt-preview.json');
const fixedFile = resolve(root, 'data/public-runtime.json');
const reportFile = resolve(temp, 'runtime-maintenance.json');
const logFile = resolve(temp, 'runtime-maintenance.log');

async function inspect(base, issuer, timeoutMs = 3000) {
  try {
    const health = await fetch(`${base}/health`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const data = await health.json();
    if (!health.ok || data.ok !== true || data.version !== '0.1.0') return 'incompatible';
    if (issuer) {
      const metadata = await fetch(`${base}/.well-known/oauth-authorization-server`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!metadata.ok || (await metadata.json()).issuer !== issuer) return 'incompatible';
    }
    return 'ready';
  } catch (error) {
    // Only a refused connection proves it is safe to start a missing service.
    // A hung, malformed, or inaccessible listener must not be replaced blindly.
    return error.cause?.code === 'ECONNREFUSED' ? 'stopped' : 'unavailable';
  }
}

async function launch(script) {
  const out = openSync(resolve(temp, 'runtime-launcher.stdout.log'), 'a');
  const err = openSync(resolve(temp, 'runtime-launcher.stderr.log'), 'a');
  try {
    return await new Promise(resolveResult => {
      const child = spawn(process.execPath, [script], {
        cwd: root, windowsHide: true, stdio: ['ignore', out, err],
      });
      let timer;
      const done = success => { clearTimeout(timer); resolveResult(success); };
      child.once('error', () => done(false));
      child.once('exit', code => done(code === 0));
      timer = setTimeout(() => { child.kill(); done(false); }, 20000);
    });
  } finally { closeSync(out); closeSync(err); }
}

let lastStatus;
do {
  const report = { checkedAt: new Date().toISOString(), local: 'unavailable', publicBackend: 'not-configured', publicRoute: 'not-configured', fixedAddress: false };
  try {
    report.local = await inspect('http://127.0.0.1:3000');
    if (report.local === 'stopped') {
      await launch(resolve(root, 'scripts/start-local.mjs'));
      report.local = await inspect('http://127.0.0.1:3000');
    }
    if (existsSync(fixedFile)) {
      const fixed = parsePublicRuntime(JSON.parse(readFileSync(fixedFile, 'utf8')));
      report.fixedAddress = true;
      const local = `http://127.0.0.1:${fixed.port}`;
      report.publicBackend = await inspect(local, fixed.origin);
      if (report.publicBackend === 'stopped') {
        await launch(resolve(root, 'scripts/start-public.mjs'));
        report.publicBackend = await inspect(local, fixed.origin);
      }
      report.publicRoute = await inspect(fixed.origin, fixed.origin, 10000);
    } else if (existsSync(previewFile)) {
      const preview = JSON.parse(readFileSync(previewFile, 'utf8'));
      if (typeof preview.origin !== 'string' || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(preview.origin)) {
        report.publicBackend = 'configuration-needs-review';
      } else {
        report.publicBackend = await inspect('http://127.0.0.1:3001', preview.origin);
        const launcher = resolve(temp, 'start-chatgpt-backend.mjs');
        if (report.publicBackend === 'stopped' && existsSync(launcher)) {
          await launch(launcher);
          report.publicBackend = await inspect('http://127.0.0.1:3001', preview.origin);
        }
        report.publicRoute = await inspect(preview.origin, preview.origin, 10000);
      }
    }
  } catch { report.configuration = 'needs-review'; }
  const status = JSON.stringify({ ...report, checkedAt: undefined });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (status !== lastStatus) {
    appendFileSync(logFile, `${JSON.stringify(report)}\n`);
    lastStatus = status;
  }
  if (!watch.length) { console.log(JSON.stringify(report)); break; }
  await new Promise(done => setTimeout(done, 60000));
} while (true);
