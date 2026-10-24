import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * ISS-01 and ISS-03 for the issues that other modules ask for (ST-ISS-005, ISS-11): the events of LND and PMT go through the real outbox, relay and intake
 * consumer of the e2e stack, and the screens show the result. A land complaint that carries a household, an identity number and an address opens an issue with
 * only a reference code, and the reader without the right to read households sees the issue and not its text; a second event for the same source object opens
 * nothing. What the screens show is checked against the database. The spec makes its own categories and policies.
 */

const PERSONAL = ['Nguyễn Văn Hộ', '079000000001', '12 Lê Lợi', 'Cao Bằng', '0901234567', 'bồi thường quá thấp'];

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function seedCategory(key: string, label: string, severity: string): Promise<void> {
  const tenant = stackInfo().tenants.A;
  const actor = membershipOf('owner');
  const record = randomUUID();
  const version = randomUUID();
  await sql("insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', $3, 'EFFECTIVE', $4, $4)", [tenant, record, key, actor]);
  await sql(
    `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
     values ($1, $2, $3, 'ISSUE_CATEGORY', $4, 1, $5, '{}', '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $6, $6)`,
    [tenant, version, record, key, label, actor],
  );
  await sql('update machvon.master_record set current_version_id = $2 where id = $1', [record, version]);
  await sql(
    `insert into machvon.issue_sla_policy (tenant_id, id, code, revision, category_version_id, category_record_id, severity, calendar_code, response_hours, resolve_hours, valid_from, status, created_by, updated_by)
     values ($1, $2, $3, 1, $4, $5, $6, 'WORKDAY_VN', 4, 16, date_trunc('year', now())::date, 'ACTIVE', $7, $7)`,
    [tenant, randomUUID(), `E2E-INTAKE-${key}`, version, record, severity, actor],
  );
}

/** What another module writes to the outbox when its event happens: the relay of the stack delivers it to the consumers. */
async function emit(type: string, payload: Record<string, unknown>): Promise<void> {
  const tenant = stackInfo().tenants.A;
  await sql(
    `insert into machvon.outbox_event (tenant_id, id, aggregate_id, type, schema_version, payload, created_at, aggregate_type, aggregate_version, event_key, correlation_id)
     values ($1, gen_random_uuid(), $2, $3, 1, $4::jsonb, now(), 'source', 1, $5, $6)`,
    [tenant, randomUUID(), type, JSON.stringify({ tenant_id: tenant, ...payload }), `e2e-intake:${randomUUID()}`, randomUUID()],
  );
}

const issuesOf = (source: string) =>
  sql<{ id: string; code: string; title: string; description: string; source_module: string; status: string; reported_by: string }>(
    'select id, code, title, description, source_module, status, reported_by from machvon.issue where source_ref_id = $1',
    [source],
  );

test.describe.configure({ mode: 'serial' });

test.describe('ISS-01 and ISS-03: automatic issues from LND and PMT without personal data', () => {
  let projectId = '';

  test.beforeAll(async () => {
    await seedCategory('LAND_CLEARANCE', 'Giải phóng mặt bằng (nguồn tự động)', 'MEDIUM');
    await seedCategory('PERMIT', 'Giấy phép (nguồn tự động)', 'HIGH');
    projectId = (await sql<{ id: string }>("select id from machvon.project where code = 'DA-01'"))[0]?.id ?? '';
  });

  test('a land complaint opens one issue with only a reference code, however many events come for it (AC-ST-ISS-005-1, AC-ST-ISS-005-2)', async ({ page }) => {
    const source = randomUUID();
    const complaint = {
      source_ref_id: source,
      project_id: projectId,
      reference_code: 'LC-E2E-001',
      household_name: PERSONAL[0],
      citizen_id: PERSONAL[1],
      address: `${PERSONAL[2]}, ${PERSONAL[3]}`,
      phone: PERSONAL[4],
      content: PERSONAL[5],
    };
    await emit('lnd.complaint.filed.v1', complaint);
    await expect.poll(async () => (await issuesOf(source)).length, { timeout: 30_000 }).toBe(1);
    // The same complaint comes again (a redelivery, a second event of the producer): nothing more is opened or changed.
    await emit('lnd.complaint.filed.v1', { ...complaint, reference_code: 'LC-E2E-002' });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const issues = await issuesOf(source);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue).toMatchObject({ title: 'Land complaint filed: LC-E2E-001', source_module: 'LND', status: 'OPEN' });
    expect(issue?.description).toBe('Land complaint filed: LC-E2E-001 (LND, LAND_CLEARANCE)');
    // Nothing a person said is anywhere in what the issue holds: the issue, its timeline, its audit rows and its events.
    const held = await sql(
      `select to_jsonb(i) as issue, (select jsonb_agg(to_jsonb(e)) from machvon.issue_event e where e.issue_id = i.id) as events,
              (select jsonb_agg(to_jsonb(a)) from machvon.audit_event a where a.resource_id = i.id) as audit,
              (select jsonb_agg(to_jsonb(o)) from machvon.outbox_event o where o.aggregate_id = i.id) as outbox
         from machvon.issue i where i.id = $1`,
      [issue?.id],
    );
    for (const personal of PERSONAL) expect(JSON.stringify(held)).not.toContain(personal);

    // The board shows it under its status with the source it came from; the workspace shows who opened it, and keeps the text of a land complaint from a reader who may not read households.
    await open(page, 'issueCoordinator', '/iss/iss-01');
    const card = page.locator('section[data-status="OPEN"] article', { hasText: 'LC-E2E-001' });
    await expect(card).toBeVisible();
    await expect(card).toContainText(vi['iss.source.lnd.text']);
    await open(page, 'issueCoordinator', `/iss/iss-03?id=${issue?.id ?? ''}`);
    await expect(page.getByTestId('summary')).toContainText(vi['iss.source.lnd.text']);
    await expect(page.getByTestId('description-hidden')).toHaveText(vi['iss.workspace.description.hidden']);
    await expect(page.getByTestId('timeline').locator('li')).toHaveCount(1);
  });

  test('an expired permit opens an issue that is read whole, and a second event for the same permit opens nothing (AC-ST-ISS-005-1)', async ({ page }) => {
    const source = randomUUID();
    await emit('pmt.permit.expired.v1', { source_ref_id: source, project_id: projectId, reference_code: 'GP-E2E-001' });
    await expect.poll(async () => (await issuesOf(source)).length, { timeout: 30_000 }).toBe(1);
    await emit('pmt.permit.expired.v1', { source_ref_id: source, project_id: projectId, reference_code: 'GP-E2E-001' });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const [issue] = await issuesOf(source);
    expect(await issuesOf(source)).toHaveLength(1);
    expect(issue).toMatchObject({ title: 'Permit expired: GP-E2E-001', source_module: 'PMT', status: 'OPEN' });
    await open(page, 'issueReader', `/iss/iss-03?id=${issue?.id ?? ''}`);
    await expect(page.getByRole('heading', { level: 1, name: /GP-E2E-001/ })).toBeVisible();
    await expect(page.getByTestId('summary')).toContainText(vi['iss.source.pmt.text']);
    await expect(page.getByTestId('summary')).toContainText('Permit expired: GP-E2E-001 (PMT, PERMIT)');
    // The reader only reads: nothing to do on an issue nobody has taken up.
    await expect(page.getByTestId('read-only')).toBeVisible();
  });

  test('an event that is not a well formed request, or asks for no issue, opens nothing', async () => {
    const before = (await sql<{ n: string }>("select count(*)::text as n from machvon.issue where source_module in ('LND', 'PMT')"))[0]?.n;
    await emit('lnd.complaint.filed.v1', { source_ref_id: 'not-a-uuid', project_id: projectId, reference_code: 'LC-E2E-BAD' });
    await emit('ctr.guarantee.expired.v1', { source_reference: randomUUID(), project_id: projectId, kind: 'ADVANCE', expires_on: '2026-12-01', issue_required: false });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect((await sql<{ n: string }>("select count(*)::text as n from machvon.issue where source_module in ('LND', 'PMT')"))[0]?.n).toBe(before);
    expect(await sql("select 1 from machvon.issue where title like '%LC-E2E-BAD%'")).toEqual([]);
  });
});
