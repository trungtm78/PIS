import type { ManifestShortcut } from './manifest';
import texts from './manifest-texts.json';

/**
 * The words of the manifest, in Vietnamese (the manifest has one language: `lang` of the page of the installed application). They are read by the build
 * (`vite.pwa.ts`), which has no translator, so they are in `manifest-texts.json` and not in the catalogue; the product name and the short name are not there, they come from
 * the edition manifest (`brand.ts`). The fallback short name is the name under the icon of the home screen when no edition manifest could be loaded (the manifest of each edition says
 * its own: `brand.shortName`); at most 12 characters.
 */
export const FALLBACK_SHORT_NAME: string = texts.fallbackShortName;

export const MANIFEST_DESCRIPTION: string = texts.description;

export const MANIFEST_SHORTCUTS: readonly ManifestShortcut[] = texts.shortcuts;
