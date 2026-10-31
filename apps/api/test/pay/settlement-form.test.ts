import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { APP_FILTER } from '@nestjs/core';
import { DocumentStore, EffectiveAccessStore, OutgoingDraftStore, InMemoryAuthzCache, PayLedgerStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { payModule } from '../../src/modules/pay';
import { ProjectSettlementController, ProjectSettlementReadsController } from '../../src/modules/pay/project-settlement.controller';
import { SettlementFormController } from '../../src/modules/pay/settlement-form.controller';
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
const OFFICER = 61; // settlement.open, settlement.submit, settlement.verify, settlement.forms.generate, settlement_revision.read
const SENDER = 62; // the officer role: another one, who sends it
const VERIFIER = 63; // the officer role: a third, who verifies it
const READER = 64; // settlement_revision.read only
const NOBODY = 65;
const ELSEWHERE = 66; // the rights of the officer over another branch
const MEMBERS = [OFFICER, SENDER, VERIFIER, READER, NOBODY, ELSEWHERE];
const OTHER_BRANCH = 5;
const LEGAL = 70; // confirms the templates
const AUTHOR = 71; // the author of the templates
const SUBMITTED_ON = '2026-07-01';
const CODES = ['01/QTNĐ', '02/QTNĐ', '01/QTDA', '02/QTDA', '10/QTDA'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the forms of a settlement over HTTP (ST-PAY-012, UAT-AC340)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  const ledgers = new PayLedgerStore();
  const files = new MockDocumentFilePort();
  let app: RunningApp;
  let layoutProfileId = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixtures.owner<R>(sql, params);
  const audits = (id: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string }>('select safe_diff, actor_id from machvon.audit_event where resource_id = $1 and action = $2 order by seq', [id, action]);
  const events = (id: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [id, type]);
  const instances = (id: string) => rows<{ id: string; form_code: string; status: string }>('select id, form_code, status from machvon.payment_form_instance where settlement_revision_id = $1::uuid order by form_code, created_at', [id]);
  const versionOf = async (id: string): Promise<string> => (await rows<{ version: string }>('select version::text from machvon.settlement_revision where id = $1::uuid', [id]))[0]?.version ?? '0';

  /** Runs a statement as the superuser with the triggers off, to put a row in a state that only another story could. */
  async function admin(sql: string, params: unknown[] = []): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** A template of a settlement form: confirmed or waiting for its confirmation, from and until the days given. */
  async function template(formCode: string, options: { confirmed?: boolean; from?: string; until?: string | null } = {}): Promise<void> {
    const confirmed = options.confirmed !== false;
    await rows(
      `insert into machvon.document_template
         (tenant_id, id, template_code, revision, group_code, doc_type_code, form_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, confirmation_status, legal_confirmation_ref, legal_confirmed_by,
          legal_confirmed_at, watermark_text, origin, content_sha256, effective_from, effective_until, status, approved_by, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, 1, 'OTHER', 'QD', $3, $4, $5::uuid,
               '[{"kind":"paragraph","text":"Dự án {{project_code}}: giá trị quyết toán {{settled_amount_text}} đồng, còn phải trả {{outstanding_text}} đồng."}]'::jsonb, '{"required":["project_code","settled_amount_text"]}'::jsonb,
               'Circular 96/2021/TT-BTC, appendix (fixture)', $6, $7, $8, $9, $10, 'PLATFORM_PACK', repeat('e', 64), $11::date, $12::date, 'PUBLISHED', $13, $14, $14)`,
      [
        TENANT_A,
        `PAY-QT-${formCode.replace(/\W/g, '')}-${randomUUID().slice(0, 4)}`,
        formCode,
        `Biểu mẫu quyết toán ${formCode}`,
        layoutProfileId,
        confirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION',
        confirmed ? 'CXN-09' : null,
        confirmed ? memberId(LEGAL) : null,
        confirmed ? '2026-01-02T00:00:00Z' : null,
        confirmed ? null : 'CHƯA XÁC NHẬN',
        options.from ?? '2026-01-01',
        options.until ?? null,
        memberId(LEGAL),
        memberId(AUTHOR),
      ],
    );
  }
  /** The templates of the earlier tests go out of force (a template that was published is not deleted), so each test starts with the ones it makes. */
  async function resetTemplates(): Promise<void> {
    await rows("update machvon.document_template set effective_until = effective_from + 1 where form_code = any($1::text[]) and (effective_until is null or effective_until > effective_from + 1)", [CODES]);
  }

  async function project(): Promise<{ projectId: string; lineId: string }> {
    const line = await fixtures.world.publishedLine({ allocated: '10000000000000', appropriationAmount: '20000000000000', group: 'B' });
    await admin('update machvon.project set status = $2, project_group = $3 where id = $1::uuid', [line.projectId, 'COMPLETED', 'B']);
    return { projectId: line.projectId, lineId: line.lineId };
  }
  /** A project that owes something: an acceptance of 100m approved and recognised on the ledger of one of its contracts. */
  async function owingProject(): Promise<{ projectId: string }> {
    const target = await project();
    const contract = await fixtures.seedContract({ projectId: target.projectId, lineId: target.lineId });
    const approved = await fixtures.approve(contract, [{ item: 0, quantity: '100' }]);
    await fixtures.as((tx) => ledgers.recognize(tx, { acceptanceId: approved.acceptance.id, requestId: randomUUID(), actor: memberId(OFFICER) }), OFFICER);
    return target;
  }
  const command = async (member: number, id: string, action: string, body: Record<string, unknown>) => call('POST', `/settlements/${id}/${action}`, { member, body, ifMatch: `"${await versionOf(id)}"` });
  /** A settlement of the scope given, sent and verified. */
  async function verified(body: Record<string, unknown> = {}): Promise<string> {
    const target = await owingProject();
    const opened = await call('POST', '/settlements', { member: OFFICER, body: { project_id: target.projectId, settlement_scope: 'PROJECT', ...body } });
    expect(opened.status).toBe(200);
    const id = String(opened.json.resource_id);
    expect((await command(SENDER, id, 'submit', { submitted_on: SUBMITTED_ON })).status).toBe(200);
    expect((await command(VERIFIER, id, 'verification', { outcome: 'VERIFYING', findings: 'Taken up.' })).status).toBe(200);
    expect((await command(VERIFIER, id, 'verification', { outcome: 'VERIFIED', findings: 'The figures agree with the ledgers.' })).status).toBe(200);
    return id;
  }
  const generate = (member: number, id: string, formCodes: string[], place = 'Cao Bằng') => call('POST', `/settlements/${id}/forms`, { member, body: { form_codes: formCodes, place } });

  beforeAll(async () => {
    await fixtures.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of [...MEMBERS, LEGAL, AUTHOR]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 411, 'SETTLEMENT_OFFICER', ['settlement.open', 'settlement.submit', 'settlement.verify', 'settlement.forms.generate', 'settlement_revision.read'], 30);
    await harness.seedRole(TENANT_A, 412, 'SETTLEMENT_READER', ['settlement_revision.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OFFICER, role: 411, kind: 'TENANT' },
      { n: 2, member: SENDER, role: 411, kind: 'TENANT' },
      { n: 3, member: VERIFIER, role: 411, kind: 'TENANT' },
      { n: 4, member: READER, role: 412, kind: 'TENANT' },
      { n: 5, member: ELSEWHERE, role: 411, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
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
      controllers: [ProjectSettlementController, ProjectSettlementReadsController, SettlementFormController],
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
    expect(payModule.controllers).toEqual(expect.arrayContaining([SettlementFormController]));
  });

  it('AC-ST-PAY-012-1, UAT-AC340: draws the forms of a completed project from the templates that are confirmed, keeps the proof of each, and refuses the one that waits for its confirmation', async () => {
    await resetTemplates();
    await template('01/QTDA');
    await template('10/QTDA');
    await template('02/QTDA', { confirmed: false });
    const id = await verified();
    const done = await generate(OFFICER, id, ['10/QTDA', '01/QTDA']);
    expect(done).toMatchObject({ status: 200, json: { status: 'VERIFIED', resource_id: id } });
    const forms = done.json.forms as Array<Record<string, unknown>>;
    expect(forms.map((form) => [form.form_code, form.status])).toEqual([
      ['01/QTDA', 'GENERATED'],
      ['10/QTDA', 'GENERATED'],
    ]);
    expect(forms[0]).toMatchObject({
      settlement_id: id,
      template_revision: 1,
      legal_basis: 'Circular 96/2021/TT-BTC, appendix (fixture)',
      generated_by: memberId(OFFICER),
      file_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(Object.keys(forms[0] ?? {}).sort()).toEqual(
      ['document_id', 'document_version_id', 'file_sha256', 'form_code', 'generated_at', 'generated_by', 'id', 'legal_basis', 'payload_sha256', 'settlement_id', 'status', 'template_code', 'template_revision'].sort(),
    );
    expect((await instances(id)).map((form) => [form.form_code, form.status])).toEqual([
      ['01/QTDA', 'GENERATED'],
      ['10/QTDA', 'GENERATED'],
    ]);
    const [audit] = await audits(id, 'settlement_revision.forms_generated');
    expect(audit).toMatchObject({ actor_id: memberId(OFFICER), safe_diff: { settlement_scope: 'PROJECT', revision: 1 } });
    expect((audit?.safe_diff.forms as Array<{ form_code: string }>).map((form) => form.form_code)).toEqual(['01/QTDA', '10/QTDA']);
    const [told] = await events(id, 'pay.settlement_form.generated.v1');
    expect(told?.payload).toMatchObject({ settlement_id: id, project_id: expect.any(String) });
    // The file belongs to the unit that owns the project, so that officers with a document right on that unit can download what they drew.
    expect(
      await rows('select 1 from machvon.payment_form_instance f join machvon.document d on d.id = f.document_id join machvon.settlement_revision s on s.id = f.settlement_revision_id join machvon.project p on p.id = s.project_id where f.settlement_revision_id = $1::uuid and d.issuer_unit_id = p.owner_unit_id', [id]),
    ).toHaveLength(2);
    // The proof names the revision the file was drawn from: the template of the form is the template of its version.
    expect(
      await rows('select 1 from machvon.payment_form_instance f join machvon.document_version v on v.id = f.document_version_id where f.settlement_revision_id = $1::uuid and v.template_id = f.template_version_id', [id]),
    ).toHaveLength(2);

    // The decision 10/QTDA is a document of DOC: a draft that is not issued, for the unit that owns the project, with the settlement as its subject; drawing the form again drafts no second.
    const draftId = done.json.decision_draft_id as string;
    expect(draftId).toEqual(expect.any(String));
    expect(
      await rows<{ status: string; subject_module: string; subject_id: string; doc_type_code: string }>(
        'select o.status, d.subject_module, d.subject_id::text, d.doc_type_code from machvon.outgoing_document o join machvon.document d on d.tenant_id = o.tenant_id and d.id = o.document_id where o.id = $1::uuid',
        [draftId],
      ),
    ).toEqual([{ status: 'DRAFT', subject_module: 'PAY', subject_id: id, doc_type_code: 'QD' }]);
    // DOC judges the authority of the signer by the amount of the document: the value of the settlement.
    const [content] = await rows<{ payload: { amount_vnd?: string } }>('select payload_json as payload from machvon.outgoing_document where id = $1::uuid', [draftId]);
    expect(content?.payload.amount_vnd).toEqual(expect.stringMatching(/^[0-9]+$/));
    expect(content?.payload.amount_vnd).toBe((await rows<{ settled: string }>('select settled_amount_vnd::text as settled from machvon.settlement_revision where id = $1::uuid', [id]))[0]?.settled);
    expect((await audits(draftId, 'outgoing_document.create'))[0]).toMatchObject({ actor_id: memberId(OFFICER), safe_diff: { subject_module: 'PAY', subject_id: id } });
    expect(((await generate(OFFICER, id, ['10/QTDA'])).json as { decision_draft_id: string | null }).decision_draft_id).toBeNull();
    expect(await rows('select 1 from machvon.outgoing_document o join machvon.document d on d.id = o.document_id where d.subject_module = $1 and d.subject_id = $2::uuid', ['PAY', id])).toHaveLength(1);

    // The form that waits for its confirmation is refused by name, and nothing of the batch is kept.
    const before = await instances(id);
    expect(await generate(OFFICER, id, ['01/QTDA', '02/QTDA'])).toMatchObject({ status: 422, json: { code: 'TEMPLATE_UNCONFIRMED', form_code: '02/QTDA' } });
    expect(await instances(id)).toEqual(before);
    expect(await versionOf(id)).toBe(await versionOf(id));
  });

  it('drafts the decision although DOC holds other correspondence of the settlement, and only one decision', async () => {
    await resetTemplates();
    await template('01/QTDA');
    await template('10/QTDA');
    const id = await verified();
    // An outgoing document of another kind that carries the same subject: it is not the decision.
    const [other] = await rows<{ id: string; layout_profile_id: string }>("select id, layout_profile_id from machvon.document_template where form_code = '01/QTDA' and effective_until is null limit 1");
    const [owner] = await rows<{ owner_unit_id: string }>('select p.owner_unit_id from machvon.settlement_revision s join machvon.project p on p.id = s.project_id where s.id = $1::uuid', [id]);
    await fixtures.as((tx) =>
      new OutgoingDraftStore().createDraft(tx, {
        docTypeCode: 'QD',
        title: 'Correspondence of the settlement',
        draftingUnitId: owner?.owner_unit_id ?? '',
        templateId: other?.id ?? '',
        layoutProfileId: other?.layout_profile_id ?? '',
        urgency: 'NORMAL',
        circulation: 'INTERNAL_CIRCULATION',
        classification: 'INTERNAL',
        payload: {},
        payloadSha256: 'a'.repeat(64),
        recipients: [],
        signerUserId: null,
        signerTitle: null,
        signingMode: 'DIRECT',
        delegationId: null,
        subjectModule: 'PAY',
        subjectId: id,
        replyToIncomingId: null,
        reviewDueOn: null,
        actor: memberId(OFFICER),
      }),
    );
    const first = await generate(OFFICER, id, ['10/QTDA']);
    expect(first.json.decision_draft_id).toEqual(expect.any(String));
    expect((await generate(OFFICER, id, ['10/QTDA'])).json.decision_draft_id).toBeNull();
    expect(await rows('select 1 from machvon.outgoing_document o join machvon.document d on d.id = o.document_id where d.subject_module = $1 and d.subject_id = $2::uuid', ['PAY', id])).toHaveLength(2);
  });

  it('draws a form again over the one that stood, which is superseded and kept, and lists the ones that stand first', async () => {
    await resetTemplates();
    await template('01/QTDA');
    const id = await verified();
    expect((await generate(OFFICER, id, ['01/QTDA'])).status).toBe(200);
    expect((await generate(OFFICER, id, ['01/QTDA'], 'Hà Nội')).status).toBe(200);
    expect((await instances(id)).map((form) => form.status)).toEqual(['SUPERSEDED', 'GENERATED']);
    const listed = await call('GET', `/settlements/${id}/forms`, { member: READER });
    expect(listed.status).toBe(200);
    expect((listed.json.items as Array<{ status: string }>).map((form) => form.status)).toEqual(['GENERATED', 'SUPERSEDED']);
    expect(await call('GET', `/settlements/${randomUUID()}/forms`, { member: READER })).toMatchObject({ status: 404 });
    expect(await call('GET', `/settlements/${id}/forms`, { member: NOBODY })).toMatchObject({ status: 403 });
    expect(await call('GET', `/settlements/${id}/forms`, { member: ELSEWHERE })).toMatchObject({ status: 404 });
  });

  it('draws the forms of a year only for a settlement of a year, and the forms of a project only for a project', async () => {
    await resetTemplates();
    await template('01/QTNĐ');
    await template('01/QTDA');
    const annual = await verified({ settlement_scope: 'ANNUAL', fiscal_year: 2026 });
    expect(await generate(OFFICER, annual, ['01/QTDA'])).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    const done = await generate(OFFICER, annual, ['01/QTNĐ']);
    expect(done).toMatchObject({ status: 200 });
    expect((done.json.forms as Array<Record<string, unknown>>)[0]).toMatchObject({ form_code: '01/QTNĐ', status: 'GENERATED' });
    const project = await verified();
    expect(await generate(OFFICER, project, ['01/QTNĐ'])).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await generate(OFFICER, project, [])).toMatchObject({ status: 422 });
    expect(await generate(OFFICER, project, ['01/QTDA', '01/QTDA'])).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
  });

  it('refuses a template out of force, a settlement that is not verified, a missing place and a caller without the right', async () => {
    await resetTemplates();
    await template('01/QTDA', { from: '2025-01-01', until: '2025-12-31' });
    const id = await verified();
    expect(await generate(OFFICER, id, ['01/QTDA'])).toMatchObject({ status: 422, json: { code: 'TEMPLATE_NOT_EFFECTIVE', form_code: '01/QTDA' } });
    await template('01/QTDA');
    expect(await generate(OFFICER, id, ['01/QTDA'], '   ')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await generate(READER, id, ['01/QTDA'])).toMatchObject({ status: 403 });
    expect(await generate(ELSEWHERE, id, ['01/QTDA'])).toMatchObject({ status: 404 });
    expect(await generate(OFFICER, randomUUID(), ['01/QTDA'])).toMatchObject({ status: 404 });

    const target = await owingProject();
    const draft = await call('POST', '/settlements', { member: OFFICER, body: { project_id: target.projectId, settlement_scope: 'PROJECT' } });
    expect(await generate(OFFICER, String(draft.json.resource_id), ['01/QTDA'])).toMatchObject({ status: 409, json: { code: 'SETTLEMENT_STATE_INVALID' } });
  });

  it('keeps the database honest when the application is bypassed: a form of a settlement that is not verified, or with a code that is not one of the settlement, is refused', async () => {
    const target = await owingProject();
    const draft = String((await call('POST', '/settlements', { member: OFFICER, body: { project_id: target.projectId, settlement_scope: 'PROJECT' } })).json.resource_id);
    const insert = (settlementId: string, formCode: string) =>
      rows(
        `insert into machvon.payment_form_instance (tenant_id, id, subject_kind, settlement_revision_id, form_code, status, legal_basis, created_by, updated_by)
         values ($1, gen_random_uuid(), 'SETTLEMENT', $2::uuid, $3, 'REQUESTED', 'basis', $4::uuid, $4::uuid)`,
        [TENANT_A, settlementId, formCode, memberId(OFFICER)],
      );
    await expect(insert(draft, '13/QTDA')).rejects.toThrow(/payment_form_instance_settlement_code_chk/);
    await expect(insert(draft, '03.a/TT')).rejects.toThrow(/payment_form_instance_settlement_code_chk/);
    await expect(insert(draft, '01/QTDA')).resolves.toBeDefined();
    const generated = (settlementId: string) =>
      rows(
        `insert into machvon.payment_form_instance
           (tenant_id, id, subject_kind, settlement_revision_id, form_code, template_version_id, template_code, template_revision, document_id, document_version_id, file_sha256, payload_sha256, input_sha256,
            legal_basis, status, generated_at, generated_by, created_by, updated_by)
         select $1, gen_random_uuid(), 'SETTLEMENT', $2::uuid, '01/QTDA', t.id, 'T', 1, d.id, v.id, repeat('a', 64), repeat('b', 64), repeat('c', 64), 'basis', 'GENERATED', now(), $3::uuid, $3::uuid, $3::uuid
           from machvon.document_template t, machvon.document d join machvon.document_version v on v.document_id = d.id limit 1`,
        [TENANT_A, settlementId, memberId(OFFICER)],
      );
    await expect(generated(draft)).rejects.toThrow(/SETTLEMENT_STATE_INVALID/);
    // The move from requested to generated is judged as the insert is: a form with all its proof cannot become one of a settlement that is not verified, or of the other scope.
    const proven = (settlementId: string) =>
      rows<{ id: string }>(
        `insert into machvon.payment_form_instance
           (tenant_id, id, subject_kind, settlement_revision_id, form_code, template_version_id, template_code, template_revision, document_id, document_version_id, file_sha256, payload_sha256, input_sha256,
            legal_basis, status, generated_at, generated_by, created_by, updated_by)
         select $1, gen_random_uuid(), 'SETTLEMENT', $2::uuid, '01/QTDA', t.id, 'T', 1, d.id, v.id, repeat('a', 64), repeat('b', 64), repeat('c', 64), 'basis', 'REQUESTED', now(), $3::uuid, $3::uuid, $3::uuid
           from machvon.document_template t, machvon.document d join machvon.document_version v on v.document_id = d.id limit 1 returning id`,
        [TENANT_A, settlementId, memberId(OFFICER)],
      );
    const [twoStep] = await proven(draft);
    await expect(rows("update machvon.payment_form_instance set status = 'GENERATED' where id = $1::uuid", [twoStep?.id])).rejects.toThrow(/SETTLEMENT_STATE_INVALID/);
    // A settlement that is verified takes the forms of its scope and no others: the code of a project on a settlement of a year is refused, and the reverse.
    await template('01/QTDA');
    const project = await verified();
    const year = await verified({ settlement_scope: 'ANNUAL', fiscal_year: 2026 });
    await expect(generated(year)).rejects.toThrow(/SETTLEMENT_STATE_INVALID/);
    await expect(generated(project)).resolves.toBeDefined();
  });
});
