import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const status = (page: Page) => page.getByRole('status').filter({ hasText: /Form|No values|Draft/ });

test.beforeEach(async ({ page }) => {
 await page.goto('/');
 await expect(page.getByLabel('Application name')).toBeVisible();
});

test('submitting an empty form focuses the first invalid field and associates errors', async ({ page }) => {
 await page.getByRole('button', { name: 'Check form values' }).click();
 const name = page.getByLabel('Application name');
 await expect(name).toBeFocused();
 await expect(name).toHaveAttribute('aria-invalid', 'true');
 await expect(name).toHaveAccessibleDescription('The name support staff will see. Error: Enter application name.');
 const team = page.getByRole('combobox', { name: /Support team/ });
 await expect(team).toHaveAccessibleDescription('Error: Choose support team.');
 await expect(status(page)).toHaveText('No values checked yet.');
 expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations).toEqual([]);
});

test('keyboard-only completion submits values through native form association', async ({ page }) => {
 await page.getByLabel('Application name').fill('Payroll');
 await expect(page.getByText('Angular model: Payroll')).toBeVisible();
 await page.keyboard.press('Tab'); // contact email
 await page.keyboard.press('Tab'); // team combobox
 const team = page.getByRole('combobox', { name: /Support team/ });
 await expect(team).toBeFocused();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('combobox', { name: 'Search teams' })).toBeFocused();
 expect((await new AxeBuilder({ page }).withTags(tags).include('[data-radix-popper-content-wrapper]').analyze()).violations).toEqual([]);
 await page.keyboard.type('hr');
 await page.keyboard.press('Enter');
 await expect(team).toBeFocused();
 await expect(team).toHaveAccessibleName('Support team (required) HR Platform');
 await page.getByRole('button', { name: 'Check form values' }).click();
 await expect(status(page)).toHaveText('Form values: appName=Payroll, contact=, team=hr-platform');
});

test('format errors appear after editing and clear when corrected', async ({ page }) => {
 const email = page.getByLabel('Support contact email');
 await email.fill('sre-team');
 await email.blur();
 await expect(email).toHaveAccessibleDescription('Error: Enter an email address in the format name@example.com.');
 await email.fill('sre@example.com');
 await expect(email).not.toHaveAttribute('aria-invalid');
});

test('reset clears element values, Angular models and visible errors', async ({ page }) => {
 await page.getByRole('button', { name: 'Check form values' }).click();
 await page.getByLabel('Application name').fill('HR');
 await page.getByRole('button', { name: 'Reset' }).click();
 await expect(page.getByLabel('Application name')).toHaveValue('');
 await expect(page.getByText('Error:')).toHaveCount(0);
 await expect(page.getByText('Angular model: — · — · —')).toBeVisible();
});

test('destructive confirmation traps focus, defaults to cancel and returns focus', async ({ page }) => {
 const opener = page.getByRole('button', { name: 'Discard draft…' });
 await page.getByLabel('Application name').fill('Payroll');
 await opener.click();
 const dialog = page.getByRole('alertdialog', { name: 'Discard this draft?' });
 await expect(dialog).toHaveAccessibleDescription(/does not affect any application/);
 await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
 for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
 expect(await dialog.evaluate(d => d.contains(document.activeElement))).toBe(true);
 expect((await new AxeBuilder({ page }).withTags(tags).include('[role=alertdialog]').analyze()).violations).toEqual([]);
 await page.keyboard.press('Escape');
 await expect(dialog).toBeHidden();
 await expect(opener).toBeFocused();
 await expect(page.getByLabel('Application name')).toHaveValue('Payroll');

 await opener.click();
 await dialog.getByRole('button', { name: 'Discard draft' }).click();
 await expect(dialog).toBeHidden();
 await expect(opener).toBeFocused();
 await expect(status(page)).toHaveText('Draft discarded.');
 await expect(page.getByLabel('Application name')).toHaveValue('');
});

test('element contract: upgrade, attributes, events, disabled and moves', async ({ page }) => {
 const result = await page.evaluate(async () => {
  const tick = () => new Promise(r => setTimeout(r, 50));
  const form = document.createElement('form');
  const fieldset = document.createElement('fieldset');
  form.append(fieldset); document.body.append(form);

  // Property set before upgrade-style connection is preserved.
  const field = document.createElement('resolve-text-field');
  field.label = 'Region'; field.value = 'eu-west'; field.setAttribute('name', 'region');
  fieldset.append(field); await tick();
  const events: string[] = [];
  document.addEventListener('value-change', e => events.push(`${(e as CustomEvent).composed}:${(e as CustomEvent).detail.value}`));
  const before = new FormData(form).get('region');

  // Attributes parse into typed properties.
  field.setAttribute('maxlength', '12'); field.toggleAttribute('required', true);
  await tick();
  const typed = [typeof field.maxlength, field.maxlength, field.required];

  // User edits emit bubbling, composed events.
  const input = field.querySelector('input')!;
  input.focus(); document.execCommand('insertText', false, '-1'); await tick();

  // disabled property reflects to the attribute, so the platform bars the element from submission.
  field.disabled = true; await tick();
  const disabledValue = new FormData(form).get('region');
  const reflected = field.hasAttribute('disabled');
  field.disabled = false; fieldset.disabled = true; await tick();
  const fieldsetDisabled = [new FormData(form).get('region'), field.querySelector('input')!.disabled];
  fieldset.disabled = false; await tick();

  // Moving the element keeps React state (the same input node survives).
  const node = field.querySelector('input');
  form.append(field); await tick();
  const survived = field.querySelector('input') === node;
  form.remove();
  return { before, typed, events, disabledValue, reflected, fieldsetDisabled, survived, value: field.value };
 });
 expect(result).toEqual({
  before: 'eu-west', typed: ['number', 12, true], events: ['true:eu-west-1'], disabledValue: null, reflected: true,
  fieldsetDisabled: [null, true], survived: true, value: 'eu-west-1',
 });
});
