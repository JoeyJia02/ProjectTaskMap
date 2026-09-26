import { DatabaseSync, backup } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const source = resolve(process.env.TASK_MAP_DB ?? 'data/task-map.sqlite');
const destination = process.argv[2];
if (!destination || existsSync(destination) || resolve(destination) === source) throw new Error('Pass a NEW backup file path; existing files will not be overwritten.');
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, destination); console.log(`Created consistent SQLite backup: ${resolve(destination)}`); }
finally { db.close(); }
