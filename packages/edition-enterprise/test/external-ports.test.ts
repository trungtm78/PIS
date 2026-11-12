import { FakeEProcurementPort, EPROCUREMENT_LAYOUT, eprocurementQueryOf, eprocurementRecordProblems } from '../src/external/eprocurement-port.ts';
import type { EProcurementQuery, EProcurementRecord } from '../src/external/eprocurement-port.ts';
import { FakeDocumentRegistryPort, REGISTRY_LAYOUT, registryDocumentProblems, registryQueryOf } from '../src/external/registry-port.ts';
import type { RegistryDocument, RegistryQuery } from '../src/external/registry-port.ts';
import { PAGE_DEFAULT, PAGE_MAX, externalAcceptance, isDay, isInstant, pageOf, pageRequestOf } from '../src/external/external-rules.ts';
import { pageContract } from './support/port-contract';

const AS_OF = '2026-11-10T03:00:00Z';

const pack = (code: string, patch: Partial<EProcurementRecord> = {}): EProcurementRecord => ({
  externalCode: code,
  projectCode: 'P-001',
  title: 'Pump set for the ammonia unit',
  stage: 'PLANNED',
  plannedValueVnd: '1500000000',
  awardPriceVnd: null,
  winnerName: null,
  contractNo: null,
  updatedAt: '2026-11-01T00:00:00Z',
  ...patch,
});

const PACKAGES: EProcurementRecord[] = [
  pack('EP-005'),
  pack('EP-001', { stage: 'TENDERING', updatedAt: '2026-11-03T00:00:00Z' }),
  pack('EP-003', { projectCode: 'P-002', stage: 'AWARDED', awardPriceVnd: '1400000000', winnerName: 'Supplier A' }),
  pack('EP-002', { stage: 'CONTRACTED', awardPriceVnd: '1400000000', winnerName: 'Supplier A', contractNo: 'HD-2026/07', updatedAt: '2026-11-05T00:00:00Z' }),
  pack('EP-004', { stage: 'CANCELLED' }),
];

const doc = (number: string, patch: Partial<RegistryDocument> = {}): RegistryDocument => ({
  registryNumber: number,
  symbol: `${number}/QD-TCT`,
  direction: 'INCOMING',
  title: 'Decision on the investment',
  issuer: 'Parent group',
  issuedOn: '2026-05-04',
  docTypeCode: 'GROUP_RESOLUTION',
  projectCode: 'P-001',
  fileName: null,
  fileSha256: null,
  ...patch,
});

const DOCUMENTS: RegistryDocument[] = [
  doc('VT-004', { direction: 'OUTGOING', issuedOn: '2026-08-01', projectCode: null, docTypeCode: null }),
  doc('VT-001'),
  doc('VT-002', { issuedOn: '2026-06-10', fileName: 'decision.pdf', fileSha256: 'a'.repeat(64) }),
  doc('VT-003', { projectCode: 'P-002', issuedOn: '2026-07-02' }),
  doc('VT-005', { issuedOn: '2026-09-09' }),
];

describe('the common rules of the ports', () => {
  it('judges acceptance by the layout: a working assumption is never acceptable', () => {
    expect(externalAcceptance(EPROCUREMENT_LAYOUT)).toBe('PENDING_EXTERNAL');
    expect(externalAcceptance('EPROCUREMENT-2027.1')).toBe('ACCEPTABLE');
  });

  it('knows a real day and a real instant and nothing looser', () => {
    expect(isDay('2026-02-28')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-2-3')).toBe(false);
    expect(isDay(20260228)).toBe(false);
    expect(isInstant('2026-11-10T03:00:00Z')).toBe(true);
    expect(isInstant('2026-11-10T03:00:00.250Z')).toBe(true);
    expect(isInstant('2026-11-10T25:00:00Z')).toBe(false);
    expect(isInstant('2026-11-10 03:00:00')).toBe(false);
    expect(isInstant(undefined)).toBe(false);
  });

  it('takes a page request: default and top limit, a key for the cursor', () => {
    expect(pageRequestOf({})).toEqual({ after: undefined, limit: PAGE_DEFAULT });
    expect(pageRequestOf({ after: 'EP-001', limit: PAGE_MAX })).toEqual({ after: 'EP-001', limit: PAGE_MAX });
    for (const bad of [{ limit: 0 }, { limit: PAGE_MAX + 1 }, { limit: 1.5 }, { limit: '5' }]) expect(() => pageRequestOf(bad)).toThrow(expect.objectContaining({ detail: 'limit' }));
    for (const bad of ['', ' EP', 'a'.repeat(61), 5]) expect(() => pageRequestOf({ after: bad })).toThrow(expect.objectContaining({ detail: 'after' }));
  });

  it('cuts a sorted list after the cursor and gives the next cursor only when more is left', () => {
    const items = ['a', 'b', 'c', 'd'];
    const key = (item: string): string => item;
    expect(pageOf(items, key, { after: undefined, limit: 2 })).toEqual({ records: ['a', 'b'], next: 'b' });
    expect(pageOf(items, key, { after: 'b', limit: 2 })).toEqual({ records: ['c', 'd'], next: null });
    expect(pageOf(items, key, { after: 'zz', limit: 2 })).toEqual({ records: [], next: null });
    expect(pageOf([], key, { after: undefined, limit: 2 })).toEqual({ records: [], next: null });
  });
});

describe('the eProcurement port and its fake', () => {
  it('serves the packages of one project, and only those changed since an instant', async () => {
    const port = new FakeEProcurementPort(PACKAGES, AS_OF);
    expect((await port.fetchPackages({ projectCode: 'P-002' })).records.map((one) => one.externalCode)).toEqual(['EP-003']);
    expect((await port.fetchPackages({ updatedSince: '2026-11-03T00:00:00Z' })).records.map((one) => one.externalCode)).toEqual(['EP-001', 'EP-002']);
    const page = await port.fetchPackages({});
    expect(page).toMatchObject({ layout: EPROCUREMENT_LAYOUT, acceptance: 'PENDING_EXTERNAL', workingAssumption: true, asOf: AS_OF });
  });

  it('refuses a record that breaks the layout when it is built, so no test can feed the readers what a real adapter would not hand over', () => {
    expect(() => new FakeEProcurementPort([pack('EP-001', { stage: 'AWARDED' })], AS_OF)).toThrow(expect.objectContaining({ detail: 'award_price_vnd' }));
    expect(() => new FakeEProcurementPort([pack('EP-001'), pack('EP-001')], AS_OF)).toThrow(expect.objectContaining({ detail: 'external_code' }));
    expect(() => new FakeEProcurementPort([], '2026-11-10')).toThrow(expect.objectContaining({ detail: 'as_of' }));
  });

  it('judges each field of a record and ties the award and the contract to the stage', () => {
    expect(eprocurementRecordProblems(pack('EP-001'))).toEqual([]);
    const cases: Array<[Partial<EProcurementRecord>, string]> = [
      [{ externalCode: ' x' }, 'external_code'],
      [{ projectCode: '' }, 'project_code'],
      [{ title: ' ' }, 'title'],
      [{ title: 'bad\u0007title' }, 'title'],
      [{ stage: 'DONE' as EProcurementRecord['stage'] }, 'stage'],
      [{ plannedValueVnd: '1.5' }, 'planned_value_vnd'],
      [{ plannedValueVnd: '007' }, 'planned_value_vnd'],
      [{ updatedAt: 'yesterday' }, 'updated_at'],
      [{ stage: 'AWARDED', awardPriceVnd: '5' }, 'winner_name'],
      [{ stage: 'CONTRACTED', awardPriceVnd: '5', winnerName: 'A' }, 'contract_no'],
      [{ stage: 'TENDERING', awardPriceVnd: '5' }, 'stage'],
      [{ stage: 'PLANNED', contractNo: 'HD-1' }, 'contract_no'],
    ];
    for (const [patch, field] of cases) expect(eprocurementRecordProblems(pack('EP-001', patch))).toContain(field);
  });

  it('takes the query as the adapters take it', () => {
    expect(eprocurementQueryOf({ projectCode: 'P-001', updatedSince: AS_OF, limit: 10 })).toEqual({ projectCode: 'P-001', updatedSince: AS_OF, after: undefined, limit: 10 });
    expect(() => eprocurementQueryOf({ projectCode: ' ' })).toThrow(expect.objectContaining({ detail: 'project_code' }));
    expect(() => eprocurementQueryOf({ updatedSince: '2026-11-10' })).toThrow(expect.objectContaining({ detail: 'updated_since' }));
  });

  pageContract<EProcurementRecord, EProcurementQuery>('eProcurement fake', {
    make: () => {
      const port = new FakeEProcurementPort(PACKAGES, AS_OF);
      return { adapterStatus: port.adapterStatus, layoutVersion: port.layoutVersion, read: (query) => port.fetchPackages(query) };
    },
    keyOf: (record) => record.externalCode,
    total: PACKAGES.length,
    withPage: (after, limit) => ({ after, limit }),
    refused: [
      { query: { limit: 0 }, field: 'limit' },
      { query: { after: ' ' }, field: 'after' },
      { query: { projectCode: '' }, field: 'project_code' },
      { query: { updatedSince: 'now' }, field: 'updated_since' },
    ],
  });
});

describe('the registry port and its fake', () => {
  it('finds a document by its symbol and says so when it holds none', async () => {
    const port = new FakeDocumentRegistryPort(DOCUMENTS);
    expect((await port.findBySymbol('VT-002/QD-TCT'))?.registryNumber).toBe('VT-002');
    expect(await port.findBySymbol('NO/SUCH')).toBeNull();
    await expect(Promise.resolve().then(() => port.findBySymbol(''))).rejects.toMatchObject({ detail: 'symbol' });
  });

  it('lists by day range, direction and project, in the order of the registry number', async () => {
    const port = new FakeDocumentRegistryPort(DOCUMENTS);
    const numbers = async (query: Parameters<typeof port.listDocuments>[0]): Promise<string[]> => (await port.listDocuments(query)).records.map((one) => one.registryNumber);
    expect(await numbers({})).toEqual(['VT-001', 'VT-002', 'VT-003', 'VT-004', 'VT-005']);
    expect(await numbers({ issuedFrom: '2026-06-10', issuedTo: '2026-08-01' })).toEqual(['VT-002', 'VT-003', 'VT-004']);
    expect(await numbers({ direction: 'OUTGOING' })).toEqual(['VT-004']);
    expect(await numbers({ projectCode: 'P-002' })).toEqual(['VT-003']);
    expect(await port.listDocuments({})).toMatchObject({ layout: REGISTRY_LAYOUT, acceptance: 'PENDING_EXTERNAL', workingAssumption: true });
  });

  it('refuses a document that breaks the layout when it is built', () => {
    expect(() => new FakeDocumentRegistryPort([doc('VT-001', { issuedOn: '2026-13-01' })])).toThrow(expect.objectContaining({ detail: 'issued_on' }));
    expect(() => new FakeDocumentRegistryPort([doc('VT-001'), doc('VT-001')])).toThrow(expect.objectContaining({ detail: 'registry_number' }));
  });

  it('judges each field of a document and keeps the file name and its hash together', () => {
    expect(registryDocumentProblems(doc('VT-001'))).toEqual([]);
    expect(registryDocumentProblems(doc('VT-001', { fileName: 'a.pdf', fileSha256: 'b'.repeat(64) }))).toEqual([]);
    const cases: Array<[Partial<RegistryDocument>, string]> = [
      [{ registryNumber: '' }, 'registry_number'],
      [{ symbol: ' ' }, 'symbol'],
      [{ direction: 'SIDEWAYS' as RegistryDocument['direction'] }, 'direction'],
      [{ title: '' }, 'title'],
      [{ issuer: ' ' }, 'issuer'],
      [{ issuedOn: '04/05/2026' }, 'issued_on'],
      [{ docTypeCode: 'group resolution' }, 'doc_type_code'],
      [{ projectCode: ' ' }, 'project_code'],
      [{ fileName: 'a.pdf' }, 'file_sha256'],
      [{ fileSha256: 'b'.repeat(64) }, 'file_sha256'],
      [{ fileName: 'a.pdf', fileSha256: 'XYZ' }, 'file_sha256'],
    ];
    for (const [patch, field] of cases) expect(registryDocumentProblems(doc('VT-001', patch))).toContain(field);
  });

  it('takes the query as the adapters take it', () => {
    expect(registryQueryOf({ issuedFrom: '2026-01-01', issuedTo: '2026-12-31', direction: 'INCOMING', projectCode: 'P-1', limit: 5 })).toMatchObject({ limit: 5, direction: 'INCOMING' });
    const refused: Array<[Parameters<typeof registryQueryOf>[0], string]> = [
      [{ issuedFrom: '2026-1-1' }, 'issued_from'],
      [{ issuedTo: 'x' }, 'issued_to'],
      [{ issuedFrom: '2026-05-02', issuedTo: '2026-05-01' }, 'issued_to'],
      [{ direction: 'UP' as 'INCOMING' }, 'direction'],
      [{ projectCode: ' ' }, 'project_code'],
    ];
    for (const [query, field] of refused) expect(() => registryQueryOf(query)).toThrow(expect.objectContaining({ detail: field }));
  });

  pageContract<RegistryDocument, RegistryQuery>('registry fake', {
    make: () => {
      const port = new FakeDocumentRegistryPort(DOCUMENTS);
      return { adapterStatus: port.adapterStatus, layoutVersion: port.layoutVersion, read: (query) => port.listDocuments(query) };
    },
    keyOf: (record) => record.registryNumber,
    total: DOCUMENTS.length,
    withPage: (after, limit) => ({ after, limit }),
    refused: [
      { query: { limit: 201 }, field: 'limit' },
      { query: { after: '' }, field: 'after' },
      { query: { issuedFrom: 'x' }, field: 'issued_from' },
      { query: { direction: 'UP' as RegistryDocument['direction'] }, field: 'direction' },
    ],
  });
});
