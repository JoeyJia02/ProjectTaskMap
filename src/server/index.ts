import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
mkdirSync(dirname(resolve(config.dbPath)), { recursive: true });
const { app, store } = createApp(config);
const http = app.listen(config.port, config.host, () => {
  console.log(`Project Task Map listening at ${config.publicUrl}; MCP endpoint /mcp`);
});
const stop = () => http.close(() => { store.close(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
