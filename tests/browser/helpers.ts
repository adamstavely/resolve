import { type Page } from '@playwright/test';

/** Sign in through the mock IdP. With an existing IdP session (SSO) the IdP returns without a prompt. */
export async function signInAs(page: Page, name: string, start = '/api/auth/login?returnTo=/') {
 await page.goto(start);
 if (new URL(page.url()).port === '3200') {
  await page.getByLabel(name).check();
  await page.getByRole('button', { name: 'Continue' }).click();
 }
}
