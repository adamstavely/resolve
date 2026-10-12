import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// Theme changes run colour transitions; sample contrast only after they settle.
const settled = (page: Page) => page.evaluate(() => Promise.allSettled(document.getAnimations().map(a => a.finished)));
const axe = async (page: Page) => { await settled(page); return new AxeBuilder({ page }).withTags(tags).analyze(); };

test('backend contract, self-hosted fonts and no external requests', async ({ page }) => {
 const external: string[] = [];
 page.on('request', r => { const host = new URL(r.url()).hostname; if (host !== '127.0.0.1' && host !== 'localhost') external.push(r.url()); });
 await page.goto('/');
 await expect(page.getByText('Resolve API is reachable · contract v1')).toBeVisible();
 expect(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px Geist'); })).toBe(true);
 expect(external).toEqual([]);
});

test('axe in both themes, with 320px reflow', async ({ page }) => {
 await page.goto('/components');
 await expect(page.getByLabel('Application name')).toBeVisible();
 for (const theme of ['light', 'dark']) {
  if (theme === 'dark') await page.getByRole('button', { name: 'Dark appearance' }).click();
  expect((await axe(page)).violations, theme).toEqual([]);
 }
 await page.setViewportSize({ width: 320, height: 800 });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('text spacing override (1.4.12) does not clip or overflow at 320px', async ({ page }) => {
 await page.setViewportSize({ width: 320, height: 800 });
 await page.goto('/');
 await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }' });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
