import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) {
  console.log('.env already exists; retained existing configuration.');
} else {
  const secret = () => randomBytes(32).toString('base64url');
  writeFileSync('.env', [
    `TASK_MAP_OWNER_SECRET=${secret()}`,
    `TASK_MAP_SIGNING_SECRET=${secret()}`,
    'TASK_MAP_PUBLIC_URL=http://127.0.0.1:3000',
    'TASK_MAP_WIDGET_ORIGIN=https://web-sandbox.oaiusercontent.com',
    'TASK_MAP_ALLOWED_ORIGINS=http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:5173',
    'TASK_MAP_DB=data/task-map.sqlite',
    'TASK_MAP_HOST=127.0.0.1',
    'PORT=3000', '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  console.log('Generated .env with two independent secrets. Read it locally for the owner login; keep it private.');
}
mkdirSync('data', { recursive: true });
