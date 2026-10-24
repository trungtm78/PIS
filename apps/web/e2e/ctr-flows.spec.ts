import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CTR-04 (the BOQ of a contract revision) and CTR-05 (the guarantees) in a real browser against the real API and database
 * (apps/api/test/e2e-stack). The contract officer imports a BOQ file: the amounts are rounded by the rule of each line and reconciled with the value
 * of the revision, the same file is imported once, a file with faults is answered row by row and writes nothing. The officer registers a guarantee and
 * cannot verify it; the chief accountant verifies it, extends it by a replacement that a second accountant verifies and releases on evidence; an advance
 * guarantee stays while an advance is owed. A reader sees everything and changes nothing. What the screens changed is looked up in the database.
 */

const DAY_MS = 86_400_000;
const OFFICER = membershipOf('ctrOfficer');
const ACCOUNTANT = membershipOf('ctrAccountant');
const CHECKER = membershipOf('ctrChecker');
let counter = 0;
const code = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${counter}`;
};
/** The end of the day `days` days from now in Vietnam, as the date the guarantee form takes. */
const dayIn = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface World {
  project: string;
  contractor: string;
  /** Clean document versions: the paper of a guarantee, the evidence of its check and of its release. */
  papers: string[];
}

async function world(): Promise<World> {
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' order by object_key");
  if (project === undefined || contractor === undefined || papers.length < 4) throw new Error('the contract fixtures of the stack are missing');
  return { project: project.id, contractor: contractor.id, papers: papers.map((paper) => paper.id) };
}

interface Seeded {
  contractId: string;
  revisionId: string;
  code: string;
}

/** A DRAFT contract with its first revision, written straight to the database (foreign keys to modules that are not seeded are switched off, as in the stack). */
async function draftContract(value: string, extra: { outstanding?: string } = {}): Promise<Seeded> {
  const fixtures = await world();
  const contractCode = code('HD-E2E');
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử trình duyệt', 'UNIT_PRICE', 'VND', 'DRAFT', 1, $7::numeric, $7::numeric, $8::numeric, $9, $9)`,
      [stackInfo().tenants.A, contractId, fixtures.project, randomUUID(), fixtures.contractor, contractCode, value, extra.outstanding ?? '0', OFFICER],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by)
       values ($1, $2, $3, 1, $4::numeric, $5, date '2026-01-01', 'DRAFT', 'BASE', 1, $6, $6)`,
      [stackInfo().tenants.A, revisionId, contractId, value, fixtures.papers[0], OFFICER],
    );
  } finally {
    await client.end();
  }
  return { contractId, revisionId, code: contractCode };
}

const boqPage = (seeded: Seeded): string => `/ctr/ctr-04?id=${seeded.contractId}`;
const guaranteesPage = (seeded: Seeded): string => `/ctr/ctr-05?id=${seeded.contractId}`;
const header = 'business_key,description,unit_code,quantity,unit_price,rounding_rule,retention_pct';
const csv = (...rows: string[]): { name: string; mimeType: string; buffer: Buffer } => ({ name: 'boq.csv', mimeType: 'text/csv', buffer: Buffer.from(`${header}\n${rows.join('\n')}\n`, 'utf8') });

interface LineRow {
  business_key: string;
  amount_vnd: string;
  rounding_rule: string;
  retention_pct: string;
}
const linesOf = (revisionId: string): Promise<LineRow[]> =>
  sql<LineRow>('select business_key, amount_vnd::text as amount_vnd, rounding_rule, retention_pct::text as retention_pct from machvon.boq_line where contract_revision_id = $1 order by line_no', [revisionId]);
const counts = async (contractId: string): Promise<{ lines: number; items: number; imports: number }> => ({
  lines: Number((await sql<{ n: number }>('select count(*)::int as n from machvon.boq_line where contract_id = $1', [contractId]))[0]?.n),
  items: Number((await sql<{ n: number }>('select count(*)::int as n from machvon.boq_item where contract_id = $1', [contractId]))[0]?.n),
  imports: Number((await sql<{ n: number }>('select count(*)::int as n from machvon.boq_import where contract_id = $1', [contractId]))[0]?.n),
});

const importButton = (page: Page) => page.getByRole('button', { name: vi['ctr.boq.import.action'], exact: true });
const chooseFile = (page: Page, file: { name: string; mimeType: string; buffer: Buffer }) => page.getByLabel(vi['ctr.boq.file.label'], { exact: true }).setInputFiles(file);

test.describe('CTR-04 the BOQ of a contract revision', () => {
  test('the officer imports a file: 3 x 1,234.5 is 3,704 half up and 3,703 down, the lines are reconciled with the value, and the same file is imported once (AC-ST-CTR-002-1, AC-ST-CTR-002-2)', async ({ page }) => {
    const seeded = await draftContract('3704');
    await open(page, boqPage(seeded), 'ctrOfficer');
    await expect(page.getByRole('heading', { level: 1, name: `${seeded.code} · ${vi['ctr.boq.page.title']}` })).toBeVisible();
    await expect(page.getByTestId('no-lines')).toHaveText(vi['ctr.boq.grid.empty']);
    await expect(page.getByTestId('reconcile-status')).toHaveText(vi['ctr.boq.reconcile.empty']);
    // The rule of the default retention is shown with its label of an assumption.
    await expect(page.getByTestId('retention-rule')).toContainText('CXN-EXE-04');

    // Nothing is sent until a file that can be read is chosen.
    await expect(importButton(page)).toBeDisabled();
    await chooseFile(page, { name: 'boq.xlsx', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('x') });
    await expect(page.getByTestId('file-problem')).toHaveText(vi['ctr.boq.file.notCsv.error']);
    expect(await counts(seeded.contractId)).toEqual({ lines: 0, items: 0, imports: 0 });

    const file = csv('B01,Đào đất,M3,3,1234.5,HALF_UP,');
    await chooseFile(page, file);
    await expect(page.getByTestId('file-ready')).toHaveText(vi['ctr.boq.file.ready'].replace('{name}', 'boq.csv').replace('{count}', '1'));
    await importButton(page).click();
    const result = page.getByTestId('result');
    await expect(result).toContainText(vi['ctr.boq.result.done'].replace('{lines}', '1').replace('{items}', '1'));
    await expect(result).toContainText(vi['ctr.boq.result.balanced']);
    await expect(page.getByTestId('retention-defaulted')).toContainText('5');
    await expect(page.getByTestId('difference')).toHaveText('0');
    await expect(page.getByTestId('reconcile-status')).toHaveText(vi['ctr.boq.reconcile.ok']);
    const row = page.getByTestId('boq-row');
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('cell').nth(4)).toHaveText('3.704');
    await expect(row.getByRole('cell').nth(3)).toHaveText('1.234,5');
    expect(await linesOf(seeded.revisionId)).toEqual([{ business_key: 'B01', amount_vnd: '3704', rounding_rule: 'HALF_UP', retention_pct: '5.0000' }]);
    const [record] = await sql<{ source_kind: string; mode: string; lines_total_vnd: string; created_by: string }>('select source_kind, mode, lines_total_vnd::text as lines_total_vnd, created_by from machvon.boq_import where contract_id = $1', [seeded.contractId]);
    expect(record).toEqual({ source_kind: 'FILE', mode: 'REPLACE', lines_total_vnd: '3704', created_by: OFFICER });
    expect(await sql("select action from machvon.audit_event where resource_id = $1 and action = 'boq.imported'", [seeded.revisionId])).toHaveLength(1);

    // The same file again, appended: the first import is answered, nothing is duplicated.
    await page.getByLabel(vi['ctr.boq.mode.label'], { exact: true }).selectOption('APPEND');
    await chooseFile(page, file);
    await expect(page.getByTestId('file-ready')).toBeVisible();
    await importButton(page).click();
    await expect(page.getByTestId('result')).toContainText(vi['ctr.boq.result.duplicate'].replace('{count}', '1'));
    expect(await counts(seeded.contractId)).toEqual({ lines: 1, items: 1, imports: 1 });

    // Replaced by the same price rounded down: 3,703.5 becomes 3,703 and the lines are one dong short of the value.
    await page.getByLabel(vi['ctr.boq.mode.label'], { exact: true }).selectOption('REPLACE');
    await chooseFile(page, csv('B01,Đào đất,M3,3,1234.5,DOWN,'));
    await expect(page.getByTestId('file-ready')).toBeVisible();
    await importButton(page).click();
    await expect(page.getByTestId('result')).toContainText(vi['ctr.boq.result.unbalanced'].replace('{difference}', '-1'));
    await expect(page.getByTestId('difference')).toHaveText('-1');
    await expect(page.getByTestId('reconcile-status')).toHaveText(vi['ctr.boq.reconcile.bad'].replace('{difference}', '-1'));
    expect(await linesOf(seeded.revisionId)).toEqual([{ business_key: 'B01', amount_vnd: '3703', rounding_rule: 'DOWN', retention_pct: '5.0000' }]);
    expect((await counts(seeded.contractId)).imports).toBe(2);
  });

  test('a file with faults is answered row by row and writes nothing; lines above the value are refused with the figures (AC-ST-CTR-002-3, UI-CTR-04)', async ({ page }) => {
    const seeded = await draftContract('1000');
    await open(page, boqPage(seeded), 'ctrOfficer');
    await chooseFile(page, csv('B01,Đào đất,M3,abc,10,,', 'B02,Bê tông,PARSEC,1,10,,', 'B03,Hoàn thiện,M3,1,10,CEILING,'));
    await expect(page.getByTestId('file-ready')).toBeVisible();
    await importButton(page).click();
    const problem = page.getByTestId('problem');
    await expect(problem).toContainText(vi['ctr.boq.problem.rows.error'].replace('{count}', '2'));
    // The shape of the rows is judged first: the unit that master data does not know is told once the rows are well formed.
    const rows = page.getByTestId('fault-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(vi['ctr.boq.fault.invalidNumber.error']);
    await expect(rows.nth(1)).toContainText(vi['ctr.boq.fault.invalidRounding.error']);
    expect(await counts(seeded.contractId)).toEqual({ lines: 0, items: 0, imports: 0 });

    await chooseFile(page, csv('B01,Đào đất,M3,1,10,,', 'B02,Bê tông,PARSEC,1,10,,'));
    await expect(page.getByTestId('file-ready')).toBeVisible();
    await importButton(page).click();
    await expect(page.getByTestId('fault-row')).toHaveCount(1);
    await expect(page.getByTestId('fault-row')).toContainText(vi['ctr.boq.fault.unitUnknown.error']);

    await chooseFile(page, csv('B01,Đào đất,M3,1,600,,', 'B02,Bê tông,M3,1,401,,'));
    await expect(page.getByTestId('file-ready')).toBeVisible();
    await importButton(page).click();
    await expect(page.getByTestId('problem')).toHaveText(vi['ctr.boq.problem.totalMismatch.error'].replace('{lines}', '1.001').replace('{value}', '1.000'));
    expect(await counts(seeded.contractId)).toEqual({ lines: 0, items: 0, imports: 0 });
    expect(await sql("select count(*)::int as n from machvon.outbox_event where aggregate_id = $1", [seeded.revisionId])).toEqual([{ n: 0 }]);
  });

  test('a reader sees the lines and cannot import; someone with no right to the lines is told so (denied)', async ({ page }) => {
    const seeded = await draftContract('2000');
    await open(page, boqPage(seeded), 'ctrOfficer');
    await chooseFile(page, csv('B01,Đào đất,M3,2,1000,,'));
    await expect(page.getByTestId('file-ready')).toBeVisible();
    await importButton(page).click();
    await expect(page.getByTestId('boq-row')).toHaveCount(1);

    await open(page, boqPage(seeded), 'ctrReader');
    await expect(page.getByTestId('boq-row')).toHaveCount(1);
    await expect(page.getByTestId('read-only')).toHaveText(vi['ctr.readOnly.denied.notice']);
    await expect(page.getByLabel(vi['ctr.boq.file.label'], { exact: true })).toHaveCount(0);
    await expect(importButton(page)).toHaveCount(0);

    await open(page, boqPage(seeded), 'nobody');
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page.getByTestId('boq-row')).toHaveCount(0);
  });
});

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const rowOf = (page: Page, number: string) => page.getByTestId('guarantee-row').filter({ has: page.getByRole('cell', { name: number, exact: true }) });

interface GuaranteeRow {
  status: string;
  verification_status: string;
  extended_from_id: string | null;
  released_at: string | null;
  expires_at: string;
  created_by: string;
  verified_by: string | null;
  released_by: string | null;
  version: string;
}
const guaranteeOf = async (number: string): Promise<GuaranteeRow | undefined> =>
  (
    await sql<GuaranteeRow>(
      `select status, verification_status, extended_from_id, released_at::text as released_at, expires_at::text as expires_at, created_by, verified_by, released_by, version::text as version
         from machvon.guarantee where guarantee_no = $1`,
      [number],
    )
  )[0];

test.describe('CTR-05 the guarantees', () => {
  test('the officer registers a guarantee and cannot verify it; the accountant verifies, extends it by a replacement that a second accountant verifies and releases on evidence (AC-ST-CTR-003-1)', async ({ page }) => {
    const seeded = await draftContract('10000000000');
    const papers = (await world()).papers;
    const number = code('BL');
    const replacement = `${number}-X`;
    const expiry = dayIn(120);
    await open(page, guaranteesPage(seeded), 'ctrOfficer');
    await expect(page.getByRole('heading', { level: 1, name: `${seeded.code} · ${vi['ctr.guarantee.page.title']}` })).toBeVisible();

    // The registration: an empty form sends nothing.
    await page.getByRole('button', { name: vi['ctr.guarantee.register.open'], exact: true }).click();
    await page.getByRole('button', { name: vi['ctr.guarantee.register.action'], exact: true }).click();
    await expect(page.locator('[data-field="g-issuer"]').getByText(vi['ctr.guarantee.field.required.error'])).toBeVisible();
    expect(await guaranteeOf(number)).toBeUndefined();
    await field(page, vi['ctr.guarantee.field.issuer.label']).fill('Ngân hàng Cao Bằng');
    await field(page, vi['ctr.guarantee.field.number.label']).fill(number);
    await field(page, vi['ctr.guarantee.field.amount.label']).fill('500000000');
    await field(page, vi['ctr.guarantee.field.validFrom.label']).fill('2026-03-01');
    await field(page, vi['ctr.guarantee.field.expiresOn.label']).fill(expiry);
    await field(page, vi['ctr.guarantee.field.document.label']).fill(papers[0] ?? '');
    await page.getByRole('button', { name: vi['ctr.guarantee.register.action'], exact: true }).click();
    const row = rowOf(page, number);
    await expect(row).toBeVisible();
    await expect(row).toContainText(vi['ctr.guarantee.status.pending.label']);
    await expect(row).toContainText(vi['ctr.guarantee.verification.unverified.label']);
    expect(await guaranteeOf(number)).toMatchObject({ status: 'PENDING_VERIFICATION', verification_status: 'UNVERIFIED', created_by: OFFICER, verified_by: null });
    // Registering the same number of the same issuer again is refused.
    await page.getByRole('button', { name: vi['ctr.guarantee.register.open'], exact: true }).click();
    await field(page, vi['ctr.guarantee.field.issuer.label']).fill('Ngân hàng Cao Bằng');
    await field(page, vi['ctr.guarantee.field.number.label']).fill(number);
    await field(page, vi['ctr.guarantee.field.amount.label']).fill('1');
    await field(page, vi['ctr.guarantee.field.validFrom.label']).fill('2026-03-01');
    await field(page, vi['ctr.guarantee.field.expiresOn.label']).fill(expiry);
    await field(page, vi['ctr.guarantee.field.document.label']).fill(papers[0] ?? '');
    await page.getByRole('button', { name: vi['ctr.guarantee.register.action'], exact: true }).click();
    await expect(page.getByTestId('problem')).toHaveText(vi['ctr.guarantee.problem.duplicate.error']);
    expect(await sql('select count(*)::int as n from machvon.guarantee where guarantee_no = $1', [number])).toEqual([{ n: 1 }]);

    // The registrant is told they cannot verify what they registered, and has no button for it.
    await page.reload();
    await expect(rowOf(page, number).getByTestId('own-registration')).toHaveText(vi['ctr.guarantee.verify.own.hint']);
    await expect(rowOf(page, number).getByRole('button', { name: vi['ctr.guarantee.verify.action'], exact: true })).toHaveCount(0);

    // The accountant verifies with the issuer: the method and the evidence are required.
    await open(page, guaranteesPage(seeded), 'ctrAccountant');
    await rowOf(page, number).getByRole('button', { name: vi['ctr.guarantee.verify.action'], exact: true }).click();
    await page.getByRole('button', { name: vi['ctr.guarantee.verify.submit'], exact: true }).click();
    await expect(page.getByTestId('action-panel').getByRole('alert')).toHaveCount(2);
    await field(page, vi['ctr.guarantee.field.method.label']).fill('Công văn hỏi và trả lời của ngân hàng');
    await field(page, vi['ctr.guarantee.field.evidence.label']).fill(papers[1] ?? '');
    await page.getByRole('button', { name: vi['ctr.guarantee.verify.submit'], exact: true }).click();
    await expect(page.getByTestId('notice')).toHaveText(vi['ctr.guarantee.verify.verified.notice']);
    await expect(rowOf(page, number)).toContainText(vi['ctr.guarantee.status.active.label']);
    expect(await guaranteeOf(number)).toMatchObject({ status: 'ACTIVE', verification_status: 'VERIFIED', verified_by: ACCOUNTANT, version: '2' });
    const original = await guaranteeOf(number);

    // The extension is a replacement: the old guarantee keeps its expiry and is superseded, the new one waits for its own verification.
    await rowOf(page, number).getByRole('button', { name: vi['ctr.guarantee.extend.action'], exact: true }).click();
    await field(page, vi['ctr.guarantee.field.newExpiresOn.label']).fill(expiry);
    await field(page, vi['ctr.guarantee.field.newNumber.label']).fill(replacement);
    await field(page, vi['ctr.guarantee.field.document.label']).fill(papers[0] ?? '');
    await page.getByRole('button', { name: vi['ctr.guarantee.extend.submit'], exact: true }).click();
    await expect(page.getByText(vi['ctr.guarantee.field.notLater.error'])).toBeVisible();
    await field(page, vi['ctr.guarantee.field.newExpiresOn.label']).fill(dayIn(240));
    await page.getByRole('button', { name: vi['ctr.guarantee.extend.submit'], exact: true }).click();
    await expect(page.getByTestId('notice')).toHaveText(vi['ctr.guarantee.extend.done.notice']);
    await expect(rowOf(page, replacement)).toContainText(vi['ctr.guarantee.status.pending.label']);
    await expect(rowOf(page, number)).toContainText(vi['ctr.guarantee.status.superseded.label']);
    const old = await guaranteeOf(number);
    const next = await guaranteeOf(replacement);
    expect(old).toMatchObject({ status: 'SUPERSEDED', expires_at: original?.expires_at });
    expect(next).toMatchObject({ status: 'PENDING_VERIFICATION', created_by: ACCOUNTANT });
    expect((await sql<{ extended_from_id: string }>('select extended_from_id from machvon.guarantee where guarantee_no = $1', [replacement]))[0]?.extended_from_id).toBe(
      (await sql<{ id: string }>('select id from machvon.guarantee where guarantee_no = $1', [number]))[0]?.id,
    );

    // The accountant who made the replacement cannot verify it; the second accountant verifies and releases it, with evidence.
    await expect(rowOf(page, replacement).getByTestId('own-registration')).toBeVisible();
    await open(page, guaranteesPage(seeded), 'ctrChecker');
    await rowOf(page, replacement).getByRole('button', { name: vi['ctr.guarantee.verify.action'], exact: true }).click();
    await field(page, vi['ctr.guarantee.field.method.label']).fill('Xác nhận của ngân hàng');
    await field(page, vi['ctr.guarantee.field.evidence.label']).fill(papers[1] ?? '');
    await page.getByRole('button', { name: vi['ctr.guarantee.verify.submit'], exact: true }).click();
    await expect(page.getByTestId('notice')).toHaveText(vi['ctr.guarantee.verify.verified.notice']);
    await rowOf(page, replacement).getByRole('button', { name: vi['ctr.guarantee.release.action'], exact: true }).click();
    await page.getByRole('button', { name: vi['ctr.guarantee.release.submit'], exact: true }).click();
    await expect(page.getByTestId('action-panel').getByRole('alert')).toHaveCount(2);
    expect((await guaranteeOf(replacement))?.status).toBe('ACTIVE');
    await field(page, vi['ctr.guarantee.field.releaseEvidence.label']).fill(papers[2] ?? '');
    await field(page, vi['ctr.guarantee.field.reason.label']).fill('Nhà thầu đã hoàn thành nghĩa vụ');
    await page.getByRole('button', { name: vi['ctr.guarantee.release.submit'], exact: true }).click();
    await expect(page.getByTestId('notice')).toHaveText(vi['ctr.guarantee.release.done.notice']);
    await expect(rowOf(page, replacement)).toContainText(vi['ctr.guarantee.status.released.label']);
    const released = await guaranteeOf(replacement);
    expect(released).toMatchObject({ status: 'RELEASED', released_by: CHECKER, verified_by: CHECKER });
    expect(released?.released_at).not.toBeNull();
    expect(await sql("select action from machvon.audit_event where resource_id = (select id from machvon.guarantee where guarantee_no = $1) order by occurred_at", [replacement])).toEqual([
      { action: 'guarantee.extended' },
      { action: 'guarantee.verified' },
      { action: 'guarantee.released' },
    ]);
  });

  test('an advance guarantee is kept while an advance is owed, and the accountant sees the amount owed in the expiring view (AC-ST-CTR-003-2, UI-CTR-05)', async ({ page }) => {
    const seeded = await draftContract('10000000000', { outstanding: '1250000000' });
    const papers = (await world()).papers;
    const number = code('BL-ADV');
    const contract = (await sql<{ id: string }>('select id from machvon.contract where code = $1', [seeded.code]))[0]?.id;
    const guaranteeId = randomUUID();
    await sql(
      `insert into machvon.guarantee (tenant_id, id, contract_id, kind, issuer, guarantee_no, amount_vnd, expires_at, verification_status, status, valid_from, document_version_id,
         verified_by, verified_at, verification_method, verification_evidence_id, created_by, updated_by)
       values ($1, $2, $3, 'ADVANCE', 'Ngân hàng Cao Bằng', $4, 2000000000, now() + interval '9 days', 'VERIFIED', 'ACTIVE', date '2026-03-01', $5, $6, now(), 'Công văn', $5, $7, $7)`,
      [stackInfo().tenants.A, guaranteeId, contract, number, papers[0], ACCOUNTANT, OFFICER],
    );
    await open(page, guaranteesPage(seeded), 'ctrAccountant');
    await rowOf(page, number).getByRole('button', { name: vi['ctr.guarantee.release.action'], exact: true }).click();
    await expect(page.getByTestId('advance-owed')).toHaveText(vi['ctr.guarantee.release.owed'].replace('{amount}', '1.250.000.000'));
    await field(page, vi['ctr.guarantee.field.releaseEvidence.label']).fill(papers[2] ?? '');
    await field(page, vi['ctr.guarantee.field.reason.label']).fill('Thử giải tỏa khi còn tạm ứng');
    await page.getByRole('button', { name: vi['ctr.guarantee.release.submit'], exact: true }).click();
    await expect(page.getByTestId('problem')).toHaveText(vi['ctr.guarantee.problem.releaseCondition.error'].replace('{amount}', '1.250.000.000'));
    expect(await guaranteeOf(number)).toMatchObject({ status: 'ACTIVE', released_by: null });

    await page.getByRole('button', { name: vi['ctr.guarantee.tab.expiring'], exact: true }).click();
    const expiring = page.getByTestId('expiring-row').filter({ hasText: seeded.code });
    await expect(expiring).toHaveCount(1);
    await expect(expiring.getByRole('cell').nth(6)).toHaveText('1.250.000.000');
    await expect(expiring.getByRole('cell').nth(5)).toHaveText('9');
  });

  test('a reader sees the guarantees and has no command; the reader of the lines only is denied the guarantees', async ({ page }) => {
    const seeded = await draftContract('1000');
    const papers = (await world()).papers;
    const number = code('BL-READ');
    const contract = (await sql<{ id: string }>('select id from machvon.contract where code = $1', [seeded.code]))[0]?.id;
    await sql(
      `insert into machvon.guarantee (tenant_id, id, contract_id, kind, issuer, guarantee_no, amount_vnd, expires_at, verification_status, status, valid_from, document_version_id, created_by, updated_by)
       values ($1, $2, $3, 'PERFORMANCE', 'Ngân hàng Cao Bằng', $4, 1000, now() + interval '200 days', 'UNVERIFIED', 'PENDING_VERIFICATION', date '2026-03-01', $5, $6, $6)`,
      [stackInfo().tenants.A, randomUUID(), contract, number, papers[0], OFFICER],
    );
    await open(page, guaranteesPage(seeded), 'ctrReader');
    await expect(rowOf(page, number)).toBeVisible();
    await expect(page.getByTestId('guarantees').getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['ctr.guarantee.register.open'], exact: true })).toHaveCount(0);

    await open(page, guaranteesPage(seeded), 'nobody');
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page.getByTestId('guarantee-row')).toHaveCount(0);
  });
});
