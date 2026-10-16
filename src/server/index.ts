import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import express from 'express';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { requestDiagnostics } from './request-diagnostics.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
mkdirSync(dirname(resolve(config.dbPath)), { recursive: true });
const { app, close } = createApp(config);
const listener = process.env.TASK_MAP_DIAGNOSTICS === '1'
  ? express().disable('x-powered-by').use(requestDiagnostics({ publicOrigin: config.publicUrl })).use(app)
  : app;
const http = listener.listen(config.port, config.host, () => {
  console.log(`Project Task Map listening at ${config.publicUrl}; MCP endpoint /mcp`);
});
const stop = () => http.close(() => { close(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
