import type { ExtractedUnit, RepositoryFormat } from '@machvon/kernel';

/**
 * The text of a file of the project repository (DOC-2, PD.01): the port every reader of text goes behind. A reader is handed the bytes of a file that the scan found clean, in the process of the API, and gives back
 * the units of text it found, each with where it sits (page and paragraph, table cell, sheet cell) and, for a page, the box it occupies. It never sends a byte anywhere: an engine that does OCR on scans is bound here
 * as a reader hosted by the tenant (docs/doc-repository.md section 3); until one is bound, the local reader reads the text layer of a PDF and a scan has no text, which the repository shows as "needs OCR".
 */

/** The injection token of the reader the repository uses. */
export const DOC_TEXT_EXTRACTION = Symbol('DOC_TEXT_EXTRACTION');

export interface TextExtractionInput {
  bytes: Uint8Array;
  format: RepositoryFormat;
  /** The SHA-256 of the bytes: a reader that looks results up by file (the mock) keys on it. */
  sha256: string;
}

export interface TextExtraction {
  /** FAILED: the file could not be read at all (damaged, encrypted, a bomb). A file read with no text is OK with no units. */
  status: 'OK' | 'FAILED';
  units: ExtractedUnit[];
  /** Units the reader left out because the file holds more than a version may keep. */
  omitted: number;
  /** The pages of a PDF; null for a format that has none. */
  pageCount: number | null;
  engine: { name: string; version: string };
  /** Why a reading failed, as a stable word for the log (never shown with file content). */
  failure?: 'UNREADABLE' | 'ENCRYPTED' | 'TOO_LARGE';
}

export interface DocumentTextExtractionPort {
  extract(input: TextExtractionInput): Promise<TextExtraction>;
}

/** The MOCK reader: what a test registers for a file (by its SHA-256), and nothing for any other file. */
export class MockTextExtractionPort implements DocumentTextExtractionPort {
  private readonly readings = new Map<string, TextExtraction>();
  readonly calls: string[] = [];

  /** Makes the reader answer `reading` for the file with this SHA-256. */
  register(sha256: string, reading: Partial<TextExtraction> & { units: ExtractedUnit[] }): void {
    this.readings.set(sha256, { status: 'OK', omitted: 0, pageCount: null, engine: { name: 'mock-reader', version: '1' }, ...reading });
  }

  extract(input: TextExtractionInput): Promise<TextExtraction> {
    this.calls.push(input.sha256);
    return Promise.resolve(this.readings.get(input.sha256) ?? { status: 'OK', units: [], omitted: 0, pageCount: null, engine: { name: 'mock-reader', version: '1' } });
  }
}
