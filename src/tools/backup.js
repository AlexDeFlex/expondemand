// Safe copy of the database while the app is running:  npm run backup
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

const dir = process.env.BACKUP_DIR || 'backups';
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `expondemand-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new DatabaseSync(config.dbPath);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);   // consistent snapshot, no need to stop the server
db.close();
console.log('Backup written to', out, `(${fs.statSync(out).size} bytes). Copy it somewhere safe, off this machine.`);
// keep the newest 14
const all = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
all.slice(0, Math.max(0, all.length - 14)).forEach((f) => fs.rmSync(path.join(dir, f)));
