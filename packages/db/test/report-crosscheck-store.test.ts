import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { ReportCrosscheckStore, figureSetSha256 } from '../src/report-crosscheck-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

/**
 * ENT-4a at the database: the figures of a draft are kept once and never change, an explanation holds for one fingerprint and never by the person who prepared a report it is about, the evidence of a release is one
 * per issued copy, and the comparison reads the head issued copy before an open draft. Fixtures are written with the triggers off (the guards under test run with them on).
 */

const harness = new AuthzHarness();
const store = new ReportCrosscheckStore();
const ROOT = 1;
const PREPARER = 1;
const CHECKER = 2;
const APPROVER = 3;
const EXPLAINER = 4;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = EXPLAINER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);

async function admin(statements: Array<[string, unknown[]?]>, triggers = false): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    if (!triggers) await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

const draftRow = (id: string, layout: string, period: string, state: 'DRAFT' | 'ISSUED', preparer: number, issueId: string | null = null, tenant = TENANT_A): [string, unknown[]] => [
  `insert into machvon.report_draft (tenant_id, id, layout_id, layout_code, layout_version, period_code, period, state, base_revision, xlsx_sha256, package_sha256, data_source, marks, preview, prepared_by, checked_by, checked_at, approved_by, approved_at, issue_id)
   values ($1, $2, $3, $4, 'v1', $5, '{"kind":"MONTH","year":2026,"index":10}'::jsonb, $6, 0, $7, $7, 'LIVE', '{}'::jsonb, '{}'::jsonb, $8, $9, $10, $11, $12, $13)`,
  [tenant, id, randomUUID(), layout, period, state, sha(id), memberId(preparer), state === 'ISSUED' ? memberId(CHECKER) : null, state === 'ISSUED' ? new Date() : null, state === 'ISSUED' ? memberId(APPROVER) : null, state === 'ISSUED' ? new Date() : null, issueId],
];

const issueRow = (id: string, draftId: string, layout: string, period: string, revision: number, supersedes: string | null, tenant = TENANT_A): [string, unknown[]] => [
  `insert into machvon.report_issue (tenant_id, id, layout_id, layout_code, layout_version, period_code, period, revision, supersedes_id, reason, draft_id, sha256, xlsx_sha256, xlsx_name, data_source, form_status, counts_as_accepted, prepared_by, checked_by, approved_by, issued_by)
   values ($1, $2, $3, $4, 'v1', $5, '{"kind":"MONTH","year":2026,"index":10}'::jsonb, $6, $7, $8, $9, $10, $10, 'x.xlsx', 'LIVE', 'READY', true, $11, $12, $13, $13)`,
  [tenant, id, randomUUID(), layout, period, revision, supersedes, revision === 1 ? null : 'A correction with a reason', draftId, sha(id), memberId(PREPARER), memberId(CHECKER), memberId(APPROVER)],
];

const figures = [{ code: 'ENT_PLAN_YEAR', basis: 'FULL_YEAR', value: '100', asOf: '2026-10-31' }];
const rows = [{ key: 'P1', unit: 'U', values: { ENT_PLAN_YEAR: '100' } }];

const OPEN = randomUUID();
const ISSUED_DRAFT = randomUUID();
const ISSUE = randomUUID();
const NEWER = randomUUID();
const OTHER = randomUUID();
const REVISED_DRAFT = randomUUID();
const REVISED_ISSUE = randomUUID();

beforeAll(async () => {
  await harness.start();
  for (const tenant of [TENANT_A, TENANT_B]) {
    await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const member of [PREPARER, CHECKER, APPROVER, EXPLAINER]) await harness.seedMembership(tenant, member, ROOT);
  }
  await admin([
    issueRow(ISSUE, ISSUED_DRAFT, 'PVN-MONTHLY', '2026-M10', 1, null),
    draftRow(ISSUED_DRAFT, 'PVN-MONTHLY', '2026-M10', 'ISSUED', PREPARER, ISSUE),
    draftRow(NEWER, 'PVN-MONTHLY', '2026-M10', 'DRAFT', PREPARER),
    draftRow(OPEN, 'HPM-MONTHLY', '2026-M10', 'DRAFT', PREPARER),
    draftRow(OTHER, 'HPM-MONTHLY', '2026-M09', 'DRAFT', PREPARER),
  ]);
});

afterAll(async () => {
  await harness.stop();
}, 60_000);

describe('the figures of a draft', () => {
  it('are recorded once with their hash, read back, and never change', async () => {
    const first = await as((tx) => store.recordFigureSet(tx, OPEN, { figures, rows }));
    expect(first).toBe(figureSetSha256({ figures, rows }));
    const again = await as((tx) => store.recordFigureSet(tx, OPEN, { figures: [], rows: [] }));
    expect(again).not.toBe(first);
    const found = await as((tx) => store.figureSets(tx, [OPEN, NEWER]));
    expect([...found.keys()]).toEqual([OPEN]);
    expect(found.get(OPEN)?.sha256).toBe(first);
    expect(found.get(OPEN)?.set.rows[0]?.key).toBe('P1');
    await expect(as((tx) => tx.query(`update machvon.report_figure_set set sha256 = $1 where draft_id = $2`, [sha('x'), OPEN]))).rejects.toThrow();
  });

  it('are the tenant`s own', async () => {
    const seen = await as((tx) => store.figureSets(tx, [OPEN]), PREPARER, TENANT_B);
    expect(seen.size).toBe(0);
  });
});

describe('the candidates', () => {
  it('are the head issued copy before an open draft, else the newest open draft, and the pinned draft wins', async () => {
    const found = await as((tx) => store.candidates(tx, ['PVN-MONTHLY', 'HPM-MONTHLY'], ['2026-M10']));
    expect(found.map((one) => [one.layoutCode, one.kind, one.id])).toEqual([
      ['HPM-MONTHLY', 'DRAFT', OPEN],
      ['PVN-MONTHLY', 'ISSUE', ISSUE],
    ]);
    const pinned = await as((tx) => store.candidates(tx, ['PVN-MONTHLY'], ['2026-M10'], NEWER));
    expect(pinned.map((one) => [one.kind, one.id])).toEqual([['DRAFT', NEWER]]);
    expect(await as((tx) => store.candidates(tx, [], ['2026-M10']))).toEqual([]);
  });

  it('follow the newest revision of an issued series', async () => {
    await admin([issueRow(REVISED_ISSUE, REVISED_DRAFT, 'PVN-MONTHLY', '2026-M10', 2, ISSUE), draftRow(REVISED_DRAFT, 'PVN-MONTHLY', '2026-M10', 'ISSUED', PREPARER, REVISED_ISSUE)]);
    const found = await as((tx) => store.candidates(tx, ['PVN-MONTHLY'], ['2026-M10']));
    expect(found[0]).toMatchObject({ kind: 'ISSUE', id: REVISED_ISSUE, revision: 2, draftId: REVISED_DRAFT });
  });
});

describe('an explanation', () => {
  const fingerprint = sha('finding-1');
  const reason = 'The Treasury corrected the month after the freeze; the quarter is right.';
  const input = { fingerprint, ruleId: 'XR-01', figureCode: 'ENT_EXECUTED_PERIOD', periodCode: '2026-Q4', severity: 'BLOCKING' as const, involves: [OPEN, ISSUE], reason, explainedBy: memberId(EXPLAINER) };

  it('is recorded once per fingerprint and a repeat by anyone returns the first', async () => {
    const first = await as((tx) => store.explain(tx, input));
    expect(first.outcome).toBe('CREATED');
    expect(first.row).toMatchObject({ ruleId: 'XR-01', explainedBy: memberId(EXPLAINER), involves: [OPEN, ISSUE] });
    const repeat = await as((tx) => store.explain(tx, { ...input, reason: `${reason} Again.`, explainedBy: memberId(CHECKER) }), CHECKER);
    expect(repeat.outcome).toBe('EXISTING');
    expect(repeat.row.id).toBe(first.row.id);
    expect(repeat.row.reason).toBe(reason);
    const listed = await as((tx) => store.explanations(tx, { fingerprints: [fingerprint, sha('other')] }));
    expect(listed.map((one) => one.fingerprint)).toEqual([fingerprint]);
    expect((await as((tx) => store.explanations(tx, { periodCode: '2026-Q4' }))).length).toBe(1);
  });

  it('is refused for the person who prepared a report it is about, by the store and by the database', async () => {
    const other = { ...input, fingerprint: sha('finding-2') };
    await expect(as((tx) => store.explain(tx, { ...other, explainedBy: memberId(PREPARER) }), PREPARER)).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    await expect(
      admin(
        [[`insert into machvon.report_crosscheck_explanation (tenant_id, fingerprint, rule_id, figure_code, period_code, severity, involves, reason, explained_by) values ($1, $2, 'XR-01', 'ENT_PLAN_YEAR', '2026-Q4', 'BLOCKING', $3::uuid[], $4, $5)`, [TENANT_A, sha('finding-3'), [OPEN], reason, memberId(PREPARER)]]],
        true,
      ),
    ).rejects.toThrow(/prepared a report/);
  });

  it('is never changed or deleted', async () => {
    await expect(as((tx) => tx.query(`update machvon.report_crosscheck_explanation set reason = $1`, ['x'.repeat(30)]))).rejects.toThrow();
    await expect(as((tx) => tx.query('delete from machvon.report_crosscheck_explanation'))).rejects.toThrow();
  });

  it('is kept apart between tenants', async () => {
    expect(await as((tx) => store.explanations(tx), PREPARER, TENANT_B)).toEqual([]);
  });
});

describe('the evidence of a release', () => {
  const result = sha('result');

  it('is one per issued copy, says PASSED without explanations and EXPLAINED with them', async () => {
    const made = await as((tx) => store.recordRelease(tx, { issueId: ISSUE, draftId: ISSUED_DRAFT, periodCode: '2026-M10', resultSha256: result, comparisons: 120, skipped: 3, warnings: 1, explainedFingerprints: [], releasedBy: memberId(APPROVER) }), APPROVER);
    expect(made).toMatchObject({ outcome: 'PASSED', comparisons: 120, skipped: 3, blockingExplained: 0, warnings: 1 });
    const again = await as((tx) => store.recordRelease(tx, { issueId: ISSUE, draftId: ISSUED_DRAFT, periodCode: '2026-M10', resultSha256: sha('changed'), comparisons: 1, skipped: 0, warnings: 0, explainedFingerprints: [sha('f')], releasedBy: memberId(APPROVER) }), APPROVER);
    expect(again.id).toBe(made.id);
    expect(again.resultSha256).toBe(result);
    const explained = await as((tx) => store.recordRelease(tx, { issueId: REVISED_ISSUE, draftId: REVISED_DRAFT, periodCode: '2026-M10', resultSha256: result, comparisons: 5, skipped: 0, warnings: 0, explainedFingerprints: [sha('f')], releasedBy: memberId(APPROVER) }), APPROVER);
    expect(explained).toMatchObject({ outcome: 'EXPLAINED', blockingExplained: 1, explainedFingerprints: [sha('f')] });
    expect((await as((tx) => store.releaseOfIssue(tx, ISSUE), APPROVER))?.id).toBe(made.id);
    expect(await as((tx) => store.releaseOfIssue(tx, randomUUID()), APPROVER)).toBeUndefined();
  });

  it('cannot be rewritten', async () => {
    await expect(as((tx) => tx.query(`update machvon.report_crosscheck_release set outcome = 'PASSED'`), APPROVER)).rejects.toThrow();
    await expect(as((tx) => tx.query(`delete from machvon.report_crosscheck_release`), APPROVER)).rejects.toThrow();
  });
});
