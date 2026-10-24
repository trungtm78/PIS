import { PDFArray, PDFDocument, PDFName } from 'pdf-lib';
import type { PDFDict } from 'pdf-lib';
import { decoded, unicodeMaps } from './pdf-text';

/**
 * Every text of every page of a PDF written by the renderer, in drawing order, whatever its position or rotation: the
 * rotated watermark of BR-DOC-10 is among them (textRuns only reads the unrotated runs).
 */
export async function pageTexts(bytes: Uint8Array): Promise<string[][]> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return document.getPages().map((page) => {
    const resources = document.context.lookup(page.node.get(PDFName.of('Resources'))) as PDFDict;
    const maps = unicodeMaps(document, resources);
    const contents = document.context.lookup(page.node.get(PDFName.of('Contents')));
    const streams = contents instanceof PDFArray ? contents.asArray().map((reference) => decoded(document, reference)) : [decoded(document, contents)];
    const texts: string[] = [];
    for (const block of streams.join('\n').matchAll(/BT([\s\S]*?)ET/g)) {
      const stream = block[1] ?? '';
      const font = /\/(\S+) ([0-9.]+) Tf/.exec(stream);
      const shown = /<([0-9A-Fa-f]*)> Tj/.exec(stream);
      if (font === null || shown === null) continue;
      const map = maps.get(font[1] ?? '') ?? new Map<string, string>();
      texts.push(((shown[1] ?? '').match(/.{4}/g) ?? []).map((glyph) => map.get(glyph.toUpperCase()) ?? '?').join(''));
    }
    return texts;
  });
}
