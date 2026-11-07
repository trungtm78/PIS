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

  it('says the product name of the manifest where the shell and the tab say it', () => {
    expect(viOverlay['shell.brand.name.text']).toBe(enterpriseBundle.manifest.productName.vi);
    expect(viOverlay['shell.app.name.title']).toBe(enterpriseBundle.manifest.productName.vi);
    expect(enOverlay['shell.brand.name.text']).toBe(enterpriseBundle.manifest.productName.en);
    expect(enOverlay['shell.app.name.title']).toBe(enterpriseBundle.manifest.productName.en);
    expect(viOverlay['shell.brand.mark.text']).toBe(enterpriseBundle.manifest.brand.mark.vi);
    expect(enOverlay['shell.brand.mark.text']).toBe(enterpriseBundle.manifest.brand.mark.en);
  });

  it('is what the translator says once the bundle is installed, and the public words come back when it is removed', () => {
    installEdition(enterpriseBundle);
    expect(translator.t('shell.brand.name.text')).toBe('Phần mềm quản lý đầu tư xây dựng');
    expect(translator.t('shell.brand.home.label')).toBe('Phần mềm quản lý đầu tư xây dựng: trang chủ');
    resetEdition();
    expect(translator.t('shell.brand.name.text')).toBe(vi['shell.brand.name.text']);
  });
});
