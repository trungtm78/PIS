import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(__dirname, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const TASK = read('./task.css');
const BRAND = read('../../../../../../Design/MACHVON_Design/02_Prototype/brand-theme.css');
const UI = read('../../../ui/ui.css');

const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};

/** PWF-04 (owner review of 14/11/2026): the summary of the task stays in sight while the page scrolls. Checked on the style sheets, without a browser. */
describe('PWF-04: the head that sticks', () => {
  it('sticks to the top of the page, above the content and the sticky heads of the tables, on an opaque surface', () => {
    const sticky = rule(TASK, '.pwf-taskhead--sticky');
    expect(sticky).toMatch(/position: sticky;/);
    expect(sticky).toMatch(/top: 0;/);
    expect(sticky).toMatch(/background: var\(--mv-color-surface\);/);
    const z = Number(/z-index: (\d+);/.exec(sticky)?.[1]);
    // A table head of the kit is sticky at z-index 2 and a pinned cell at 1: the head of the task lies over both.
    const tableHead = Number(/z-index: (\d+);/.exec(rule(UI, '.ui-table .ui-table__head'))?.[1]);
    expect(z).toBeGreaterThan(tableHead);
    // The bar of actions at the bottom of a form (z-index 5) and the dialogs stay above it.
    expect(z).toBeLessThan(5);
  });

  it('cannot collide with the top bar of the shell: the bar is in the flow and scrolls away with the page, so `top: 0` is the top of the window', () => {
    const bar = rule(BRAND, '.workspace-topbar');
    expect(bar).not.toBe('');
    expect(bar).not.toMatch(/position: (sticky|fixed)/);
    // The content area of the shell is not a scroll box of its own (a sticky head would stick to it and not to the window).
    expect(rule(BRAND, '.workspace-app .content')).not.toMatch(/overflow/);
  });

  it('does not stick on a phone or in print, where the head would take the screen', () => {
    expect(TASK).toMatch(/@media \(max-width: 720px\) \{\s*\.pwf-taskhead--sticky \{\s*position: static;/);
    expect(TASK).toMatch(/@media print \{\s*\.pwf-taskhead--sticky \{\s*position: static;/);
  });
});
