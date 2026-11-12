/**
 * The name and colour of the product in the manifest. The edition mechanism (ENT-0, `packages/kernel/src/edition.ts`) names the product for each edition,
 * so the manifest of the installed application is named like the shell and the browser tab of that edition. When the manifest of an edition cannot be
 * loaded the shell brand key `shell.app.name.title` of the catalogue names it, so the build never produces an unnamed application.
 */

/** The part of an edition manifest (`EditionManifest` of the kernel) the manifest of the application reads. */
export interface EditionBrandSource {
  readonly edition: string;
  readonly productName: { readonly vi: string };
  readonly brand: { readonly themeColor: string; readonly shortName: { readonly vi: string } };
}

export interface Brand {
  name: string;
  /** The name under the icon of the home screen (`brand.shortName` of the edition manifest); the fallback names it when no edition manifest could be loaded. */
  shortName: string;
  /** The colour of the bar of the installed application; absent when the edition gave none (the sidebar token stands in). */
  themeColor: string | undefined;
  /** The edition the name belongs to, or `shell` when the shell brand key stood in. */
  from: string;
}

export function resolveBrand(manifest: EditionBrandSource | undefined, shellBrand: string, fallbackShortName: string): Brand {
  if (manifest === undefined || manifest.productName.vi.trim() === '') return { name: shellBrand, shortName: fallbackShortName, themeColor: undefined, from: 'shell' };
  const shortName = manifest.brand.shortName.vi.trim();
  return { name: manifest.productName.vi.trim(), shortName: shortName === '' ? fallbackShortName : shortName, themeColor: manifest.brand.themeColor, from: manifest.edition };
}
