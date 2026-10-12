import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('../packages/design-tokens/styles.css', import.meta.url), 'utf8');
function theme(selector: string) {
 const block = css.match(new RegExp(selector.replace(/[[\]]/g, '\\$&') + '\\s*\\{([^}]*)\\}'))?.[1];
 if (!block) throw new Error('Missing theme block ' + selector);
 return Object.fromEntries([...block.matchAll(/--([\w-]+):(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));
}
function luminance(hex: string) {
 const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
 return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// WCAG 2.2: 1.4.3 text 4.5:1; 1.4.11 control boundaries, focus indicators and meaningful icons 3:1.
const surfaces = ['bg', 'surface', 'surface-inset'];
const text = ['ink', 'ink-2', 'ink-3', 'accent-ink', 'safe-ink', 'sensitive-ink', 'destructive-ink'];
const nonText = ['control-line', 'ink-faint', 'accent'];
const tinted = [['ink', 'accent-soft'], ['accent-ink', 'accent-soft'], ['ink-3', 'accent-soft'], ['safe-ink', 'safe-soft'], ['sensitive-ink', 'sensitive-soft'], ['destructive-ink', 'destructive-soft']];
const labels = [['on-accent', 'accent'], ['on-destructive', 'destructive'], ['on-ink', 'ink']];

describe.each([[':root, :root[data-theme=light]'], [':root[data-theme=dark]']])('%s tokens', selector => {
 const t = theme(selector);
 test.each(text.flatMap(f => surfaces.map(b => [f, b])))('text %s on %s ≥ 4.5', (f, b) => expect(contrast(t[f], t[b])).toBeGreaterThanOrEqual(4.5));
 test.each(tinted)('text %s on %s ≥ 4.5', (f, b) => expect(contrast(t[f], t[b])).toBeGreaterThanOrEqual(4.5));
 test.each(labels)('label %s on %s ≥ 4.5', (f, b) => expect(contrast(t[f], t[b])).toBeGreaterThanOrEqual(4.5));
 test.each(nonText.flatMap(f => surfaces.map(b => [f, b])))('non-text %s on %s ≥ 3', (f, b) => expect(contrast(t[f], t[b])).toBeGreaterThanOrEqual(3));
});

test('no remote font or resource loads', () => {
 expect(css).not.toMatch(/https?:\/\//);
 expect(css).not.toMatch(/@import/);
});
