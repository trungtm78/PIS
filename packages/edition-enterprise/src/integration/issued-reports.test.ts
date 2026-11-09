import { ReportStore } from '@machvon/db';
import type { ReportIssueRow, TenantTx } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import { HPM_DELIVERY_CHANNEL, HPM_DELIVERY_RECEIVER, ReportStoreIssuedReports } from './issued-reports.ts';

const tx: TenantTx = { query: () => Promise.reject(new Error('the adapter must go through the store of the report engine')) };
const ISSUE_ID = '11111111-1111-4111-8111-111111111111';

const issue = (patch: Partial<ReportIssueRow> = {}): ReportIssueRow =>
  ({
    id: ISSUE_ID,
    layoutCode: 'HPM-MONTHLY',
    periodCode: '2026-M10',
    revision: 2,
    sha256: 'a'.repeat(64),
    xlsxSha256: 'b'.repeat(64),
    xlsxName: 'report.xlsx',
    docxSha256: null,
    docxName: null,
    snapshotRef: null,
    formStatus: 'DEMO',
    demoMark: 'DEMO',
    ...patch,
  }) as ReportIssueRow;

const bytes = (...values: number[]): { bytes: Uint8Array; format: 'XLSX' } => ({ bytes: new Uint8Array(values), format: 'XLSX' });

afterEach(() => jest.restoreAllMocks());

describe('ReportStoreIssuedReports.load', () => {
  it('is undefined when the issue is not in the log, and reads nothing else', async () => {
    jest.spyOn(ReportStore.prototype, 'findIssue').mockResolvedValue(undefined);
    const outputs = jest.spyOn(ReportStore.prototype, 'outputBytes');
    expect(await new ReportStoreIssuedReports().load(tx, ISSUE_ID)).toBeUndefined();
    expect(outputs).not.toHaveBeenCalled();
  });

  it('is undefined when the workbook is no longer in the store: a copy without its file is not found', async () => {
    jest.spyOn(ReportStore.prototype, 'findIssue').mockResolvedValue(issue());
    jest.spyOn(ReportStore.prototype, 'outputBytes').mockResolvedValue(undefined);
    const head = jest.spyOn(ReportStore.prototype, 'headRevision');
    expect(await new ReportStoreIssuedReports().load(tx, ISSUE_ID)).toBeUndefined();
    expect(head).not.toHaveBeenCalled();
  });

  it('carries the workbook alone, the marks, no snapshot and the head of the series for a copy without a document', async () => {
    jest.spyOn(ReportStore.prototype, 'findIssue').mockResolvedValue(issue());
    const outputs = jest.spyOn(ReportStore.prototype, 'outputBytes').mockResolvedValue(bytes(1, 2));
    jest.spyOn(ReportStore.prototype, 'headRevision').mockResolvedValue(3);
    const copy = await new ReportStoreIssuedReports().load(tx, ISSUE_ID);
    expect(outputs).toHaveBeenCalledTimes(1);
    expect(copy).toEqual({
      issueId: ISSUE_ID,
      layoutCode: 'HPM-MONTHLY',
      period: '2026-M10',
      revision: 2,
      sha256: 'a'.repeat(64),
      snapshot: null,
      marks: { formStatus: 'DEMO', demoMark: 'DEMO' },
      files: [{ name: 'report.xlsx', bytes: new Uint8Array([1, 2]) }],
      headRevision: 3,
    });
  });

  it('adds the document after the workbook and copies the reference of the snapshot', async () => {
    jest.spyOn(ReportStore.prototype, 'findIssue').mockResolvedValue(issue({ docxSha256: 'c'.repeat(64), docxName: 'report.docx', snapshotRef: { snapshotId: 'snap', revision: 4, cutoff: '2026-10-31' } as ReportIssueRow['snapshotRef'] }));
    jest.spyOn(ReportStore.prototype, 'outputBytes').mockImplementation(async (_tx, sha) => (sha === 'b'.repeat(64) ? bytes(1) : bytes(9)));
    jest.spyOn(ReportStore.prototype, 'headRevision').mockResolvedValue(2);
    const copy = await new ReportStoreIssuedReports().load(tx, ISSUE_ID);
    expect(copy?.files.map((file) => file.name)).toEqual(['report.xlsx', 'report.docx']);
    expect(copy?.files[1]?.bytes).toEqual(new Uint8Array([9]));
    expect(copy?.snapshot).toEqual({ snapshotId: 'snap', revision: 4, cutoff: '2026-10-31' });
  });

  it('leaves out a document that the store lost but keeps the workbook', async () => {
    jest.spyOn(ReportStore.prototype, 'findIssue').mockResolvedValue(issue({ docxSha256: 'c'.repeat(64), docxName: 'report.docx' }));
    jest.spyOn(ReportStore.prototype, 'outputBytes').mockImplementation(async (_tx, sha) => (sha === 'b'.repeat(64) ? bytes(1) : undefined));
    jest.spyOn(ReportStore.prototype, 'headRevision').mockResolvedValue(2);
    expect((await new ReportStoreIssuedReports().load(tx, ISSUE_ID))?.files.map((file) => file.name)).toEqual(['report.xlsx']);
  });

  it('does not look for a document when only one of its hash and its name is known', async () => {
    jest.spyOn(ReportStore.prototype, 'findIssue').mockResolvedValue(issue({ docxSha256: 'c'.repeat(64), docxName: null }));
    const outputs = jest.spyOn(ReportStore.prototype, 'outputBytes').mockResolvedValue(bytes(1));
    jest.spyOn(ReportStore.prototype, 'headRevision').mockResolvedValue(2);
    expect((await new ReportStoreIssuedReports().load(tx, ISSUE_ID))?.files).toHaveLength(1);
    expect(outputs).toHaveBeenCalledTimes(1);
  });
});

describe('ReportStoreIssuedReports.delivered', () => {
  it('writes the delivery to HPM into the log of the engine under the push channel', async () => {
    const row = issue();
    jest.spyOn(ReportStore.prototype, 'findIssue').mockResolvedValue(row);
    const deliver = jest.spyOn(ReportStore.prototype, 'deliver').mockResolvedValue({} as never);
    await new ReportStoreIssuedReports().delivered(tx, ISSUE_ID, 'user-1', 'ref-1');
    expect(deliver).toHaveBeenCalledWith(tx, row, { receiver: HPM_DELIVERY_RECEIVER, channel: HPM_DELIVERY_CHANNEL, reference: 'ref-1', note: null, by: 'user-1' });
  });

  it('is not found for an issue that is not in the log, and writes nothing', async () => {
    jest.spyOn(ReportStore.prototype, 'findIssue').mockResolvedValue(undefined);
    const deliver = jest.spyOn(ReportStore.prototype, 'deliver');
    await expect(new ReportStoreIssuedReports().delivered(tx, ISSUE_ID, 'u', 'r')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('treats a second try of the same key as the repeat the log recognises, and any other failure as a failure', async () => {
    jest.spyOn(ReportStore.prototype, 'findIssue').mockResolvedValue(issue());
    const deliver = jest.spyOn(ReportStore.prototype, 'deliver').mockRejectedValueOnce(new DomainError('ALREADY_DELIVERED', 409, 'delivery'));
    await expect(new ReportStoreIssuedReports().delivered(tx, ISSUE_ID, 'u', 'r')).resolves.toBeUndefined();
    deliver.mockRejectedValueOnce(new DomainError('FORBIDDEN', 403, 'x'));
    await expect(new ReportStoreIssuedReports().delivered(tx, ISSUE_ID, 'u', 'r')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    deliver.mockRejectedValueOnce(new Error('connection lost'));
    await expect(new ReportStoreIssuedReports().delivered(tx, ISSUE_ID, 'u', 'r')).rejects.toThrow('connection lost');
  });
});

describe('ReportStoreIssuedReports.answered', () => {
  it('records the answer of HPM with its note', async () => {
    const row = issue();
    jest.spyOn(ReportStore.prototype, 'findIssue').mockResolvedValue(row);
    const answer = jest.spyOn(ReportStore.prototype, 'answer').mockResolvedValue({} as never);
    await new ReportStoreIssuedReports().answered(tx, ISSUE_ID, 'REJECTED', 'user-2', 'ref-2', 'wrong period');
    expect(answer).toHaveBeenCalledWith(tx, row, 'REJECTED', { receiver: 'HPM', channel: 'HPM_PUSH', reference: 'ref-2', note: 'wrong period', by: 'user-2' });
  });

  it('is not found for an unknown issue and lets a failure of the log through', async () => {
    const find = jest.spyOn(ReportStore.prototype, 'findIssue').mockResolvedValue(undefined);
    const answer = jest.spyOn(ReportStore.prototype, 'answer').mockRejectedValue(new Error('log closed'));
    await expect(new ReportStoreIssuedReports().answered(tx, ISSUE_ID, 'ACCEPTED', 'u', 'r', null)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(answer).not.toHaveBeenCalled();
    find.mockResolvedValue(issue());
    await expect(new ReportStoreIssuedReports().answered(tx, ISSUE_ID, 'ACCEPTED', 'u', 'r', null)).rejects.toThrow('log closed');
  });
});
