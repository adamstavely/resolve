import { readdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import { LATEST_MIGRATION } from '../packages/database/src';

test('readiness requires the newest migration', () => {
 const files = readdirSync(new URL('../packages/database/migrations/', import.meta.url)).filter(f => /^\d{4}\.sql$/.test(f)).sort();
 expect(files.at(-1)).toBe(LATEST_MIGRATION + '.sql');
});
