import { PDFArray, PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';
import type { PDFDict, PDFRawStream, PDFRef } from 'pdf-lib';

/** One piece of text drawn on a page: where its baseline starts (points) and what it says. */
export interface TextRun {
  page: number;
  x: number;
  y: number;
  size: number;
  text: string;
}

export function decoded(document: PDFDocument, reference: unknown): string {
  const stream = document.context.lookup(reference as PDFRef) as PDFRawStream;
  return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
}

/** The glyph-to-character table (ToUnicode) of every font of a page, by resource name. */
export function unicodeMaps(document: PDFDocument, resources: PDFDict): Map<string, Map<string, string>> {
  const maps = new Map<string, Map<string, string>>();
  const fonts = document.context.lookup(resources.get(PDFName.of('Font'))) as PDFDict;
  for (const [name, reference] of fonts.entries()) {
    const font = document.context.lookup(reference) as PDFDict;
    const table = font.get(PDFName.of('ToUnicode'));
    if (table === undefined) continue;
    const entries = new Map<string, string>();
    for (const match of decoded(document, table).matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4})>/g)) {
      entries.set((match[1] ?? '').toUpperCase(), String.fromCharCode(parseInt(match[2] ?? '0', 16)));
    }
    maps.set(name.decodeText(), entries);
  }
  return maps;
}

/** Every `Tj` of every page of a PDF written by the renderer (embedded fonts, one text run per `drawText`). */
export async function textRuns(bytes: Uint8Array): Promise<TextRun[]> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const runs: TextRun[] = [];
  document.getPages().forEach((page, index) => {
    const resources = document.context.lookup(page.node.get(PDFName.of('Resources'))) as PDFDict;
    const maps = unicodeMaps(document, resources);
    const contents = document.context.lookup(page.node.get(PDFName.of('Contents')));
    const streams = contents instanceof PDFArray ? contents.asArray().map((reference) => decoded(document, reference)) : [decoded(document, contents)];
    for (const block of streams.join('\n').matchAll(/BT([\s\S]*?)ET/g)) {
      const stream = block[1] ?? '';
      const font = /\/(\S+) ([0-9.]+) Tf/.exec(stream);
      const position = /1 0 0 1 ([-0-9.]+) ([-0-9.]+) Tm/.exec(stream);
      const shown = /<([0-9A-Fa-f]*)> Tj/.exec(stream);
      if (font === null || position === null || shown === null) continue;
      const map = maps.get(font[1] ?? '') ?? new Map<string, string>();
      const glyphs = (shown[1] ?? '').match(/.{4}/g) ?? [];
      runs.push({
        page: index + 1,
        x: Number(position[1]),
        y: Number(position[2]),
        size: Number(font[2]),
        text: glyphs.map((glyph) => map.get(glyph.toUpperCase()) ?? '?').join(''),
      });
    }
  });
  return runs;
}
