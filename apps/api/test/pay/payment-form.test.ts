import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { DocumentStore, EffectiveAccessStore, InMemoryAuthzCache, PayClaimStore, PayPaymentStore, TenantDatabase } from '@machvon/db';
import type { ContractScopes } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { payModule } from '../../src/modules/pay';
import { PaymentFormController } from '../../src/modules/pay/payment-form.controller';
import { PaymentRequestReadsController } from '../../src/modules/pay/payment-request.controller';
import { DOCUMENT_FILE_PORT, MockDocumentFilePort } from '../../src/modules/doc/file-port';
import { PdfLibRenderer, loadRendererResources } from '../../src/modules/doc/pdf-renderer';
import { DOC_STATE_TEXT, PDF_RENDERER } from '../../src/modules/doc/tokens';
import { ACTOR, TENANT_A, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const FORMER = 11; // payment.forms.generate, payment.treasury.send, payment_request.read
const READER = 13; // payment_request.read
const NOBODY = 14;
const ELSEWHERE = 15; // the rights of FORMER over another branch
const MEMBERS = [FORMER, READER, NOBODY, ELSEWHERE];
const OTHER_BRANCH = 5;
const MAKER = 1;
const SENDER = 2;
const CHECKER = 3;
const TODAY = '2026-07-25';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the Treasury forms of a payment request over HTTP (ST-PAY-005)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  const payments = new PayPaymentStore();
  const claims = new PayClaimStore();
  const files = new MockDocumentFilePort();
  let app: RunningApp;
  let counter = 0;
  let layoutProfileId = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixtures.owner<R>(sql, params);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string }>('select safe_diff, actor_id from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
  const instances = (requestId: string) => rows<{ id: string; form_code: string; status: string }>('select id, form_code, status from machvon.payment_form_instance where payment_request_id = $1::uuid order by form_code, created_at', [requestId]);

  /** A template of a Treasury form: confirmed or waiting for its confirmation, from and until the days given. */
  async function template(formCode: string, options: { confirmed?: boolean; from?: string; until?: string | null } = {}): Promise<void> {
    const confirmed = options.confirmed !== false;
    await rows(
      `insert into machvon.document_template
         (tenant_id, id, template_code, revision, group_code, doc_type_code, form_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, confirmation_status, legal_confirmation_ref, legal_confirmed_by,
          legal_confirmed_at, watermark_text, origin, content_sha256, effective_from, effective_until, status, approved_by, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, 1, 'OTHER', 'QD', $3, $4, $5::uuid,
               '[{"kind":"paragraph","text":"Hợp đồng {{contract_code}}: đề nghị thanh toán {{net_text}} đồng, trong đó thu hồi tạm ứng {{advance_recovery_text}} đồng."}]'::jsonb, '{"required":["contract_code","net_text"]}'::jsonb,
               'Decree 254/2025/ND-CP, appendix (fixture)', $6, $7, $8, $9, $10, 'PLATFORM_PACK', repeat('e', 64), $11::date, $12::date, 'PUBLISHED', $13, $14, $14)`,
      [
        TENANT_A,
        `PAY-ND254-${formCode.replace(/\W/g, '')}-${randomUUID().slice(0, 4)}`,
        formCode,
        `Giấy đề nghị thanh toán ${formCode}`,
        layoutProfileId,
        confirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION',
        confirmed ? 'CXN-08' : null,
        confirmed ? memberId(CHECKER) : null,
        confirmed ? '2026-01-02T00:00:00Z' : null,
        confirmed ? null : 'CHƯA XÁC NHẬN',
        options.from ?? '2026-01-01',
        options.until ?? null,
        memberId(CHECKER),
        memberId(MAKER),
      ],
    );
  }
  /** The templates of the earlier tests go out of force (a template that was published is not deleted), so each test starts with the ones it makes. */
  async function resetTemplates(): Promise<void> {
    await rows("update machvon.document_template set effective_until = effective_from + 1 where form_code in ('03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT') and (effective_until is null or effective_until > effective_from + 1)");
  }

  /** A payment request that has been drawn up, sent and checked. */
  async function checked(): Promise<{ id: string; version: number; contractId: string }> {
    counter += 1;
    const contract = await fixtures.seedContract();
    await rows('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
    await rows('update machvon.contract set advance_paid_vnd = 2000000000 where id = $1::uuid', [contract.contractId]);
    await rows(
      `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
       values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 1, 'GPMB', 2000000000, 2000000000, 'PAID', 2000000000, date '2026-06-01', 80, date '2026-12-31', $4::uuid, $4::uuid)`,
      [TENANT_A, contract.contractId, contract.partyId, memberId(MAKER)],
    );
    const approved = await fixtures.approve(contract, [
      { item: 0, quantity: '2000' },
      { item: 1, quantity: '500' },
    ]);
    const made = await fixtures.as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'INTERIM', acceptanceId: approved.acceptance.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-FM-${counter}-${randomUUID().slice(0, 5)}` }, memberId(MAKER), everything, TODAY), MAKER);
    const document = await fixtures.documentVersion();
    await fixtures.as((tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-FM-${counter}-${randomUUID().slice(0, 5)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }), MAKER);
    const sent = await fixtures.as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(SENDER), everything, TODAY), SENDER);
    const verified = await fixtures.as((tx) => claims.verify(tx, made.id, sent.version, undefined, memberId(CHECKER), everything), CHECKER);
    return { id: made.id, version: verified.version, contractId: contract.contractId };
  }
  const generate = (member: number, id: string, formCodes: string[], place = 'Cao Bằng') => call('POST', `/payment-requests/${id}/forms`, { member, body: { form_codes: formCodes, place } });
  const sendToTreasury = (member: number, id: string, version: number | string, ids: string[], overrides: Record<string, unknown> = {}) =>
    call('POST', `/payment-requests/${id}/send-treasury`, { member, ifMatch: `"${version}"`, body: { treasury_submitted_on: '2026-07-24', treasury_ref: 'KB-2026-0001', form_instance_ids: ids, ...overrides } });
  const versionOf = async (id: string): Promise<string> => (await rows<{ version: string }>('select version::text as version from machvon.payment_request where id = $1::uuid', [id]))[0]?.version ?? '0';

  beforeAll(async () => {
    await fixtures.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 101, 'PAY_FORMER', ['payment.forms.generate', 'payment.treasury.send', 'payment_request.read'], 30);
    await harness.seedRole(TENANT_A, 103, 'PAY_READER', ['payment_request.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: FORMER, role: 101, kind: 'TENANT' },
      { n: 3, member: READER, role: 103, kind: 'TENANT' },
      { n: 4, member: ELSEWHERE, role: 101, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    // The tenant starts with the layout profile of Decree 30/2020 waiting for its confirmation; it is confirmed here, so a form is stamped only for the template.
    const seeded = await tenants.withTenant(contextFor(TENANT_A, ACTOR), (tx) => new DocumentStore().seedDefaults(tx, ACTOR));
    layoutProfileId = seeded.layoutProfileId;
    await rows("update machvon.document_layout_profile set confirmation_status = 'CONFIRMED', legal_confirmation_ref = 'CXN-DOC-01' where id = $1::uuid", [layoutProfileId]);
    const resources = loadRendererResources();
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PaymentFormController, PaymentRequestReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DOCUMENT_FILE_PORT, useValue: files },
        { provide: PDF_RENDERER, useValue: new PdfLibRenderer(resources) },
        { provide: DOC_STATE_TEXT, useValue: resources.text },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await fixtures.stop();
  }, 60_000);

  it('is registered in the module of PAY', () => {
    expect(payModule.controllers).toEqual(expect.arrayContaining([PaymentFormController]));
  });

  it('AC-ST-PAY-005-1, UAT-AC337: draws a form from the template in force that is confirmed, keeps its proof, refuses a template that waits for its confirmation or is out of force, and a new form supersedes the old', async () => {
    await resetTemplates();
    await template('03.a/TT');
    await template('05.a/TT', { confirmed: false });
    await template('04.b/TT', { from: '2025-01-01', until: '2025-12-31' });
    const target = await checked();

    const drawn = await generate(FORMER, target.id, ['03.a/TT']);
    expect(drawn.status).toBe(200);
    expect(drawn.json).toMatchObject({ status: 'VERIFIED', gross_vnd: '3000000000', net_vnd: '2100000000' });
    const [form] = drawn.json.forms as Array<Record<string, unknown>>;
    expect(form).toMatchObject({ form_code: '03.a/TT', status: 'GENERATED', template_revision: 1, legal_basis: 'Decree 254/2025/ND-CP, appendix (fixture)', generated_by: memberId(FORMER) });
    expect(form?.file_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(form?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The file DOC stored is a PDF whose hash is the one kept, and it is the file of a document of the tenant.
    const [version] = await rows<{ checksum: string; mime: string; scan_status: string }>('select checksum, mime, scan_status from machvon.document_version where id = $1::uuid', [form?.document_version_id]);
    expect(version).toMatchObject({ checksum: form?.file_sha256, mime: 'application/pdf', scan_status: 'CLEAN' });

    expect(await generate(FORMER, target.id, ['05.a/TT'])).toMatchObject({ status: 422, json: { code: 'TEMPLATE_UNCONFIRMED', form_code: '05.a/TT' } });
    expect(await generate(FORMER, target.id, ['04.b/TT'])).toMatchObject({ status: 422, json: { code: 'TEMPLATE_NOT_EFFECTIVE', form_code: '04.b/TT' } });
    expect(await generate(FORMER, target.id, ['04.a/TT'])).toMatchObject({ status: 422, json: { code: 'TEMPLATE_NOT_EFFECTIVE', form_code: '04.a/TT' } });
    // Asked together, the forms are drawn all or none: nothing of 03.a/TT is drawn again when 05.a/TT is refused.
    expect(await generate(FORMER, target.id, ['03.a/TT', '05.a/TT'])).toMatchObject({ status: 422, json: { code: 'TEMPLATE_UNCONFIRMED' } });
    expect((await instances(target.id)).map((row) => [row.form_code, row.status])).toEqual([['03.a/TT', 'GENERATED']]);

    // A new form for the same kind replaces the one before: one stands.
    const again = await generate(FORMER, target.id, ['03.a/TT'], 'Hà Nội');
    expect(again.status).toBe(200);
    expect((await instances(target.id)).map((row) => [row.form_code, row.status])).toEqual([
      ['03.a/TT', 'SUPERSEDED'],
      ['03.a/TT', 'GENERATED'],
    ]);
    const [audit] = await audits(target.id, 'payment_request.forms_generated');
    expect(audit).toMatchObject({ actor_id: memberId(FORMER), safe_diff: { gross_vnd: '3000000000', forms: [{ form_code: '03.a/TT', template_revision: 1 }] } });
    expect((await events(target.id, 'pay.payment_form.generated.v1')).length).toBe(2);
    const listed = await call('GET', `/payment-requests/${target.id}/forms`, { member: READER });
    expect(listed.status).toBe(200);
    expect((listed.json.items as Array<Record<string, unknown>>).map((item) => [item.form_code, item.status])).toEqual([
      ['03.a/TT', 'GENERATED'],
      ['03.a/TT', 'SUPERSEDED'],
    ]);
  });

  it('AC-ST-PAY-005-2, UAT-PLAN-20: refuses to send the file without a form of each of the four kinds, and with them records the day and the number that were entered, calling no one', async () => {
    await resetTemplates();
    for (const code of ['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT']) await template(code);
    const target = await checked();
    const ids: string[] = [];
    const first = await generate(FORMER, target.id, ['03.a/TT']);
    ids.push((first.json.forms as Array<{ id: string }>)[0]!.id);
    expect(await sendToTreasury(FORMER, target.id, target.version, ids)).toMatchObject({ status: 422, json: { code: 'FORMS_NOT_GENERATED', missing_form_codes: ['04.a/TT', '04.b/TT', '05.a/TT'] } });
    const rest = await generate(FORMER, target.id, ['04.a/TT', '04.b/TT', '05.a/TT']);
    expect(rest.status).toBe(200);
    ids.push(...(rest.json.forms as Array<{ id: string }>).map((item) => item.id));
    expect(ids).toHaveLength(4);

    expect(await sendToTreasury(READER, target.id, target.version, ids)).toMatchObject({ status: 403 });
    expect(await sendToTreasury(FORMER, target.id, 99, ids)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    const sent = await sendToTreasury(FORMER, target.id, target.version, ids);
    expect(sent).toMatchObject({ status: 200, json: { status: 'SENT_TREASURY', resource_version: target.version + 1 } });
    const [row] = await rows<{ treasury_submitted_on: string; treasury_ref: string; treasury_sent_by: string }>('select treasury_submitted_on::text, treasury_ref, treasury_sent_by from machvon.payment_request where id = $1::uuid', [target.id]);
    expect(row).toEqual({ treasury_submitted_on: '2026-07-24', treasury_ref: 'KB-2026-0001', treasury_sent_by: memberId(FORMER) });
    const [audit] = await audits(target.id, 'payment_request.sent_treasury');
    expect(audit).toMatchObject({ actor_id: memberId(FORMER), safe_diff: { from_status: 'VERIFIED', to_status: 'SENT_TREASURY', treasury_submitted_on: '2026-07-24', treasury_ref: 'KB-2026-0001' } });
    expect((await events(target.id, 'pay.payment_request.sent_treasury.v1'))[0]?.payload).toMatchObject({ payment_request_id: target.id, status: 'SENT_TREASURY', treasury_ref: 'KB-2026-0001', version: target.version + 1 });
    // Once sent it is not sent again, nor drawn forms for.
    expect(await sendToTreasury(FORMER, target.id, target.version + 1, ids)).toMatchObject({ status: 409, json: { code: 'PAYMENT_STATE_INVALID' } });
    expect(await generate(FORMER, target.id, ['03.a/TT'])).toMatchObject({ status: 409, json: { code: 'PAYMENT_STATE_INVALID' } });
  });

  it('UAT-PLAN-40 shows the buttons the caller may press and the proof on the request, and none to a person who may not; a request sent to the Treasury reads as SENT_TREASURY with its net as whole dong and the time of the server', async () => {
    await resetTemplates();
    for (const code of ['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT']) await template(code);
    const target = await checked();
    const read = (member: number) => call('GET', `/resources/payment_request/${target.id}`, { member });
    expect((await read(FORMER)).json).toMatchObject({ forms_standing: [], treasury_ref: null, actions: { generate_forms: true, send_treasury: false } });
    expect((await read(READER)).json).toMatchObject({ actions: { generate_forms: false, send_treasury: false } });
    const drawn = await generate(FORMER, target.id, ['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT']);
    expect(drawn.status).toBe(200);
    expect((await read(FORMER)).json).toMatchObject({ forms_standing: ['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT'], actions: { generate_forms: true, send_treasury: true } });
    expect((await read(READER)).json).toMatchObject({ actions: { send_treasury: false } });
    await sendToTreasury(FORMER, target.id, await versionOf(target.id), (drawn.json.forms as Array<{ id: string }>).map((item) => item.id));
    const sentRead = await read(FORMER);
    expect(sentRead.json).toMatchObject({ status: 'SENT_TREASURY', treasury_submitted_on: '2026-07-24', treasury_ref: 'KB-2026-0001', actions: { generate_forms: false, send_treasury: false } });
    // The money is an integer count of dong in a string, never a number with decimals; the time is the one the server stored, not the one of the phone that reads it.
    expect(sentRead.json).toMatchObject({ net_vnd: '2100000000', gross_vnd: '3000000000' });
    expect(String(sentRead.json.net_vnd)).toMatch(/^[0-9]+$/);
    const [stored] = await rows<{ updated_at: Date }>('select updated_at from machvon.payment_request where id = $1::uuid', [target.id]);
    expect(new Date(sentRead.json.updated_at as string).getTime()).toBe(stored?.updated_at.getTime());
  });

  it('keeps the people apart and asks for what a form needs: who may draw, where, which form, and a request that is checked', async () => {
    await resetTemplates();
    await template('03.a/TT');
    const target = await checked();
    expect(await generate(READER, target.id, ['03.a/TT'])).toMatchObject({ status: 403 });
    expect(await generate(NOBODY, target.id, ['03.a/TT'])).toMatchObject({ status: 403 });
    expect(await generate(ELSEWHERE, target.id, ['03.a/TT'])).toMatchObject({ status: 404 });
    expect(await generate(FORMER, randomUUID(), ['03.a/TT'])).toMatchObject({ status: 404 });
    expect(await generate(FORMER, target.id, ['99/XX'])).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await generate(FORMER, target.id, [])).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await generate(FORMER, target.id, ['03.a/TT'], '  ')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await call('POST', `/payment-requests/${target.id}/forms`, { member: FORMER, body: { form_codes: ['03.a/TT'], place: 'Cao Bằng', status: 'GENERATED' } })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
    expect(await call('GET', `/payment-requests/${target.id}/forms`, { member: NOBODY })).toMatchObject({ status: 403 });
    expect(await call('GET', `/payment-requests/${target.id}/forms`, { member: ELSEWHERE })).toMatchObject({ status: 404 });
    expect(await instances(target.id)).toEqual([]);
    // A request that is not yet checked has no forms drawn for it.
    const made = await checked();
    await rows("update machvon.payment_request set status = 'RETURNED', claims_acceptance = false, return_reason = 'x', returned_by = created_by, returned_at = now() where id = $1::uuid", [made.id]);
    expect(await generate(FORMER, made.id, ['03.a/TT'])).toMatchObject({ status: 409, json: { code: 'PAYMENT_STATE_INVALID' } });
  });
});
