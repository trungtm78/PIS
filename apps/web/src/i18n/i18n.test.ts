import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from './en.json';
import { createTranslator, t, translator, useTranslation } from './index';
import type { Locale } from './index';
import viCatalogue from './vi.json';

const KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){2,4}$/;

const CATALOGUES: Record<Locale, Record<string, string>> = {
  vi: { 'demo.page.greet.text': 'Xin chào {name}', 'demo.page.only.vi': 'Chỉ có tiếng Việt' },
  en: { 'demo.page.greet.text': 'Hello {name}' },
};

describe('createTranslator', () => {
  it('answers from the current locale', () => {
    const translate = createTranslator({ locale: 'en', catalogues: CATALOGUES });
    expect(translate.t('demo.page.greet.text', { name: 'An' })).toBe('Hello An');
  });

  it('falls back from a missing en key to vi and reports it once per lookup', () => {
    const onMissing = vi.fn();
    const translate = createTranslator({ locale: 'en', catalogues: CATALOGUES, onMissing });
    expect(translate.t('demo.page.only.vi')).toBe('Chỉ có tiếng Việt');
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onMissing).toHaveBeenCalledWith('demo.page.only.vi', 'en');
  });

  it('tells whether a key exists in the locale or in Vietnamese, without reporting or throwing', () => {
    const onMissing = vi.fn();
    const translate = createTranslator({ locale: 'en', catalogues: CATALOGUES, strict: true, onMissing });
    expect(translate.has('demo.page.greet.text')).toBe(true);
    expect(translate.has('demo.page.only.vi')).toBe(true);
    expect(translate.has('demo.page.nope.text')).toBe(false);
    expect(onMissing).not.toHaveBeenCalled();
  });

  it('replaces {name} placeholders, leaves unknown placeholders and accepts numbers', () => {
    const translate = createTranslator({
      locale: 'vi',
      catalogues: { vi: { 'demo.page.count.text': '{count} dòng của {owner}, {missing}' }, en: {} },
    });
    expect(translate.t('demo.page.count.text', { count: 3, owner: 'Sở' })).toBe('3 dòng của Sở, {missing}');
  });

  it('throws for an unknown key when strict, and returns the key and reports it otherwise', () => {
    const onMissing = vi.fn();
    const strict = createTranslator({ locale: 'vi', catalogues: CATALOGUES, strict: true, onMissing });
    expect(() => strict.t('demo.page.nope.text')).toThrow('demo.page.nope.text');

    const lenient = createTranslator({ locale: 'vi', catalogues: CATALOGUES, onMissing });
    expect(lenient.t('demo.page.nope.text')).toBe('demo.page.nope.text');
    expect(onMissing).toHaveBeenCalledWith('demo.page.nope.text', 'vi');
  });

  it('notifies subscribers when the locale changes, not when it stays the same, and stops after unsubscribe', () => {
    const translate = createTranslator({ locale: 'vi', catalogues: CATALOGUES });
    const listener = vi.fn();
    const unsubscribe = translate.subscribe(listener);
    translate.setLocale('vi');
    expect(listener).not.toHaveBeenCalled();
    translate.setLocale('en');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(translate.getLocale()).toBe('en');
    expect(translate.t('demo.page.greet.text', { name: 'An' })).toBe('Hello An');
    unsubscribe();
    translate.setLocale('vi');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('the application catalogues', () => {
  it('hold the same keys in Vietnamese and English, all in module.screen.action.state form', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(viCatalogue).sort());
    for (const key of Object.keys(viCatalogue)) expect(key).toMatch(KEY_PATTERN);
  });

  it('are strict under test, so an unknown key fails loudly', () => {
    expect(() => t('shell.nothing.here.text')).toThrow('shell.nothing.here.text');
  });
});

describe('useTranslation', () => {
  afterEach(() => {
    act(() => translator.setLocale('vi'));
  });

  it('renders Vietnamese first and re-renders when the locale changes', () => {
    const { result } = renderHook(() => useTranslation());
    expect(result.current.locale).toBe('vi');
    expect(result.current.t('shell.app.name.title')).toBe(viCatalogue['shell.app.name.title']);
    act(() => result.current.setLocale('en'));
    expect(result.current.locale).toBe('en');
    expect(result.current.t('shell.app.name.title')).toBe(en['shell.app.name.title']);
  });
});
