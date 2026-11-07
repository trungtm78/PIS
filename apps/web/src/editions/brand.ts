import { PUBLIC_EDITION_MANIFEST } from '@machvon/kernel/src/edition.ts';
import type { EditionManifest } from '@machvon/kernel/src/edition.ts';

/** The icon of the browser tab: the mark of the edition on its colour, the same drawing as the one of `index.html`. */
export function faviconHref(mark: string, color: string): string {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='" +
    color +
    "'/><text x='16' y='22' font-family='Segoe UI,Arial' font-size='14' font-weight='700' fill='white' text-anchor='middle'>" +
    mark +
    '</text></svg>';
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
export function applyBrand(doc: Document, manifest: EditionManifest, language: string): void {
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
  icon.setAttribute('href', faviconHref(language === 'en' ? manifest.brand.mark.en : manifest.brand.mark.vi, manifest.brand.themeColor));
}
