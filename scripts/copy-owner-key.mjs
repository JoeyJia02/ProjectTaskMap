import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';

// Explicit user-run helper: credentials never enter arguments, output or a file.
// Paste only into this deployment's OAuth consent page.
try {
  if (process.platform !== 'win32') throw new Error('Windows required.');
  const path = fileURLToPath(new URL('../.env', import.meta.url));
  const key = parseEnv(readFileSync(path, 'utf8')).TASK_MAP_OWNER_SECRET;
  if (!key || key.length < 32) throw new Error('Configured key missing.');
  const copied = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
  { input: key, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], timeout: 10000 });
  if (copied.error || copied.status !== 0) throw new Error('Clipboard failed.');
  console.log('Task Map access key copied. Paste it only into your Task Map authorization page.');
} catch {
  console.error('Could not copy the Task Map key. Ask Codex to check the local setup.');
  process.exitCode = 1;
}
