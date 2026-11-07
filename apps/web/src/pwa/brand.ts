/**
 * The name and colour of the product in the manifest. The edition mechanism (ENT-0, `packages/kernel/src/edition.ts`) names the product for each edition,
 * so the manifest of the installed application is named like the shell and the browser tab of that edition. When the manifest of an edition cannot be
 * loaded the shell brand key `shell.app.name.title` of the catalogue names it, so the build never produces an unnamed application.
 */

/** The part of an edition manifest (`EditionManifest` of the kernel) the manifest of the application reads. */
export interface EditionBrandSource {
  readonly edition: string;
  readonly productName: { readonly vi: string };
  readonly brand: { readonly themeColor: string };
}

export interface Brand {
  name: string;
  /** The colour of the bar of the installed application; absent when the edition gave none (the sidebar token stands in). */
  themeColor: string | undefined;
  /** The edition the name belongs to, or `shell` when the shell brand key stood in. */
  from: string;
}

export function resolveBrand(manifest: EditionBrandSource | undefined, shellBrand: string): Brand {
  if (manifest === undefined || manifest.productName.vi.trim() === '') return { name: shellBrand, themeColor: undefined, from: 'shell' };
  return { name: manifest.productName.vi.trim(), themeColor: manifest.brand.themeColor, from: manifest.edition };
}
