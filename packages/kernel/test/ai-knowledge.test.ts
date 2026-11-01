import { EMBEDDING_DIMENSION, MAX_CHUNKS_PER_ITEM, MAX_CHUNK_CHARS, assertEmbedding, assertWithin, checkCollection, chunkPages, retrievalLimit } from '../src/ai-knowledge.ts';

const M1 = '00000000-0000-4000-8000-000000000001';
const thrown = (run: () => unknown): { code: string; status: number; detail?: string } => {
  try {
    run();
  } catch (error) {
    return error as never;
  }
  throw new Error('nothing was thrown');
};

describe('the classification a collection takes and the collection itself', () => {
  it('takes a classification up to the ceiling and refuses one above it (CLASSIFICATION_ABOVE_COLLECTION)', () => {
    expect(() => assertWithin('INTERNAL', 'INTERNAL')).not.toThrow();
    expect(() => assertWithin('PUBLIC', 'CONFIDENTIAL')).not.toThrow();
    expect(thrown(() => assertWithin('CONFIDENTIAL', 'INTERNAL'))).toMatchObject({ code: 'CLASSIFICATION_ABOVE_COLLECTION', status: 422 });
    expect(thrown(() => assertWithin('SECRET', 'INTERNAL')).detail).toBe('classification');
    expect(thrown(() => assertWithin('PUBLIC', 'SECRET')).detail).toBe('classification');
  });

  it('checks a collection as the request makes it', () => {
    const good = { code: ' KB-PRJ ', title: ' Hồ sơ ', subjectModule: 'PRJ', embeddingModelId: M1.toUpperCase(), maxClassification: 'INTERNAL' };
    expect(checkCollection(good)).toEqual({ code: 'KB-PRJ', title: 'Hồ sơ', subjectModule: 'PRJ', embeddingModelId: M1, maxClassification: 'INTERNAL' });
    for (const [over, field] of [
      [{ code: 'x' }, 'code'],
      [{ code: '-bad' }, 'code'],
      [{ title: ' ' }, 'title'],
      [{ title: 'x'.repeat(301) }, 'title'],
      [{ subjectModule: 'prj' }, 'subject_module'],
      [{ embeddingModelId: 'nope' }, 'embedding_model_id'],
      [{ maxClassification: 'SECRET' }, 'max_classification'],
    ] as const)
      expect(thrown(() => checkCollection({ ...good, ...over })).detail).toBe(field);
  });
});

describe('the chunks of a document', () => {
  it('keeps paragraphs together up to the size of a chunk, and never lets a chunk span two pages', () => {
    const paragraph = (n: number): string => `Đoạn ${n}: ${'từ '.repeat(150)}`.trim();
    const chunks = chunkPages([[paragraph(1), paragraph(2), paragraph(3)].join('\n\n'), 'Trang hai có một đoạn ngắn.', '  \n\n  ', paragraph(4)]);
    expect(chunks.every((chunk) => chunk.text.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(chunks.filter((chunk) => chunk.pageIndex === 0).length).toBeGreaterThan(1);
    expect(chunks.filter((chunk) => chunk.pageIndex === 0).map((chunk) => chunk.chunkNo)).toEqual(chunks.filter((chunk) => chunk.pageIndex === 0).map((_, n) => n));
    expect(chunks.filter((chunk) => chunk.pageIndex === 1)).toEqual([{ pageIndex: 1, chunkNo: 0, text: 'Trang hai có một đoạn ngắn.' }]);
    expect(chunks.filter((chunk) => chunk.pageIndex === 2)).toEqual([]);
    expect(chunks.filter((chunk) => chunk.pageIndex === 3)).toHaveLength(1);
    expect(
      chunks
        .map((chunk) => chunk.text)
        .join(' ')
        .replace(/\s+/g, ' '),
    ).toContain('Đoạn 3');
  });

  it('cuts a paragraph that is longer than a chunk at a space, and at the limit where there is none', () => {
    const words = Array.from({ length: 600 }, (_, n) => `w${n}`).join(' ');
    const cut = chunkPages([words]);
    expect(cut.length).toBeGreaterThan(1);
    expect(cut.every((chunk) => chunk.text.length <= MAX_CHUNK_CHARS && !chunk.text.startsWith(' '))).toBe(true);
    expect(cut.map((chunk) => chunk.text).join(' ')).toBe(words);
    const solid = chunkPages(['x'.repeat(MAX_CHUNK_CHARS * 2 + 5)]);
    expect(solid.map((chunk) => chunk.text.length)).toEqual([MAX_CHUNK_CHARS, MAX_CHUNK_CHARS, 5]);
  });

  it('gives no chunk to a document with no text, and refuses one that is too long', () => {
    expect(chunkPages([])).toEqual([]);
    expect(chunkPages(['', '   '])).toEqual([]);
    expect(thrown(() => chunkPages(Array.from({ length: MAX_CHUNKS_PER_ITEM + 1 }, (_, n) => `page ${n}`))).detail).toBe('document_version_id');
  });
});

describe('the embedding and the question', () => {
  it('takes an embedding of the dimension of the column made of finite numbers', () => {
    expect(() => assertEmbedding(new Array<number>(EMBEDDING_DIMENSION).fill(0.1))).not.toThrow();
    expect(thrown(() => assertEmbedding([1, 2, 3])).detail).toBe('embedding');
    expect(thrown(() => assertEmbedding(new Array<number>(EMBEDDING_DIMENSION).fill(Number.NaN))).detail).toBe('embedding');
  });

  it('asks for 1 to 20 chunks, 5 when it does not say', () => {
    expect(retrievalLimit(undefined)).toBe(5);
    expect(retrievalLimit(20)).toBe(20);
    for (const bad of [0, 21, 1.5, -1]) expect(thrown(() => retrievalLimit(bad)).detail).toBe('limit');
  });
});
