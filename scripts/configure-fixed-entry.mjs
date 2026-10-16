import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePublicRuntime } from './public-runtime-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = 'D:/Tailscale/tailscale.exe';
// Capture client metadata internally. Account identities, keys, and full client
// status never enter tool output; only the verified public service URL does.
let status;
try { status = JSON.parse(execFileSync(binary, ['status', '--json'], { windowsHide: true, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })); }
catch { throw new Error('Tailscale client is unavailable.'); }
if (status.BackendState !== 'Running') throw new Error('Complete the Tailscale device login first.');
const hostname = status.Self?.DNSName?.replace(/\.$/, '');
const config = parsePublicRuntime({ provider: 'tailscale', origin: `https://${hostname}`, port: 3002 });
const path = resolve(root, 'data/public-runtime.json');
if (existsSync(path) && parsePublicRuntime(JSON.parse(readFileSync(path, 'utf8'))).origin !== config.origin) {
  throw new Error('The device address changed; review existing plugin bindings before replacing it.');
}
mkdirSync(resolve(root, 'data'), { recursive: true });
writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
console.log(JSON.stringify({ configured: true, origin: config.origin, mcpUrl: `${config.origin}/mcp`, port: config.port, accountLoginVerified: true }));
