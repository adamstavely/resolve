import { readdir, readFile } from 'node:fs/promises';
import { migrate } from './index';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const dir = new URL('../migrations/', import.meta.url);
const files = (await readdir(dir)).filter(f => /^\d{4}\.sql$/.test(f)).sort();
await migrate(url, await Promise.all(files.map(async f => ({ version: f.slice(0, 4), sql: await readFile(new URL(f, dir), 'utf8') }))));
console.log('Resolve migrations complete');
