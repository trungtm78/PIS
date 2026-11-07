import { useSyncExternalStore } from 'react';
import en from './en.json';
import vi from './vi.json';

/**
 * Strings added by a work in progress live in `parts/<name>.vi.json` and `parts/<name>.en.json`, so that people working in parallel never edit the one big catalogue;
 * `scripts/fold-i18n-parts.mjs` folds them into `vi.json` and `en.json`. A part never replaces a key of the catalogue.
 */
const viParts = import.meta.glob<Record<string, string>>('./parts/*.vi.json', { eager: true, import: 'default' });
const enParts = import.meta.glob<Record<string, string>>('./parts/*.en.json', { eager: true, import: 'default' });
/**
 * The keys of the parts that the catalogue does not hold yet are added to the catalogue object itself (a key of the catalogue is never replaced), so the translator and a test that adds
 * the title of an event type to the imported catalogue read the same object whether or not a part is waiting to be folded.
 */
const withParts = (base: Record<string, string>, parts: Record<string, Record<string, string>>): Record<string, string> => {
  const added = Object.assign({}, ...Object.values(parts)) as Record<string, string>;
  for (const [key, text] of Object.entries(added)) if (!(key in base)) base[key] = text;
  return base;
};
const viAll = withParts(vi, viParts);
const enAll = withParts(en, enParts);

export type Locale = 'vi' | 'en';
/** The keys of the Vietnamese catalogue, the default locale and the reference for the English one. */
export type MessageKey = keyof typeof vi;
export type Catalogue = Readonly<Record<string, string>>;
export type TranslationParams = Readonly<Record<string, string | number>>;

export interface TranslatorOptions {
  locale: Locale;
  catalogues: Readonly<Record<Locale, Catalogue>>;
  /** The terminology overlay of the product edition (ENT-0), read before the catalogue; it replaces words, it never adds a key. */
  overlay?: Readonly<Record<Locale, Catalogue>>;
  /** Throw for a key no catalogue holds (tests); otherwise return the key itself. */
  strict?: boolean;
  /** Called when a lookup fell back to Vietnamese or found nothing. */
  onMissing?: (key: string, locale: Locale) => void;
}

export interface Translator {
  t(key: string, params?: TranslationParams): string;
  /** Whether a catalogue holds the key (in the current locale or in Vietnamese); for keys that arrive from the server. */
  has(key: string): boolean;
  setLocale(locale: Locale): void;
  getLocale(): Locale;
  /** Installs (or, with undefined, removes) the terminology overlay of the edition and tells the listeners. */
  setOverlay(overlay: Readonly<Record<Locale, Catalogue>> | undefined): void;
  subscribe(listener: () => void): () => void;
}

const DEFAULT_LOCALE: Locale = 'vi';
const PLACEHOLDER = /\{(\w+)\}/g;

function interpolate(template: string, params: TranslationParams | undefined): string {
  if (params === undefined) return template;
  return template.replace(PLACEHOLDER, (placeholder, name: string) => (name in params ? String(params[name]) : placeholder));
}

export function createTranslator(options: TranslatorOptions): Translator {
  let locale = options.locale;
  let overlay = options.overlay;
  const listeners = new Set<() => void>();

  const lookup = (key: string, params: TranslationParams | undefined): string => {
    const own = overlay?.[locale][key] ?? options.catalogues[locale][key];
    if (own !== undefined) return interpolate(own, params);
    const fallback = overlay?.[DEFAULT_LOCALE][key] ?? options.catalogues[DEFAULT_LOCALE][key];
    if (fallback !== undefined) {
      options.onMissing?.(key, locale);
      return interpolate(fallback, params);
    }
    if (options.strict === true) throw new Error(`Unknown translation key: ${key}`);
    options.onMissing?.(key, locale);
    return key;
  };

  return {
    t: lookup,
    has: (key) => options.catalogues[locale][key] !== undefined || options.catalogues[DEFAULT_LOCALE][key] !== undefined,
    getLocale: () => locale,
    setOverlay(next) {
      overlay = next;
      listeners.forEach((listener) => listener());
    },
    setLocale(next) {
      if (next === locale) return;
      locale = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The application translator: Vietnamese by default, strict under test so an unknown key fails the test. */
export const translator = createTranslator({
  locale: DEFAULT_LOCALE,
  catalogues: { vi: viAll, en: enAll },
  strict: import.meta.env.MODE === 'test',
  onMissing: (key, locale) => {
    if (import.meta.env.DEV) console.warn(`Missing translation: ${key} [${locale}]`);
  },
});

export const t = translator.t;
export const hasMessage = translator.has;

export function useTranslation(): { t: Translator['t']; locale: Locale; setLocale: Translator['setLocale'] } {
  const locale = useSyncExternalStore(translator.subscribe, translator.getLocale);
  return { t: translator.t, locale, setLocale: translator.setLocale };
}
