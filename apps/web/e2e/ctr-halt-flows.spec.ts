import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CTR-22 (suspend, resume and terminate a contract) in a real browser against the real API and database (apps/api/test/e2e-stack): the leader suspends an active contract on a decision
 * document and resumes it with an extension that does not move the due date; the one who proposed a termination is refused when they try to approve it, the leader terminates it with the
 * performance guarantee called, a violation is suggested for the contractor, and nothing is offered on the contract afterwards. A reader sees the contract and no command. What the
 * screens changed is looked up in the database.
 */

const MAKER = membershipOf('lifecycleMaker');
const PROPOSER = membershipOf('haltProposer');
const LEADER = membershipOf('haltLeader');
const VALUE = '1000000';
let counter = 0;
const code = (): string => {
  counter += 1;
  return `HD-HT-${Date.now().toString(36).toUpperCase()}-${counter}`;
};

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface Seeded {
  contractId: string;
  code: string;
  documentVersionId: string;
}

/** An ACTIVE contract of the project of the stack, drafted by `createdBy`, with a decision document that somebody else made; written straight to the database (foreign keys to modules that are not seeded are switched off, as in the stack). */
async function seedActive(createdBy: string, options: { guarantee?: boolean; decisionBy?: string } = {}): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' order by object_key");
  if (project === undefined || contractor === undefined || papers.length < 2) throw new Error('the contract fixtures of the stack are missing');
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const decisionDocumentId = randomUUID();
  const decisionVersionId = randomUUID();
  const contractCode = code();
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử tạm dừng', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, $7::numeric, $7::numeric, 0, $8, $8, $9, date '2026-01-02', $10, $11, date '2026-01-03', $12)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, contractCode, VALUE, createdBy, MAKER, membershipOf('lifecycleReviewer'), papers[0]?.id, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, $4::numeric, $5, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $6, $6, $7, now())`,
      [tenant, revisionId, contractId, VALUE, papers[0]?.id, createdBy, membershipOf('lifecycleActivator')],
    );
    // The decision document, made by whoever the test says: the maker of the document is one of the people who proposed what it decides.
    await client.query(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Quyết định thử', 'INTERNAL', $3, $3)`,
      [tenant, decisionDocumentId, options.decisionBy ?? membershipOf('lifecycleReviewer')],
    );
    await client.query(
      `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
       values ($1, $2, $3, 1, $4, repeat('c', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
      [tenant, decisionVersionId, decisionDocumentId, `tenants/e2e/qd-${decisionVersionId}.pdf`],
    );
    if (options.guarantee === true) {
      await client.query(
        `insert into machvon.guarantee
           (tenant_id, id, contract_id, kind, issuer, guarantee_no, amount_vnd, expires_at, verification_status, status, verified_by, verified_at, verification_method, verification_evidence_id, created_by)
         values ($1, gen_random_uuid(), $2, 'PERFORMANCE', 'Ngân hàng thử', $3, 100000, now() + interval '365 days', 'VERIFIED', 'ACTIVE', $4, now(), 'ISSUER_CONFIRMATION', $5, $6)`,
        [tenant, contractId, `BL-${randomUUID().slice(0, 8)}`, membershipOf('lifecycleReviewer'), papers[1]?.id, createdBy],
      );
    }
  } finally {
    await client.end();
  }
  return { contractId, code: contractCode, documentVersionId: decisionVersionId };
}

const stateOf = async (contractId: string) => {
  const [row] = await sql<{ status: string; status_reason: string | null; status_decision_document_version_id: string | null; completion_due: string | null; terminated_by: string | null }>(
    'select status, status_reason, status_decision_document_version_id, completion_due::text, terminated_by from machvon.contract where id = $1',
    [contractId],
  );
  if (row === undefined) throw new Error('the contract is missing');
  return row;
};

test.describe('CTR-22: suspend, resume and terminate a contract', () => {
  test('the leader suspends an active contract on a decision document and resumes it with an extension that does not move the due date (UI-CTR-22, AC-ST-CTR-005-1, UAT-AC303)', async ({ page }) => {
    const seeded = await seedActive(MAKER);
    await sql("update machvon.contract set completion_due = date '2027-03-31' where id = $1", [seeded.contractId]);

    await open(page, `/ctr/ctr-22?id=${seeded.contractId}`, 'haltLeader');
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.halt.page.title'] })).toBeVisible();
    await expect(page.getByTestId('contract-code')).toHaveText(seeded.code);
    await expect(page.locator('input[name="halt-action"]')).toHaveCount(2);
    await page.locator('input[data-action="suspend"]').check();
    await expect(page.getByTestId('impact')).toContainText(vi['ctr.halt.impact.suspend']);
    // What is missing is asked for before anything is sent.
    await page.getByRole('button', { name: vi['ctr.halt.submit.suspend'] }).click();
    await expect(page.getByText(vi['ctr.workspace.problem.required']).first()).toBeVisible();
    await page.locator('#halt-reason').fill('Công trường dừng theo quyết định của chủ đầu tư.');
    // A document that the tenant does not hold is refused by the server in words.
    await page.locator('#halt-document').fill(randomUUID());
    await page.getByRole('button', { name: vi['ctr.halt.submit.suspend'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['ctr.workspace.error.decisionDocument']);
    expect((await stateOf(seeded.contractId)).status).toBe('ACTIVE');

    await page.locator('#halt-document').fill(seeded.documentVersionId);
    await page.getByRole('button', { name: vi['ctr.halt.submit.suspend'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['ctr.halt.done.notice']);
    await expect(page.getByText(vi['ctr.status.suspended.label']).first()).toBeVisible();
    expect(await stateOf(seeded.contractId)).toMatchObject({ status: 'SUSPENDED', status_reason: 'Công trường dừng theo quyết định của chủ đầu tư.', status_decision_document_version_id: seeded.documentVersionId });

    // A suspended contract can be resumed or ended; the person resumes it.
    await expect(page.locator('input[name="halt-action"]')).toHaveCount(2);
    await page.locator('input[data-action="resume"]').check();
    await page.locator('#halt-reason').fill('Công trường hoạt động trở lại.');
    await page.locator('#halt-document').fill(seeded.documentVersionId);
    await page.locator('#halt-extension').fill('abc');
    await page.getByRole('button', { name: vi['ctr.halt.submit.resume'] }).click();
    await expect(page.getByText(vi['ctr.workspace.problem.extension'])).toBeVisible();
    await page.locator('#halt-extension').fill('20');
    await page.getByRole('button', { name: vi['ctr.halt.submit.resume'] }).click();
    await expect(page.getByText(vi['ctr.status.active.label']).first()).toBeVisible();
    expect(await stateOf(seeded.contractId)).toMatchObject({ status: 'ACTIVE', status_reason: null, completion_due: '2027-03-31' });
    const history = await sql<{ from_status: string; to_status: string }>('select from_status, to_status from machvon.contract_status_change where contract_id = $1 order by created_at', [seeded.contractId]);
    expect(history).toEqual([
      { from_status: 'ACTIVE', to_status: 'SUSPENDED' },
      { from_status: 'SUSPENDED', to_status: 'ACTIVE' },
    ]);
  });

  test('the one who made the decision document may not approve the termination; the leader terminates it with the guarantee called and nothing is offered after (UI-CTR-22, AC-ST-CTR-005-2, UAT-AC304)', async ({ page }) => {
    const seeded = await seedActive(MAKER, { guarantee: true, decisionBy: PROPOSER });

    await open(page, `/ctr/ctr-22?id=${seeded.contractId}`, 'haltProposer');
    await expect(page.locator('input[data-action="terminate"]')).toBeChecked();
    await expect(page.getByTestId('irreversible')).toHaveText(vi['ctr.halt.irreversible.notice']);
    await page.locator('#halt-reason').fill('Nhà thầu bỏ công trường.');
    await page.locator('#halt-document').fill(seeded.documentVersionId);
    await page.locator('#halt-guarantee').selectOption('CALL');
    await page.getByRole('button', { name: vi['ctr.halt.submit.terminate'] }).click();
    await expect(page.getByText(vi['ctr.workspace.problem.confirm'])).toBeVisible();
    await page.locator('#halt-confirm').check();
    await page.getByRole('button', { name: vi['ctr.halt.submit.terminate'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['ctr.workspace.error.selfApproval']);
    expect((await stateOf(seeded.contractId)).status).toBe('ACTIVE');

    await open(page, `/ctr/ctr-22?id=${seeded.contractId}`, 'haltLeader');
    await page.locator('input[data-action="terminate"]').check();
    await page.locator('#halt-reason').fill('Nhà thầu bỏ công trường.');
    await page.locator('#halt-document').fill(seeded.documentVersionId);
    await page.locator('#halt-guarantee').selectOption('CALL');
    await page.locator('#halt-confirm').check();
    await page.getByRole('button', { name: vi['ctr.halt.submit.terminate'] }).click();
    await expect(page.getByTestId('done')).toBeVisible();
    await expect(page.getByTestId('no-command')).toHaveText(vi['ctr.workspace.noCommand.notice']);
    expect(await stateOf(seeded.contractId)).toMatchObject({ status: 'TERMINATED', status_reason: 'Nhà thầu bỏ công trường.', terminated_by: LEADER });
    expect(await sql<{ status: string }>("select status from machvon.guarantee where contract_id = $1 and kind = 'PERFORMANCE'", [seeded.contractId])).toEqual([{ status: 'CALLED' }]);
    expect(await sql<{ status: string; penalty_kind: string }>('select status, penalty_kind from machvon.contractor_violation where contract_id = $1', [seeded.contractId])).toEqual([{ status: 'RECORDED', penalty_kind: 'TERMINATION' }]);
  });

  test('the workspace of the contract leads to the screen, and a reader sees the contract and no command (UI-CTR-22)', async ({ page }) => {
    const seeded = await seedActive(MAKER);
    await open(page, `/ctr/ctr-03?id=${seeded.contractId}`, 'haltLeader');
    await page.getByTestId('halt-link').click();
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.halt.page.title'] })).toBeVisible();
    await expect(page.getByTestId('contract-code')).toHaveText(seeded.code);

    await open(page, `/ctr/ctr-22?id=${seeded.contractId}`, 'ctrReader');
    await expect(page.getByTestId('contract-code')).toHaveText(seeded.code);
    await expect(page.locator('input[name="halt-action"]')).toHaveCount(0);
    await expect(page.getByTestId('no-command')).toBeVisible();
  });
});
