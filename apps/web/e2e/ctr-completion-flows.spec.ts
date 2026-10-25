import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CTR-03 (the completion of a contract) in a real browser against the real API and database (apps/api/test/e2e-stack): the leader sees what stands in the way of the completion of a contract
 * that is being performed (a serious non-conformance that is open, a measurement that waits for a decision), is refused in words while each stands, and completes the contract on the
 * approved completion minutes once both are dealt with; nothing is offered on the contract afterwards, and its history says on which minutes it was completed. What the screen changed is looked
 * up in the database.
 */

const MAKER = membershipOf('lifecycleMaker');
const LEADER = membershipOf('contractCompleter');
let counter = 0;

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface Seeded {
  contractId: string;
  projectId: string;
  documentVersionId: string;
  minutesId: string;
  recordNo: string;
  ncrId: string;
  measurementId: string;
}

/**
 * An ACTIVE contract with the approved completion minutes, one serious non-conformance that is open and one measurement that was submitted, written straight to the database (foreign keys to
 * modules that are not seeded are switched off).
 */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const minutesId = randomUUID();
  const ncrId = randomUUID();
  const measurementId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const recordNo = `QA-HT-${suffix}`;
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' and scan_status = 'CLEAN' order by object_key");
  if (contractor === undefined || project === undefined || papers.length < 1) throw new Error('the contract fixtures of the stack are missing');
  const documentVersionId = papers[0]?.id ?? '';
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử hoàn thành', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 1200000::numeric, 1200000::numeric, 0, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, `HD-HT-${suffix}`, MAKER, membershipOf('lifecycleReviewer'), documentVersionId, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 1200000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, documentVersionId, MAKER, membershipOf('lifecycleActivator')],
    );
    await client.query(`update machvon.contract set current_revision_id = $2 where id = $1`, [contractId, revisionId]);
    await client.query(
      `insert into machvon.quality_acceptance
         (tenant_id, id, project_id, contract_id, inspection_id, record_no, acceptance_scope, document_version_id, status, required_roles, content_hash, created_by, updated_by, version, approved_at, approved_by, decision_note)
       values ($1, $2, $3, $4, $5, $6, 'COMPLETION', $7, 'APPROVED', '["CONTRACTOR","SUPERVISOR","OWNER"]'::jsonb, repeat('a', 64), $8, $8, 1, timestamptz '2026-10-01T03:00:00Z', $9, 'Approved for the test.')`,
      [tenant, minutesId, project.id, contractId, randomUUID(), recordNo, documentVersionId, MAKER, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.quality_nonconformance (tenant_id, id, project_id, contract_id, severity, action_owner_id, due_at, status, closure_evidence, blocks_acceptance, created_by, updated_by)
       values ($1, $2, $3, $4, 'CRITICAL', $5, now() + interval '7 days', 'OPEN', '{}'::jsonb, true, $5, $5)`,
      [tenant, ncrId, project.id, contractId, MAKER],
    );
    await client.query(
      `insert into machvon.measurement
         (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no, submitted_by, submitted_at, created_by, updated_by, version)
       values ($1, $2, $3, $4, $5, $6, $7, 1, 1, 1, 'SUBMITTED', jsonb_build_array(jsonb_build_object('document_version_id', $8::text)), $9, $10, now(), $10, $10, 1)`,
      [tenant, measurementId, contractId, revisionId, randomUUID(), randomUUID(), randomUUID(), documentVersionId, `M-${suffix}`, MAKER],
    );
  } finally {
    await client.end();
  }
  return { contractId, projectId: project.id, documentVersionId, minutesId, recordNo, ncrId, measurementId };
}

const stored = async (contractId: string) =>
  (
    await sql<{ status: string; version: string; completed_on: string | null; completion_quality_acceptance_id: string | null; completed_by: string | null }>(
      'select status, version::text, completed_on::text, completion_quality_acceptance_id, completed_by from machvon.contract where id = $1',
      [contractId],
    )
  )[0];

const stage = async (statement: string, params: unknown[]): Promise<void> => {
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(statement, params);
  } finally {
    await client.end();
  }
};

const vietnamToday = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

test.describe('the completion of a contract', () => {
  test('the leader is refused while a serious non-conformance is open and while a measurement waits, then completes the contract on the approved minutes (UI-CTR-03, AC-ST-CTR-011-1, UAT-AC305)', async ({
    page,
  }) => {
    const seeded = await seed();
    const path = `/ctr/ctr-03?id=${seeded.contractId}`;

    await open(page, path, 'contractCompleter');
    await expect(page.getByTestId('contract-code')).toBeVisible();
    // The way to completion says what stands in the way.
    const state = (key: string) => page.locator(`[data-completion="${key}"]`);
    await expect(state('acceptance')).toHaveAttribute('data-ok', 'true');
    await expect(state('ncr')).toHaveAttribute('data-ok', 'false');
    await expect(state('ncr')).toContainText(vi['ctr.workspace.completion.count'].replace('{count}', '1'));
    await expect(state('measurement')).toHaveAttribute('data-ok', 'false');

    // The first thing in the way is told in words, and nothing changes.
    await page.locator('[data-command="complete"]').click();
    await page.locator('#workspace-completed-on').fill(vietnamToday());
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.workspace.complete.submit'] }).click();
    await expect(page.getByTestId('refusal')).toContainText(vi['ctr.workspace.error.openCriticalNcr']);
    await expect(page.getByTestId('refusal')).toContainText(seeded.ncrId);
    expect(await stored(seeded.contractId)).toMatchObject({ status: 'ACTIVE', version: '1', completed_on: null });

    // Once the non-conformance is closed, the measurement is what is left.
    await stage(
      "update machvon.quality_nonconformance set status = 'CLOSED', verified_by = $2::uuid, closed_by = $2::uuid, closed_at = now(), closure_note = 'closed for the test' where id = $1::uuid",
      [seeded.ncrId, membershipOf('lifecycleActivator')],
    );
    await open(page, path, 'contractCompleter');
    await expect(state('ncr')).toHaveAttribute('data-ok', 'true');
    await page.locator('[data-command="complete"]').click();
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.workspace.complete.submit'] }).click();
    await expect(page.getByTestId('refusal')).toContainText(vi['ctr.workspace.error.measurementPending']);
    await expect(page.getByTestId('refusal')).toContainText(seeded.measurementId);
    expect((await stored(seeded.contractId))?.status).toBe('ACTIVE');

    // Once the measurement is decided, the contract is completed on the minutes.
    await stage("update machvon.measurement set status = 'APPROVED', decided_by = $2::uuid, decided_at = now() where id = $1::uuid", [seeded.measurementId, membershipOf('lifecycleActivator')]);
    await open(page, path, 'contractCompleter');
    await expect(state('measurement')).toHaveAttribute('data-ok', 'true');
    await page.locator('[data-command="complete"]').click();
    await expect(page.locator('#workspace-completion-acceptance')).toHaveValue(seeded.minutesId);
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.workspace.complete.submit'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['ctr.status.completed.label']);
    expect(await stored(seeded.contractId)).toMatchObject({
      status: 'COMPLETED',
      version: '2',
      completed_on: vietnamToday(),
      completion_quality_acceptance_id: seeded.minutesId,
      completed_by: LEADER,
    });
    await expect(page.locator('[data-command]')).toHaveCount(0);
    await expect(page.getByTestId('completion-checks')).toHaveCount(0);
    await expect(page.getByTestId('history')).toContainText(seeded.recordNo);
  });
});
