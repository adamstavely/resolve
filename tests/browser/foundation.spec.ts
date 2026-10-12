import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('component bridge, dialog focus and keyboard selection',async({page})=>{
 await page.goto('/'); await expect(page.getByText('Resolve API is reachable · contract v1')).toBeVisible();
 const trigger=page.getByRole('button',{name:'Open integration check'});await trigger.click();
 await page.getByLabel('Display name').fill('SRE operator');await page.getByRole('combobox').click();
 await page.getByPlaceholder('Find appearance…').fill('Dark');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
 await page.getByRole('button',{name:'Save local preference'}).click();await expect(trigger).toBeFocused();
 await expect(page.getByText('Angular received the local preference for SRE operator.')).toBeVisible();
});
test('light and dark accessibility and narrow layout',async({page})=>{
 await page.goto('/');
 for(const dark of [false,true]){
  if(dark)await page.getByRole('button',{name:'Dark appearance'}).click();
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
 }
 await page.setViewportSize({width:320,height:800});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Open integration check'}).click();
 // Content behind the modal overlay is aria-hidden and obscured; scan the dialog that is actually presented.
 await expect(page.getByRole('dialog')).toBeVisible();
 expect((await new AxeBuilder({page}).include('[role=dialog]').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
});
