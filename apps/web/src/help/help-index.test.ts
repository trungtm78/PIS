import { describe, expect, it } from 'vitest';
import { WEB_ROUTES } from '../routes/web-routes';
import { applyHelpOverlay, helpFor, loadHelpIndex } from './help-index';

describe('help index', () => {
  it('has a guide for every web screen of the route table', async () => {
    const index = await loadHelpIndex('vi');
    const missing = WEB_ROUTES.filter((route) => helpFor(index, route.id) === undefined).map((route) => route.id);
    expect(missing).toEqual([]);
  });

  it('gives every guide its purpose, audience, steps and fields', async () => {
    const index = await loadHelpIndex('vi');
    for (const route of WEB_ROUTES) {
      const help = helpFor(index, route.id);
      expect(help?.title, route.id).toBe(route.title);
      expect(help?.purpose.length, route.id).toBeGreaterThan(0);
      expect(help?.audience.length, route.id).toBeGreaterThan(0);
      expect(help?.steps.length, route.id).toBeGreaterThan(0);
      expect(help?.fields.length, route.id).toBeGreaterThan(0);
    }
  });

  it('reads the Vietnamese file for a language without a file of its own, once', async () => {
    const english = await loadHelpIndex('en');
    expect(english.locale).toBe('vi');
    expect(await loadHelpIndex('vi')).toBe(english);
  });

  it('joins the entry with the steps of its kind and the shared tips', async () => {
    const index = await loadHelpIndex('vi');
    const help = helpFor(index, 'ADM-06');
    expect(help?.steps).toEqual(index.kinds.workflow?.steps);
    expect(help?.tips).toBe(index.tips);
    expect(help?.id).toBe('ADM-06');
  });

  it('returns nothing for an address that is not a screen and for an unknown id', async () => {
    const index = await loadHelpIndex('vi');
    expect(helpFor(index, undefined)).toBeUndefined();
    expect(helpFor(index, 'NOPE-99')).toBeUndefined();
  });
});

describe('applyHelpOverlay', () => {
  it('returns the index itself without an overlay', async () => {
    const index = await loadHelpIndex('vi');
    expect(applyHelpOverlay(index, undefined)).toBe(index);
  });

  it('replaces the fields of a screen first, then the terms in every text, keeping a capital first letter, and leaves the loaded index untouched', async () => {
    const index = await loadHelpIndex('vi');
    const before = JSON.stringify(index);
    const said = applyHelpOverlay(index, { screens: { 'HOME-07': { fields: ['Một', 'Hai'] } }, terms: [['Kho bạc', 'kế toán'], ['Sở Tài chính', 'Phòng Tài chính']] });
    expect(said.screens['HOME-07']?.fields).toEqual(['Một', 'Hai']);
    expect(said.screens['PRJ-01']?.audience).toBe('Chủ đầu tư và Phòng Tài chính');
    expect(said.screens['PAY-17']?.fields).toContain('Kế toán');
    expect(said.screens['PAY-01']?.moduleName).toBe('Thanh toán và kế toán');
    expect(JSON.stringify(index)).toBe(before);
  });
});
