import { overlayProblems } from '@machvon/kernel/src/edition.ts';
import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import vi from '../i18n/vi.json';
import { installEdition, resetEdition } from './edition';
import { enterpriseBundle } from './enterprise';
import enOverlay from './enterprise/overlay.en.json';
import viOverlay from './enterprise/overlay.vi.json';
import { translator } from '../i18n/index';

// This test names the enterprise folder, so it carries `.enterprise.` in its name: the edition check lets only such tests, the loader and the folder itself do so.
describe('the enterprise web overlay', () => {
  const listed = enterpriseBundle.manifest.terminology.web;

  it('holds exactly the keys the manifest lists, in both languages', () => {
    expect(Object.keys(viOverlay).sort()).toEqual([...listed].sort());
    expect(Object.keys(enOverlay).sort()).toEqual([...listed].sort());
  });

  it('replaces keys of the catalogue and adds none (the catalogue stays the base)', () => {
    expect(overlayProblems(listed, viOverlay, vi)).toEqual({ unlisted: [], missing: [], unknownToBase: [] });
    expect(overlayProblems(listed, enOverlay, en)).toEqual({ unlisted: [], missing: [], unknownToBase: [] });
  });

  it('keeps the placeholders of the key it replaces, and a text for each', () => {
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
    for (const key of listed) {
      expect(placeholders((viOverlay as Record<string, string>)[key] ?? '')).toEqual(placeholders((vi as Record<string, string>)[key] ?? ''));
      expect(placeholders((enOverlay as Record<string, string>)[key] ?? '')).toEqual(placeholders((en as Record<string, string>)[key] ?? ''));
      expect(((viOverlay as Record<string, string>)[key] ?? '').trim()).not.toBe('');
      expect(((enOverlay as Record<string, string>)[key] ?? '').trim()).not.toBe('');
    }
  });

  it('says the logo label and the tagline of the manifest: the enterprise keeps its own identity under the icon and in the logo', () => {
    const { brand, productName } = enterpriseBundle.manifest;
    expect((viOverlay as Record<string, string>)['logo.mark.alt']?.replace('{product}', productName.vi)).toBe(brand.logoAlt.vi);
    expect((enOverlay as Record<string, string>)['logo.mark.alt']?.replace('{product}', productName.en)).toBe(brand.logoAlt.en);
    expect((vi as Record<string, string>)['logo.tagline.enterprise']).toBe(brand.tagline.vi);
    expect((en as Record<string, string>)['logo.tagline.enterprise']).toBe(brand.tagline.en);
  });

  it('says the product name of the manifest where the shell and the tab say it', () => {
    expect(viOverlay['shell.brand.name.text']).toBe(enterpriseBundle.manifest.productName.vi);
    expect(viOverlay['shell.app.name.title']).toBe(enterpriseBundle.manifest.productName.vi);
    expect(enOverlay['shell.brand.name.text']).toBe(enterpriseBundle.manifest.productName.en);
    expect(enOverlay['shell.app.name.title']).toBe(enterpriseBundle.manifest.productName.en);
    expect(viOverlay['shell.brand.mark.text']).toBe(enterpriseBundle.manifest.brand.mark.vi);
    expect(enOverlay['shell.brand.mark.text']).toBe(enterpriseBundle.manifest.brand.mark.en);
  });

  it('takes the Treasury and the Prime Minister out of the words of the home screens an enterprise reads (HOME-09, HOME-01)', () => {
    installEdition(enterpriseBundle);
    try {
      for (const key of listed.filter((one) => one.startsWith('home.') || one.startsWith('govc.home.'))) {
        const said = translator.t(key, { date: '10/11/2026', pm: '1', group: 'A' });
        expect(said, key).not.toMatch(/Kho bạc|Thủ tướng/u);
      }
      expect(translator.t('home.ov.hero.caption', { date: '10/11/2026' })).toBe('Theo số liệu đã chốt đến 10/11/2026');
    } finally {
      resetEdition();
    }
    expect(translator.t('home.ov.hero.ring')).toBe(vi['home.ov.hero.ring']);
  });

  it('says nothing of the national target programmes on CAP-03 and nothing of the Prime Minister, the Treasury or the local plan in the evidence of HOME-06', () => {
    installEdition(enterpriseBundle);
    try {
      for (const key of ['cap.annual.page.subtitle', 'cap.annual.total.note']) expect(translator.t(key), key).not.toMatch(/CTMTQG/u);
      for (const key of ['home.profile.evidence.planPm', 'home.profile.evidence.disbursed', 'home.profile.evidence.ratePm']) expect(translator.t(key), key).not.toMatch(/Kho bạc|Thủ tướng|địa phương/u);
    } finally {
      resetEdition();
    }
    expect(translator.t('cap.annual.total.note')).toBe(vi['cap.annual.total.note']);
  });

  it('is what the translator says once the bundle is installed, and the public words come back when it is removed', () => {
    installEdition(enterpriseBundle);
    expect(translator.t('shell.brand.name.text')).toBe('Phần mềm quản lý đầu tư xây dựng');
    expect(translator.t('shell.brand.home.label')).toBe('Phần mềm quản lý đầu tư xây dựng: trang chủ');
    resetEdition();
    expect(translator.t('shell.brand.name.text')).toBe(vi['shell.brand.name.text']);
  });
});

describe('the enterprise way of drawing the figures of the home screens', () => {
  it('groups the digits of a sum and leaves out the blocks of the public plan', () => {
    expect(enterpriseBundle.slots?.homeFigures).toEqual({ groupDigits: true, publicPlanBlocks: false, treasuryBlocks: false, useDisbursed: expect.any(Function) });
    expect(enterpriseBundle.slots?.fundingStructure).toBeDefined();
  });
});
