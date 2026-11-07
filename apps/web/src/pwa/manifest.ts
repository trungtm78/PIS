/** The path the manifest is served at and linked from `index.html`. */
export const MANIFEST_PATH = '/manifest.webmanifest';
/** The page the installed application opens: the start page of the manager screens. `source=pwa` only tells a launch from the home screen. */
export const START_URL = '/m?source=pwa';
/** The identity of the application for the browser: stable across versions, so a change of the start URL does not make it a new application. */
export const APP_ID = '/m';

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: 'any' | 'maskable';
}

/** The files `scripts/generate-pwa-icons.mjs` writes under `public/icons`. */
export const MANIFEST_ICONS: readonly ManifestIcon[] = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
];

export interface ManifestShortcut {
  name: string;
  url: string;
}

export interface ManifestInput {
  /** The name of the product in this edition. */
  name: string;
  /** A shorter name under the icon (at most 12 characters, or the home screen cuts it). */
  shortName: string;
  description: string;
  language?: string;
  shortcuts: readonly ManifestShortcut[];
  /** The tokens of the design the two colours come from (`TOKENS.color.sidebar`, `TOKENS.color.background`). */
  colors: { themeColor: string; backgroundColor: string };
}

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  lang: string;
  dir: 'ltr';
  start_url: string;
  scope: string;
  display: 'standalone';
  background_color: string;
  theme_color: string;
  categories: string[];
  icons: ManifestIcon[];
  shortcuts: Array<ManifestShortcut & { icons: ManifestIcon[] }>;
}

export const SHORT_NAME_MAX = 12;

/** `Đầu tư công` is cut to a word boundary under the limit when the name is longer. */
export function shortNameOf(shortName: string): string {
  const trimmed = shortName.trim();
  if (trimmed.length <= SHORT_NAME_MAX) return trimmed;
  const words = trimmed.split(/\s+/);
  let out = '';
  for (const word of words) {
    const next = out === '' ? word : `${out} ${word}`;
    if (next.length > SHORT_NAME_MAX) break;
    out = next;
  }
  return out === '' ? trimmed.slice(0, SHORT_NAME_MAX) : out;
}

/**
 * The web app manifest (the installability criteria: name, icons of 192 and 512 px, a start URL, `display: standalone`; HTTPS and a service worker are the
 * other two). The colours are the tokens of the design: the bar of the installed application is the colour of the sidebar, the splash is the background.
 */
export function buildManifest(input: ManifestInput): WebManifest {
  return {
    id: APP_ID,
    name: input.name,
    short_name: shortNameOf(input.shortName),
    description: input.description,
    lang: input.language ?? 'vi',
    dir: 'ltr',
    start_url: START_URL,
    scope: '/',
    display: 'standalone',
    background_color: input.colors.backgroundColor,
    theme_color: input.colors.themeColor,
    categories: ['business', 'productivity'],
    icons: [...MANIFEST_ICONS],
    shortcuts: input.shortcuts.map((shortcut) => ({ ...shortcut, icons: [MANIFEST_ICONS[0] as ManifestIcon] })),
  };
}
