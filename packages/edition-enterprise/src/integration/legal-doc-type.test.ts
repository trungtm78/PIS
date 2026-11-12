import type { DomainError } from '@machvon/kernel';
import { PublicProjectDocumentExtension } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { LEGAL_DOC_TYPE_SEEDS, legalDocTypesOfResolved, registerEnterpriseCatalogueRules } from './ent-catalogue.ts';
import { EnterpriseProjectDocumentExtension, legalDocTypeOf } from './legal-doc-type.ts';

const CODES = LEGAL_DOC_TYPE_SEEDS.map((seed) => seed.code);
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const ACTOR = '00000000-0000-4000-8000-0000000000a1';

/** A transaction that answers the reads of the extension and records what it writes. */
function fakeTx(held: string | undefined) {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    query: (sql: string, params: unknown[] = []): Promise<unknown[]> => {
      if (/from machvon\.governance_rule/.test(sql)) return Promise.resolve([]);
      if (/^select legal_doc_type/.test(sql)) return Promise.resolve(held === undefined ? [] : [{ legal_doc_type: held }]);
      writes.push({ sql, params });
      return Promise.resolve([]);
    },
  } as unknown as TenantTx;
  return { tx, writes };
}

const refusal = async (run: () => unknown): Promise<DomainError> => {
  try {
    await run();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

describe('the legal-document type of a project document (MD.02)', () => {
  beforeAll(() => registerEnterpriseCatalogueRules());

  it('accepts a code of the catalogue, clears on null and refuses anything else on legal_doc_type', async () => {
    expect(legalDocTypeOf('GROUP_RESOLUTION', CODES)).toBe('GROUP_RESOLUTION');
    expect(legalDocTypeOf(null, CODES)).toBeNull();
    for (const [raw, reason] of [['group_resolution', 'FORMAT'], [7, 'FORMAT'], ['', 'FORMAT'], ['NOT_IN_CATALOGUE', 'UNKNOWN_TYPE']] as const) {
      const error = await refusal(() => legalDocTypeOf(raw, CODES));
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'legal_doc_type' });
      expect(JSON.stringify(error)).toContain(reason);
    }
  });

  it('reads the catalogue on the day: the built-in types are all there', async () => {
    const { tx } = fakeTx(undefined);
    const extension = new EnterpriseProjectDocumentExtension();
    expect(await extension.legalDocType(tx, undefined, '2026-11-12')).toEqual({ set: false });
    expect(await extension.legalDocType(tx, 'COMPANY_DECISION', '2026-11-12')).toEqual({ set: true, code: 'COMPANY_DECISION' });
    expect(await extension.legalDocType(tx, null, '2026-11-12')).toEqual({ set: true, code: null });
    expect(await refusal(() => extension.legalDocType(tx, 'MADE_UP', '2026-11-12'))).toMatchObject({ status: 422, detail: 'legal_doc_type' });
    const resolved = legalDocTypesOfResolved([
      { code: 'ZZ', params: { label: 'Z', issuer: 'OTHER', purpose: 'LIFECYCLE_EVIDENCE' } },
      { code: 'AA', params: { label: 'A', issuer: 'GROUP', purpose: 'CAPITAL_ASSIGNMENT' } },
    ]);
    expect(resolved).toEqual([
      { code: 'AA', label: 'A', issuer: 'GROUP', purpose: 'CAPITAL_ASSIGNMENT' },
      { code: 'ZZ', label: 'Z', issuer: 'OTHER', purpose: 'LIFECYCLE_EVIDENCE' },
    ]);
  });

  it('keeps a type once, replaces it and clears it, and says what it was and what it is', async () => {
    const extension = new EnterpriseProjectDocumentExtension();
    const none = fakeTx(undefined);
    expect(await extension.recordLegalDocType(none.tx, DOCUMENT, 'GROUP_RESOLUTION', ACTOR)).toEqual({ from: null, to: 'GROUP_RESOLUTION' });
    expect(none.writes).toHaveLength(1);
    expect(none.writes[0]?.sql).toContain('on conflict');
    expect(none.writes[0]?.params).toEqual([DOCUMENT, 'GROUP_RESOLUTION', ACTOR]);

    const same = fakeTx('GROUP_RESOLUTION');
    expect(await extension.recordLegalDocType(same.tx, DOCUMENT, 'GROUP_RESOLUTION', ACTOR)).toEqual({ from: 'GROUP_RESOLUTION', to: 'GROUP_RESOLUTION' });
    expect(same.writes).toEqual([]);

    const cleared = fakeTx('GROUP_RESOLUTION');
    expect(await extension.recordLegalDocType(cleared.tx, DOCUMENT, null, ACTOR)).toEqual({ from: 'GROUP_RESOLUTION', to: null });
    expect(cleared.writes[0]?.sql).toMatch(/^delete from machvon\.project_document_legal_type/);

    const nothing = fakeTx(undefined);
    expect(await extension.recordLegalDocType(nothing.tx, DOCUMENT, null, ACTOR)).toEqual({ from: null, to: null });
    expect(nothing.writes).toEqual([]);
  });
});

describe('the extension of the public edition', () => {
  const extension = new PublicProjectDocumentExtension();
  const { tx } = fakeTx(undefined);

  it('takes a request without the member or with null as it always was, and writes nothing', async () => {
    expect(await extension.legalDocType(tx, undefined)).toEqual({ set: false });
    expect(await extension.legalDocType(tx, null)).toEqual({ set: false });
    expect(await extension.recordLegalDocType()).toEqual({ from: null, to: null });
  });

  it('refuses a named type: the public edition holds no catalogue', async () => {
    const error = await refusal(() => extension.legalDocType(tx, 'GROUP_RESOLUTION'));
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'legal_doc_type' });
    expect(JSON.stringify(error)).toContain('NOT_AVAILABLE');
  });
});
