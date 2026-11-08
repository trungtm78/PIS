import type { ManifestShortcut } from './manifest';
import texts from './manifest-texts.json';

/**
 * The words of the manifest, in Vietnamese (the manifest has one language: `lang` of the page of the installed application). They are read by the build
 * (`vite.pwa.ts`), which has no translator, so they are in `manifest-texts.json` and not in the catalogue; the product name is not there, it comes from
 * the edition manifest (`brand.ts`).
 */
const SHORT_NAMES: Readonly<Record<string, string>> = texts.shortNames;

/** The name under the icon of the home screen: at most 12 characters. */
export const shortNameOfEdition = (edition: string): string => SHORT_NAMES[edition] ?? SHORT_NAMES.public ?? texts.fallbackShortName;

export const MANIFEST_DESCRIPTION: string = texts.description;

export const MANIFEST_SHORTCUTS: readonly ManifestShortcut[] = texts.shortcuts;
