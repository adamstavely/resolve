import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { QUACKBACK_BASELINE, QUACKBACK_SCOPES, TENANT_TOOLS, toolArgs, type TenantToolName } from '../../packages/contracts/src';

/*
 * Verifies the tenant tool inventory against a Quackback fork checkout (plan 04 "Contract" layer).
 * Static source check only; live OAuth/tenant contract runs come with a disposable tenant.
 *   QUACKBACK_SRC=~/path/to/quackback npm run test:contract
 */
const root = process.env.QUACKBACK_SRC;
if (!root) throw new Error('Set QUACKBACK_SRC to a checkout of ' + QUACKBACK_BASELINE.repository);
const web = join(root, 'apps/web/src/lib');
const read = (path: string) => readFileSync(join(web, path), 'utf8');

const toolScopes = Object.fromEntries([...read('server/mcp/required-scope.ts').matchAll(/^\s+(\w+): '([\w:]+)',$/gm)].map(m => [m[1], m[2]]));
const permissionsSource = read('server/fork/rbac/mcp-tool-permissions.ts');
const PERMISSION_KEYS: Record<string, string> = Object.fromEntries([...read('shared/permissions.ts').matchAll(/^\s+([A-Z_]+): '([a-z_.]+)',$/gm)].map(m => [m[1], m[2]]));

/** The fork classifies every argument of every tool; read one tool's spec block. */
function forkSpec(tool: string) {
 // One-line specs first, so a lazy multi-line match cannot run on into the next tool's block.
 const block = permissionsSource.match(new RegExp(`\\n  ${tool}: \\{([^\\n]*)\\},?\\n`))
  ?? permissionsSource.match(new RegExp(`\\n  ${tool}: \\{\\n([\\s\\S]*?)\\n  \\},?\\n`));
 if (!block) return undefined;
 const body = block[1];
 const keys = (s: string | undefined) => [...(s ?? '').matchAll(/P\.([A-Z_]+)/g)].map(m => PERMISSION_KEYS[m[1]]);
 const list = (name: string) => [...(body.match(new RegExp(`${name}: \\[([^\\]]*)\\]`))?.[1] ?? '').matchAll(/'(\w+)'/g)].map(m => m[1]);
 return { base: keys(body.match(/base: needs\(([^)]*)\)/)?.[1]), args: [...list('inert'), ...list('ticketsVisible')].sort() };
}

describe(`Quackback fork ${QUACKBACK_BASELINE.commit.slice(0, 9)}`, () => {
 test('checkout is the pinned commit', () => {
  expect(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(QUACKBACK_BASELINE.commit);
 });

 test('scope vocabulary is unchanged', () => {
  const scopes = [...read('shared/api-key-scopes.ts').match(/API_KEY_SCOPES = \[([\s\S]*?)\]/)![1].matchAll(/'([\w:]+)'/g)].map(m => m[1]);
  expect(scopes).toEqual([...QUACKBACK_SCOPES]);
 });

 const entries = Object.entries(TENANT_TOOLS) as [TenantToolName, (typeof TENANT_TOOLS)[TenantToolName]][];
 test.each(entries.filter(([, t]) => t.status !== 'missing'))('%s: scope, permissions and arguments match the handler', (name, tool) => {
  expect(toolScopes[name]).toBe(tool.scope);
  const spec = forkSpec(name)!;
  expect(spec).toBeDefined();
  expect(spec.base).toEqual([...tool.permissions]);
  expect(Object.keys(toolArgs[name as keyof typeof toolArgs].shape).sort()).toEqual(spec.args);
 });

 test.each(entries.filter(([, t]) => t.status === 'missing'))('%s is still missing (update the inventory when it lands)', name => {
  expect(toolScopes[name]).toBeUndefined();
 });

 test('announcement audience still lacks Everyone (QB-ANN-3)', () => {
  expect(read('shared/fork/announcements/types.ts')).toMatch(/AUDIENCE_TIERS = \['authenticated', 'segments'\]/);
 });
});
