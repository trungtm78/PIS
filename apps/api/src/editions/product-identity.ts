import { PUBLIC_EDITION_MANIFEST, openApiTitleOf, productNameOf } from '@machvon/kernel';
import type { EditionManifest } from '@machvon/kernel';

/**
 * The product name this process shows to the people who open what it produces: the properties of an exported file (the author and the producer of a workbook, a Word file, a PDF) and the title
 * of the open API document. It is the name of the edition manifest the application is registered with (`AppModule.register`), never a code name: the public product shows none. A process serves
 * one edition, so the manifest is held here once and the writers, which are plain functions, read it from here instead of each carrying a literal.
 */
let served: EditionManifest = PUBLIC_EDITION_MANIFEST;

/** Names the edition this process serves (the public one until told otherwise). */
export function serveEdition(manifest: EditionManifest | undefined): void {
  served = manifest ?? PUBLIC_EDITION_MANIFEST;
}

/** The author and producer written into the properties of an exported file: the name of the product of the edition, in Vietnamese. */
export function documentProducer(): string {
  return productNameOf(served, 'vi');
}

/** The title of the open API document the edition serves: the English name of the product and "open API". */
export function openApiTitle(): string {
  return openApiTitleOf(served);
}
