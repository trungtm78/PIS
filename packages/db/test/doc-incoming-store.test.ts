import { DocIncomingStore } from '../src/doc-incoming-store';
import { DocumentStore } from '../src/document-store';
import { NumberRegisterStore } from '../src/number-register-store';
import { ACTOR, AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';

jest.setTimeout(240_000);

const harness = new AuthzHarness();
const documents = new DocumentStore();
const registers = new NumberRegisterStore();
const incoming = new DocIncomingStore();
const CLERK = memberId(1);
const NOW = new Date('2026-11-03T03:00:00Z');
let registerId = '';

const ctxA = contextFor(TENANT_A, memberId(1));
const inA = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1]) => harness.tenants.withTenant(ctxA, work);

interface DocumentRow {
  effect_status: string;
  document_number: number | null;
  number_year: number | null;
  symbol: string | null;
  issued_on: string | null;
}
const documentRow = async (documentId: string): Promise<DocumentRow | undefined> =>
  (await harness.owner<DocumentRow>(TENANT_A, [['select effect_status, document_number, number_year, symbol, issued_on::text as issued_on from machvon.document where id = $1::uuid', [documentId]]]))[0];

/** A letter taken in (RECEIVED) with the given original symbol and date. */
async function received(original: { symbol?: string; issuedOn?: string }): Promise<{ id: string; documentId: string }> {
  return inA(async (tx) => {
    const document = await documents.insertDocument(tx, { docKind: 'INCOMING', docTypeCode: 'QD', title: 'Letter', classification: 'INTERNAL', createdBy: CLERK });
    const letter = await incoming.insert(tx, {
      documentId: document.id,
      channel: 'UPLOAD',
      receivedAt: NOW,
      receivedBy: CLERK,
      originalSymbol: original.symbol,
      originalIssuedOn: original.issuedOn,
      senderName: 'Bo Tai chinh',
      urgency: 'NORMAL',
      duplicateOfId: undefined,
      duplicateOverrideReason: undefined,
    });
    return { id: letter.id, documentId: document.id };
  });
}

/** The registration step as the controller runs it: the register allocates the number, then the letter is marked REGISTERED. */
const register = (letter: { id: string; documentId: string }) =>
  inA(async (tx) => {
    await registers.allocateNumber(tx, { registerId, documentId: letter.documentId, issuedAt: NOW, symbolPattern: '{number}/{unit}', parts: { unit: 'DEN-1' }, allocatedBy: CLERK });
    return incoming.markRegistered(tx, letter.id, { expectedVersion: 1, registerId, actor: CLERK });
  });

describe('DocIncomingStore.markRegistered (a registered letter is in force as a record)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/a/1/' }]);
    await harness.seedMembership(TENANT_A, 1, 1);
    registerId = (await inA((tx) => registers.openRegister(tx, { registerCode: 'DEN-1', name: 'Incoming', direction: 'INCOMING', organizationUnitId: unitId(1), year: 2026, mode: 'MANAGED', scopeDocTypes: [], actor: ACTOR }))).id;
  }, 240_000);

  afterAll(() => harness.stop(), 60_000);

  it('makes the document EFFECTIVE, with its register number, year, symbol and date, when the letter carries its original symbol and date', async () => {
    const letter = await received({ symbol: '12/BTC', issuedOn: '2026-11-02' });
    expect(await documentRow(letter.documentId)).toMatchObject({ effect_status: 'PENDING', document_number: null });
    expect(await register(letter)).toEqual({ documentInForce: true });
    expect(await documentRow(letter.documentId)).toMatchObject({ effect_status: 'EFFECTIVE', number_year: 2026, issued_on: '2026-11-03' });
    const row = await documentRow(letter.documentId);
    expect(row?.document_number).toEqual(expect.any(Number));
    expect(row?.symbol).toBe(`${String(row?.document_number).padStart(2, '0')}/DEN-1`);
    expect(await inA((tx) => incoming.find(tx, letter.id))).toMatchObject({ status: 'REGISTERED', registerId });
  });

  it('keeps the document PENDING for a letter that has no original symbol or no original date (the rule of the registration is unchanged)', async () => {
    const noSymbol = await received({ issuedOn: '2026-11-02' });
    const noDate = await received({ symbol: '13/BTC' });
    expect(await register(noSymbol)).toEqual({ documentInForce: false });
    expect(await register(noDate)).toEqual({ documentInForce: false });
    expect(await documentRow(noSymbol.documentId)).toMatchObject({ effect_status: 'PENDING', number_year: 2026 });
    expect(await documentRow(noDate.documentId)).toMatchObject({ effect_status: 'PENDING', number_year: 2026 });
  });

  it('does not put back in force a document that is no longer pending', async () => {
    const letter = await received({ symbol: '14/BTC', issuedOn: '2026-11-02' });
    await inA((tx) => registers.allocateNumber(tx, { registerId, documentId: letter.documentId, issuedAt: NOW, symbolPattern: '{number}/{unit}', parts: { unit: 'DEN-1' }, allocatedBy: CLERK }));
    await harness.owner(TENANT_A, [["update machvon.document set effect_status = 'RECALLED' where id = $1::uuid", [letter.documentId]]]);
    expect(await inA((tx) => incoming.markRegistered(tx, letter.id, { expectedVersion: 1, registerId, actor: CLERK }))).toEqual({ documentInForce: false });
    expect(await documentRow(letter.documentId)).toMatchObject({ effect_status: 'RECALLED' });
  });
});
