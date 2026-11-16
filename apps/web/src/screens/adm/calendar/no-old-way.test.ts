import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = __dirname;
const WEB = resolve(HERE, '../../../..');

const sources = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(ts|tsx|css)$/.test(name) ? [path] : [];
  });

const code = sources(resolve(WEB, 'src'))
  .filter((path) => !/no-old-way\.test\.ts$/.test(path))
  .map((path) => ({ path: path.replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }));

/** The files of ADM-07 itself: other screens have their own editors and their own names. */
const calendarCode = code.filter(({ path }) => /\/screens\/adm\/(calendar\/|WorkCalendar)/.test(path));

/**
 * ADM-07 was replaced, not extended (principle 0 of the plan of 16/11/2026): the yearly work calendar is the only way to write a calendar, with no switch to the old register-and-form layout. This test lists what must never come back.
 */
describe('the work calendar has no old way left', () => {
  it('marks no day by clicking a day of the month grid: the grid is a preview and days are added by range', () => {
    const old = calendarCode.filter(({ text }) => /\btoggleDay\b|\bonToggle\b|\bwithYear\b|\bsetHolidayField\b/.test(text));
    expect(old.map((one) => one.path)).toEqual([]);
  });

  it('has no register of versions beside a form, no placeholder note and no "version in view" block', () => {
    const old = calendarCode.filter(({ text }) => /version-in-view|placeholder-note|data-testid="editor"|data-testid="versions"|publish-preview|compensated-list|holiday-list/.test(text));
    expect(old.map((one) => one.path)).toEqual([]);
  });

  it('keeps no key of the catalogues for the words of the old layout', () => {
    const vi = JSON.parse(readFileSync(resolve(WEB, 'src/i18n/vi.json'), 'utf8')) as Record<string, string>;
    const old = Object.keys(vi).filter((key) => /^adm\.calendar\.(versions|form|grid|holidays?|compensated|draft|publish|view|copy|preview|inView|status|placeholder|weekdays|page|readOnly|frozen)\.|^adm\.calendar\.col\.calendar$|^adm\.calendar\.year\.label$|^w2adm\.calendar\./.test(key));
    expect(old).toEqual([]);
  });

  it('publishes through one screen: the two moves are "Lưu lịch" and "Xác nhận năm"', () => {
    expect(existsSync(join(HERE, 'YearEditor.tsx'))).toBe(true);
    expect(existsSync(join(HERE, 'YearList.tsx'))).toBe(true);
    const workspace = readFileSync(resolve(HERE, '../WorkCalendarWorkspace.tsx'), 'utf8');
    expect(workspace).toMatch(/<YearList\b/);
    expect(workspace).toMatch(/<YearEditor\b/);
    expect(workspace).not.toMatch(/\bKitTable\b/);
  });
});
