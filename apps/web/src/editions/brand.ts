import { PUBLIC_EDITION_MANIFEST } from '@machvon/kernel/src/edition.ts';
import type { EditionManifest } from '@machvon/kernel/src/edition.ts';
import { paletteOf } from '../brand/palettes';
import { iconSvg } from '../pwa/icon-art';

/** The icon of the browser tab: the master mark on the tile of the edition (`src/pwa/icon-art.ts`), the same drawing as `/icons/icon.svg` of the public edition. */
export function faviconHref(edition: string, color: string): string {
  const svg = iconSvg({ ...paletteOf(edition).mark, background: color });
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function headElement(doc: Document, selector: string, create: () => HTMLElement): HTMLElement {
  const found = doc.head.querySelector<HTMLElement>(selector);
  if (found !== null) return found;
  const created = create();
  doc.head.appendChild(created);
  return created;
}

/**
 * Puts the brand of the edition in the head of the document: the colour of the browser chrome and the icon of the tab. The public edition keeps
 * what `index.html` already says, so nothing is touched for it. The title is set by the application from the translator (the overlay says it).
 */
export function applyBrand(doc: Document, manifest: EditionManifest): void {
  if (manifest === PUBLIC_EDITION_MANIFEST) return;
  const color = headElement(doc, 'meta[name="theme-color"]', () => {
    const meta = doc.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    return meta;
  });
  color.setAttribute('content', manifest.brand.themeColor);
  const icon = headElement(doc, 'link[rel="icon"]', () => {
    const link = doc.createElement('link');
    link.setAttribute('rel', 'icon');
    link.setAttribute('type', 'image/svg+xml');
    return link;
  });
  icon.setAttribute('href', faviconHref(manifest.edition, manifest.brand.themeColor));
}
