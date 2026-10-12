/*
 * Development-only mock Elastic Cloud Hosted 9.x (plan 14, E0): Elasticsearch on 3400, Kibana on 3401.
 * API keys and their privileges are in keys.json (dev-only values). Test controls: POST /dev/fault, /dev/keys,
 * /dev/ingest, /dev/reset and GET /dev/state on the Elasticsearch port.
 *
 *   npm run dev:elastic
 */
import { readFileSync } from 'node:fs';
import { apiKeyFor, startMockElastic, type MockKey } from './elastic.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('The mock Elastic must never run in production');
const cfg: { esPort: number; kibanaPort: number; keys: MockKey[] } = JSON.parse(readFileSync(new URL('./keys.json', import.meta.url), 'utf8'));
const mock = await startMockElastic({ ...cfg, live: true });
console.log(`Mock Elasticsearch at ${mock.esUrl}, Kibana at ${mock.kibanaUrl} (space support-ops). Reader API key: ${apiKeyFor(cfg.keys[0])}`);
