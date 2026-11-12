import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { resolveBrand } from './src/pwa/brand';
import type { EditionBrandSource } from './src/pwa/brand';
import { buildManifest, MANIFEST_PATH } from './src/pwa/manifest';
import { MANIFEST_DESCRIPTION, MANIFEST_SHORTCUTS, FALLBACK_SHORT_NAME } from './src/pwa/manifest-texts';

const WEB_ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EDITION_MODULE = join(REPO_ROOT, 'packages', 'kernel', 'src', 'edition.ts');
const ENTERPRISE_MODULE = join(REPO_ROOT, 'packages', 'edition-enterprise', 'src', 'index.ts');
const TOKENS_JSON = join(REPO_ROOT, 'Design', 'MACHVON_Design', '04_Design_Assets', 'design_tokens.json');
const SHELL_BRAND_KEY = 'shell.app.name.title';
/** The fonts of the shell: the Latin and Vietnamese subsets are what every Vietnamese screen needs. */
const SHELL_FONT = /^be-vietnam-pro-(?:latin|vietnamese)-\d+\.woff2$/;
const SHELL_ICONS = ['/icons/icon-192.png'];

/** The part of a Rollup output the plan reads. */
export interface BundleItem {
  type: 'chunk' | 'asset';
  fileName: string;
  isEntry?: boolean;
  imports?: readonly string[];
  viteMetadata?: { importedCss?: ReadonlySet<string>; importedAssets?: ReadonlySet<string> };
  source?: string | Uint8Array;
}

/**
 * The files of the shell: the page, the entry script with the scripts it imports statically, their styles and assets, the fonts and the icon of a
 * notification. The screens are lazy chunks and are not here: they are kept as they are used (the static cache), so that the install stays small.
 */
export function shellFiles(bundle: Readonly<Record<string, BundleItem>>, fonts: readonly string[]): string[] {
  const files = new Set<string>(['/index.html']);
  const seen = new Set<string>();
  const addChunk = (fileName: string): void => {
    if (seen.has(fileName)) return;
    seen.add(fileName);
    files.add(`/${fileName}`);
    const item = bundle[fileName];
    if (item === undefined) return;
    for (const imported of item.imports ?? []) addChunk(imported);
    for (const css of item.viteMetadata?.importedCss ?? []) files.add(`/${css}`);
    for (const asset of item.viteMetadata?.importedAssets ?? []) files.add(`/${asset}`);
  };
  for (const item of Object.values(bundle)) if (item.type === 'chunk' && item.isEntry === true) addChunk(item.fileName);
  for (const font of fonts) files.add(`/fonts/${font}`);
  for (const icon of SHELL_ICONS) files.add(icon);
  return [...files].sort();
}

/** A short hash of the files of the shell and of the page itself: it changes when the shell does, which is what makes the browser install the new worker. */
export function buildIdOf(precache: readonly string[], page: string): string {
  return createHash('sha256').update(JSON.stringify(precache)).update(page).digest('hex').slice(0, 12);
}

export interface WorkerBuild {
  buildId: string;
  precache: readonly string[];
  appName: string;
}

/** Bundles `src/pwa/sw.ts` (with `cache-policy.ts`, `push-payload.ts`...) to one self-contained script with the three constants of the build defined. */
export async function bundleServiceWorker(input: WorkerBuild): Promise<string> {
  // esbuild comes with Vite; the build is the only place that needs it.
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [join(WEB_ROOT, 'src', 'pwa', 'sw.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2020',
    minify: true,
    charset: 'utf8',
    legalComments: 'none',
    define: {
      __MV_BUILD_ID__: JSON.stringify(input.buildId),
      __MV_PRECACHE__: JSON.stringify(input.precache),
      __MV_APP_NAME__: JSON.stringify(input.appName),
      // Where the worker posts the receipt of a push: the API base of the build, empty for the same origin.
      __MV_API_BASE__: JSON.stringify(process.env.VITE_API_BASE_URL ?? ''),
    },
    logLevel: 'silent',
  });
  const output = result.outputFiles?.[0];
  if (output === undefined) throw new Error('the service worker did not bundle');
  return output.text;
}

function readShellBrand(): string {
  const catalogue = JSON.parse(readFileSync(join(WEB_ROOT, 'src', 'i18n', 'vi.json'), 'utf8')) as Record<string, string>;
  const partsDir = join(WEB_ROOT, 'src', 'i18n', 'parts');
  const parts = existsSync(partsDir) ? readdirSync(partsDir).filter((name) => name.endsWith('.vi.json')) : [];
  for (const name of parts) {
    const part = JSON.parse(readFileSync(join(partsDir, name), 'utf8')) as Record<string, string>;
    if (part[SHELL_BRAND_KEY] !== undefined && catalogue[SHELL_BRAND_KEY] === undefined) catalogue[SHELL_BRAND_KEY] = part[SHELL_BRAND_KEY];
  }
  const brand = catalogue[SHELL_BRAND_KEY];
  if (brand === undefined) throw new Error(`the catalogue has no text for ${SHELL_BRAND_KEY}`);
  return brand;
}

/** Bundles a TypeScript module of the repository and loads it in this process (the build is the only place that needs it). */
async function loadModule(entry: string): Promise<Record<string, unknown>> {
  const { build } = await import('esbuild');
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  const code = result.outputFiles?.[0]?.text ?? '';
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as Record<string, unknown>;
}

/**
 * The manifest of the edition being built (`VITE_EDITION`, as `main.tsx` reads it: public when unset, an unknown value fails the build), or undefined when
 * the edition module cannot be loaded; the build then warns and the shell brand key names the application.
 */
async function loadEditionManifest(warn: (message: string) => void): Promise<EditionBrandSource | undefined> {
  if (!existsSync(EDITION_MODULE)) return undefined;
  try {
    const kernel = (await loadModule(EDITION_MODULE)) as {
      resolveEdition(env: Record<string, string | undefined>, variable: string): string;
      PUBLIC_EDITION_MANIFEST: EditionBrandSource;
    };
    const edition = kernel.resolveEdition({ VITE_EDITION: process.env.VITE_EDITION }, 'VITE_EDITION');
    if (edition === 'public') return kernel.PUBLIC_EDITION_MANIFEST;
    const enterprise = (await loadModule(ENTERPRISE_MODULE)) as { ENTERPRISE_EDITION_MANIFEST: EditionBrandSource };
    return enterprise.ENTERPRISE_EDITION_MANIFEST;
  } catch (error) {
    // An edition that is not one stops `main.tsx` at start; the manifest does not repeat that, it only falls back.
    warn(`pwa: the edition manifest could not be loaded (${error instanceof Error ? error.message : String(error)}); the shell brand key names the application`);
    return undefined;
  }
}

function colors(): { themeColor: string; backgroundColor: string } {
  const tokens = JSON.parse(readFileSync(TOKENS_JSON, 'utf8')) as { color: { sidebar: string; background: string } };
  return { themeColor: tokens.color.sidebar, backgroundColor: tokens.color.background };
}

async function manifestJson(warn: (message: string) => void): Promise<{ text: string; appName: string }> {
  const edition = await loadEditionManifest(warn);
  const brand = resolveBrand(edition, readShellBrand(), FALLBACK_SHORT_NAME);
  const base = colors();
  const manifest = buildManifest({
    name: brand.name,
    shortName: brand.shortName,
    description: MANIFEST_DESCRIPTION,
    shortcuts: MANIFEST_SHORTCUTS,
    colors: { themeColor: brand.themeColor ?? base.themeColor, backgroundColor: base.backgroundColor },
  });
  return { text: `${JSON.stringify(manifest, null, 2)}
`, appName: brand.name };
}

/**
 * The PWA of the build (YCK.01): the web app manifest (named for the edition) and the service worker, both emitted at the root of the build, the worker
 * with the list of the shell files and an id that changes with them. In the development server only the manifest is served; the worker is registered in
 * production builds only (`register.ts`), so a development session never runs behind a cache.
 */
export function pwaPlugin(): Plugin {
  return {
    name: 'machvon-pwa',
    configureServer(server) {
      server.middlewares.use(MANIFEST_PATH, (_request, response) => {
        void manifestJson((message) => server.config.logger.warn(message)).then(({ text }) => {
          response.setHeader('content-type', 'application/manifest+json; charset=utf-8');
          response.end(text);
        });
      });
    },
    // After the plugin that emits `index.html`, whose content is part of the build id.
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const warn = (message: string): void => this.warn(message);
        const { text, appName } = await manifestJson(warn);
        this.emitFile({ type: 'asset', fileName: MANIFEST_PATH.slice(1), source: text });
        const fontsDir = join(WEB_ROOT, 'public', 'fonts');
        const fonts = existsSync(fontsDir) ? readdirSync(fontsDir).filter((name) => SHELL_FONT.test(name)) : [];
        const items = bundle as unknown as Record<string, BundleItem>;
        const precache = shellFiles(items, fonts);
        const page = items['index.html']?.source;
        const buildId = buildIdOf(precache, typeof page === 'string' ? page : page === undefined ? '' : Buffer.from(page).toString('utf8'));
        this.emitFile({ type: 'asset', fileName: 'sw.js', source: await bundleServiceWorker({ buildId, precache, appName }) });
      },
    },
  };
}
