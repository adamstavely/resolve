import { readFile } from 'node:fs/promises';
import { migrate } from './index';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
await migrate(url,[{version:'0001',sql:await readFile(new URL('../migrations/0001.sql',import.meta.url),'utf8')}]);
console.log('Resolve migrations complete');
