import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * Puts the keyboard where a person is after reading the title of the screen (the navigation is behind them): the title takes the focus, so the next Tab
 * goes to the first control of the screen. Only the starting point is placed; every later move is a key.
 */
export async function startAtTitle(page: Page): Promise<void> {
  await page.locator('h1').first().evaluate((heading) => {
    heading.setAttribute('tabindex', '-1');
    (heading as HTMLElement).focus();
  });
}

/** Presses Tab until `target` has the focus: the control is in the Tab order, and the number of stops to it is bounded. */
export async function tabTo(page: Page, target: Locator, limit = 60): Promise<void> {
  for (let stop = 0; stop <= limit; stop += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`the control was not reached with ${limit} presses of Tab: ${target}`);
}

/** Reaches `target` with Tab, then types `text` into it with the keyboard. */
export async function typeInto(page: Page, target: Locator, text: string): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.type(text);
  await expect(target).toHaveValue(text);
}

/** Reaches the button with Tab and presses it with the key that activates it. */
export async function pressButton(page: Page, target: Locator, key: 'Enter' | 'Space' = 'Enter'): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press(key);
}

/** Reaches a select with Tab and chooses the option that begins with `label` by typing its first letters (the keyboard way of choosing in a list). */
export async function chooseOption(page: Page, select: Locator, label: string): Promise<void> {
  await tabTo(page, select);
  await page.keyboard.type(label);
  await expect(select.locator('option:checked')).toHaveText(label);
}

/** Reaches a date field with Tab and types the day into it: the field of the test browser (its UI language is en-US, whatever the locale of the page) takes month, day and year in that order. */
export async function typeDate(page: Page, field: Locator, iso: string): Promise<void> {
  await tabTo(page, field);
  await page.keyboard.type(`${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(0, 4)}`);
  await expect(field).toHaveValue(iso);
}

/** Reaches a file input with Tab and opens the chooser with the Enter key; the chooser is answered with `file` (the one step of a native dialog that the browser driver has to take). */
export async function chooseFileWithKeyboard(page: Page, input: Locator, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await tabTo(page, input);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles(file);
}
