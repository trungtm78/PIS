import { X509Certificate, createHash, randomUUID } from 'node:crypto';
import { DEMO_MARK, REPORT_FORM_CATALOGUE, crosscheckDefaults } from '@machvon/kernel';
import { fingerprintOf } from '../../src/modules/doc/cms-verification';
import { MockCertificateAuthority } from '../../src/modules/doc/mock-pki';
import { MockSigningPort } from '../../src/modules/doc/signing-port';
import type { SessionRef, SigningPort } from '../../src/modules/doc/signing-port';
import { DOC_SIGNING_PORT } from '../../src/modules/doc/tokens';
import { readXlsxMap, readXlsxMarks } from '../../src/modules/reports/xlsx-template';
import { TENANT_A } from '../../../../packages/db/test/support/authz-fixtures';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';
import { UatWorld } from '../uat/uat-world';
import { assertWithinBudget, measureP95 } from './support';

/**
 * Cases of docs/uat/rpt/uat.json that the suite `../uat/rpt.uat.test.ts` does not script: the demo forms of the enterprise edition from the closed door to the receiver who may not accept, the signing of an issued copy
 * that locks its period and the release of the lock by a second person, the comparison of the reports of one period that blocks a release until somebody else explains the difference, and the speed of the reads of the issued
 * copies. Each case is named by its id in the title of its test.
 */
jest.setTimeout(420_000);

const PERSONAS = {
  'rpt-preparer': ['rpt.read', 'rpt.generate', 'rpt.crosscheck.read', 'rpt.crosscheck.explain'],
  'rpt-checker': ['rpt.read', 'rpt.check'],
  'rpt-approver': ['rpt.read', 'rpt.approve', 'rpt.issue'],
  'rpt-sender': ['rpt.read', 'rpt.deliver', 'rpt.answer'],
  'rpt-explainer': ['rpt.read', 'rpt.crosscheck.read', 'rpt.crosscheck.explain'],
  'rpt-signer': ['rpt.read', 'rpt.sign', 'rpt.lock.read', 'rpt.lock.unlock'],
  'rpt-unlocker': ['rpt.read', 'rpt.lock.read', 'rpt.lock.unlock'],
  'rpt-reader': ['rpt.read', 'rpt.lock.read'],
};
const MONTH = { kind: 'MONTH', year: 2026, index: 10 };
const QUARTER = { kind: 'QUARTER', year: 2026, index: 3 };
const XCK_MONTHS = [10, 11, 12].map((index) => ({ kind: 'MONTH', year: 2025, index }));
const XCK_QUARTER = { kind: 'QUARTER', year: 2025, index: 4 };
const periodOf = (code: string): Record<string, unknown> => (REPORT_FORM_CATALOGUE.find((entry) => entry.code === code)?.period === 'QUARTER' ? QUARTER : MONTH);

describe('UAT cases of the reports of the enterprise edition that the suite of the area does not script (RPT)', () => {
  const world = new UatWorld();
  let savedDemoForms: string | undefined;

  beforeAll(async () => {
    savedDemoForms = process.env.DEMO_FORMS;
    delete process.env.DEMO_FORMS;
    await world.start(PERSONAS, { 'rpt-preparer': PERSONAS['rpt-preparer'] });
  }, 300_000);

  afterAll(async () => {
    if (savedDemoForms === undefined) delete process.env.DEMO_FORMS;
    else process.env.DEMO_FORMS = savedDemoForms;
    await world.stop();
  }, 60_000);

  const generate = (code: string, period: Record<string, unknown> = periodOf(code), persona = 'rpt-preparer'): Promise<Reply> => world.as(persona, 'POST', '/report-engine/drafts', { body: { layout_code: code, period } });
  const step = (persona: string, draftId: string, version: number, action: 'check' | 'approve' | 'issue'): Promise<Reply> => world.as(persona, 'POST', `/report-engine/drafts/${draftId}/${action}`, { ifMatch: version });
  const count = async (sql: string, params: unknown[] = []): Promise<number> => (await world.rows(sql, params)).length;

  /** The rule a tenant approves by the two-person rule of the governance module, written as approved by three different people (the maker, the submitter and the approver). */
  async function approveRule(type: string, params: Record<string, unknown>): Promise<void> {
    if ((await count('select 1 from machvon.governance_rule where rule_type = $1 and code = $2', [type, 'DEFAULT'])) > 0) return;
    await world.seedAsAdmin([
      [
        `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, gen_random_uuid(), $2, 'DEFAULT', 1, 'APPROVED', $3::jsonb, date '2020-01-01', 'Approval of the rule for the UAT', $4, $5, now(), $6, now())`,
        [TENANT_A, type, JSON.stringify(params), world.idOf('rpt-checker'), world.idOf('rpt-explainer'), world.idOf('rpt-approver')],
      ],
    ]);
  }

  /** A draft taken through the check and the approval by three different people. */
  async function approvedDraft(code: string, period: Record<string, unknown> = periodOf(code)): Promise<string> {
    const made = await generate(code, period);
    assertStatus(made, 200);
    const draftId = made.json.draft_id as string;
    assertStatus(await step('rpt-checker', draftId, 1, 'check'), 200);
    assertStatus(await step('rpt-approver', draftId, 2, 'approve'), 200);
    return draftId;
  }

  it('UAT-RPT-DEMO-01 a demo form is refused while demo forms are off (409 TEMPLATE_UNCONFIRMED), carries the demo mark in the print header, the footer, the properties and the first row once the rule of two people turns them on, and its receiver may not record it as accepted (409 TEMPLATE_UNCONFIRMED, counts_as_accepted false)', async () => {
    // Step 1: demo forms are off by default, and the refusal writes no draft.
    const refused = await generate('PVN-MONTHLY');
    assertStatus(refused, 409, 'TEMPLATE_UNCONFIRMED');
    expect(await count("select 1 from machvon.report_draft where layout_code = 'PVN-MONTHLY'")).toBe(0);

    // Step 2: the rule REPORT_FORM_MODE approved by two other people turns them on; the draft is made, checked, approved and issued by three different people.
    await approveRule('REPORT_FORM_MODE', { demo_forms: true });
    const draftId = await approvedDraft('PVN-MONTHLY');
    const issued = await step('rpt-approver', draftId, 3, 'issue');
    assertStatus(issued, 200);
    expect(issued.json).toMatchObject({ status: 'ISSUED' });
    const issueId = issued.json.resource_id as string;

    // Step 3: the copy and its Excel file carry the mark everywhere a reader or a printer looks.
    expect(DEMO_MARK).toBe('MẪU DEMO — chờ mẫu chính thức');
    const copy = (await world.as('rpt-sender', 'GET', `/report-engine/issues/${issueId}`)).json;
    expect(copy).toMatchObject({ form_status: 'DEMO', demo_mark: DEMO_MARK, counts_as_accepted: false, can_answer: false, data_source: 'ILLUSTRATIVE' });
    const file = await world.as('rpt-sender', 'GET', `/report-engine/issues/${issueId}/files/XLSX`);
    assertStatus(file, 200);
    const bytes = new Uint8Array(Buffer.from(file.json.content_base64 as string, 'base64'));
    const marks = await readXlsxMarks(bytes);
    expect(marks.subject).toContain(DEMO_MARK);
    expect(marks.sheets[0]?.oddHeader).toContain(DEMO_MARK);
    expect(marks.sheets[0]?.oddFooter).toContain(DEMO_MARK);
    const firstRow = Object.entries((await readXlsxMap(bytes))[0]?.cells ?? {})
      .filter(([address]) => /^[A-Z]+1$/.test(address))
      .map(([, cell]) => String(cell.value))
      .join(' ');
    expect(firstRow).toContain(DEMO_MARK);

    // Step 4: the copy is delivered, and the receiver may not write that it was accepted, in the application or in the database.
    const delivered = await world.as('rpt-sender', 'POST', `/report-engine/issues/${issueId}/deliveries`, { body: { receiver: 'PVN', channel: 'MANUAL' } });
    assertStatus(delivered, 200);
    expect(delivered.json).toMatchObject({ event: 'DELIVERED', counts_as_accepted: false });
    const accepted = await world.as('rpt-sender', 'POST', `/report-engine/issues/${issueId}/answers`, { body: { receiver: 'PVN', outcome: 'ACCEPTED', reference: 'receipt 1' } });
    assertStatus(accepted, 409, 'TEMPLATE_UNCONFIRMED');
    expect(await count("select 1 from machvon.report_delivery where issue_id = $1 and event = 'ACCEPTED'", [issueId])).toBe(0);
    expect((await world.rows<{ event: string }>('select event from machvon.report_delivery where issue_id = $1 order by occurred_at, id', [issueId])).map((row) => row.event)).toEqual(['DELIVERED']);
  });

  it('UAT-RPT-XCK-01 the reports of one period that do not add up block the release (409 REPORT_CROSSCHECK_BLOCKED, audited), the preparer cannot explain the difference (403 SELF_APPROVAL_DENIED), somebody else needs a reason of a few words (422) and then explains it, and the release goes through', async () => {
    await approveRule('REPORT_FORM_MODE', { demo_forms: true });
    // The demo forms run on invented data, so the tenant approves a version of the rule that compares illustrative data too; three months of PVN against the quarter of PVN do not add up.
    await world.seedAsAdmin([
      [
        `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, gen_random_uuid(), 'REPORT_CROSSCHECK', 'DEFAULT', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'Compare the demo data in the UAT', $3, $4, now(), $5, now())`,
        [TENANT_A, JSON.stringify({ ...crosscheckDefaults(), include_illustrative: true }), world.idOf('rpt-checker'), world.idOf('rpt-explainer'), world.idOf('rpt-approver')],
      ],
    ]);
    for (const month of XCK_MONTHS) assertStatus(await generate('PVN-MONTHLY', month), 200);
    const quarterly = await generate('PVN-QUARTERLY-F2', XCK_QUARTER);
    assertStatus(quarterly, 200);
    const draftId = quarterly.json.draft_id as string;
    assertStatus(await step('rpt-checker', draftId, 1, 'check'), 200);
    assertStatus(await step('rpt-approver', draftId, 2, 'approve'), 200);

    // Step 1: the release is blocked, nothing is issued and the refusal is on the trail.
    const issuedBefore = await count('select 1 from machvon.report_issue');
    const blocked = await step('rpt-approver', draftId, 3, 'issue');
    assertStatus(blocked, 409, 'REPORT_CROSSCHECK_BLOCKED');
    expect(blocked.json.blocking_count).toBeGreaterThan(0);
    expect(await count('select 1 from machvon.report_issue')).toBe(issuedBefore);
    expect(await count("select 1 from machvon.audit_event where action = 'rpt.report_issue_blocked'")).toBe(1);
    const crosscheck = (): Promise<Reply> => world.as('rpt-explainer', 'GET', `/report-engine/crosscheck?kind=QUARTER&year=2025&index=4&draft_id=${draftId}`);
    const findings = (await crosscheck()).json.findings as Array<{ severity: string; fingerprint: string; status: string }>;
    const blocking = findings.filter((finding) => finding.severity === 'BLOCKING');
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking.every((finding) => finding.status === 'OPEN')).toBe(true);
    const reason = 'The Treasury corrected the three months after the quarter was filled.';
    const explain = (persona: string, fingerprint: string, words: string): Promise<Reply> => world.as(persona, 'POST', '/report-engine/crosscheck/explanations', { body: { period: XCK_QUARTER, fingerprint, reason: words } });

    // Step 2: the preparer of the reports the difference is about does not explain it.
    const own = await explain('rpt-preparer', (blocking[0] as { fingerprint: string }).fingerprint, reason);
    assertStatus(own, 403, 'SELF_APPROVAL_DENIED');
    expect(await count("select 1 from machvon.audit_event where action = 'rpt.crosscheck_explained'")).toBe(0);

    // Step 3: another person, with a reason that is too short and then with a reason that is enough.
    assertStatus(await explain('rpt-explainer', (blocking[0] as { fingerprint: string }).fingerprint, 'too short'), 422, 'VALIDATION_FAILED');
    for (const finding of blocking) {
      const made = await explain('rpt-explainer', finding.fingerprint, reason);
      assertStatus(made, 200);
      expect(made.json).toMatchObject({ outcome: 'CREATED' });
    }
    expect(await count("select 1 from machvon.audit_event where action = 'rpt.crosscheck_explained'")).toBe(blocking.length);

    // Step 4: the release is made again and the evidence of the comparison is kept with the copy.
    const issued = await step('rpt-approver', draftId, 3, 'issue');
    assertStatus(issued, 200);
    expect(issued.json).toMatchObject({ status: 'ISSUED' });
    const evidence = await world.rows<{ outcome: string; blocking_explained: number }>('select outcome, blocking_explained from machvon.report_crosscheck_release where draft_id = $1', [draftId]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ outcome: 'EXPLAINED' });
  });

  it('UAT-RPT-SIG-01 an issued copy for the Ministry of Finance is signed through the signing gate of DOC and its period is locked, the lock is read, and it is released only with its own right, a reason of enough words and a second person, and the release is audited', async () => {
    const authority = await MockCertificateAuthority.createRoot({ commonName: 'UAT Root CA', notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2040-01-01T00:00:00Z') });
    const identity = await authority.issue({ commonName: 'UAT Signer', notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2040-01-01T00:00:00Z') });
    const signer = new MockSigningPort({ identity, clock: () => new Date() });
    // The gate of DOC answers for a certification authority that is not configured here; the documented port is given a provider that signs with the test identity, and it is a provider that counts for delivery.
    const gate = world.get<SigningPort>(DOC_SIGNING_PORT);
    const innerOf = (ref: SessionRef): SessionRef => ({ ...ref, provider: 'MOCK' });
    const start = jest.spyOn(gate, 'startSession').mockImplementation(async (request) => ({ ...(await signer.startSession(request)), provider: 'REMOTE_CA' }));
    const collect = jest.spyOn(gate, 'collect').mockImplementation((ref) => signer.collect(innerOf(ref)));
    const cancel = jest.spyOn(gate, 'cancel').mockImplementation((ref) => signer.cancel(innerOf(ref)));
    try {
      const digest = createHash('sha256').update(`XLSX:${randomUUID()}`).digest('hex');
      const issueId = randomUUID();
      const certificateId = randomUUID();
      await world.seedAsAdmin([
        [
          `insert into machvon.report_issue (tenant_id, id, layout_id, layout_code, layout_version, period_code, period, revision, draft_id, sha256, xlsx_sha256, xlsx_name, data_source, form_status, counts_as_accepted, prepared_by, checked_by, approved_by, issued_by)
           values ($1, $2, $3, 'MOF-DIS-MONTHLY', '2026.0', 'MONTH:2027-02', '{"kind":"MONTH","year":2027,"index":2}'::jsonb, 1, $4, $5, $5, 'a.xlsx', 'LIVE', 'READY', true, $6, $7, $8, $8)`,
          [TENANT_A, issueId, randomUUID(), randomUUID(), digest, world.idOf('rpt-preparer'), world.idOf('rpt-checker'), world.idOf('rpt-signer')],
        ],
        [
          `insert into machvon.signing_certificate (tenant_id, id, kind, holder_membership_id, organization_unit_id, certificate_serial, issuer_dn, subject_dn, provider_code, valid_from, valid_until, fingerprint_sha256, status, registered_by)
           values ($1::uuid, $2::uuid, 'PERSONAL', $3::uuid, null, '01', 'CN=UAT Root CA', 'CN=UAT Signer', 'MOCK', '2026-01-01', '2040-01-01', $4, 'Active', $3::uuid)`,
          [TENANT_A, certificateId, world.idOf('rpt-signer'), fingerprintOf(new X509Certificate(identity.certificate))],
        ],
      ]);

      // Step 1: the approver of the copy starts the signing session.
      const started = await world.as('rpt-signer', 'POST', `/report-engine/issues/${issueId}/signature`, { body: { certificate_id: certificateId } });
      assertStatus(started, 200);
      const sessionId = started.json.resource_id as string;
      expect(await count("select 1 from machvon.report_period_lock where issue_id = $1", [issueId])).toBe(0);
      // The signer approves on their device; the session is then completed.
      const [session] = await world.rows<{ provider_session_ref: string }>('select provider_session_ref from machvon.report_signature_session where id = $1', [sessionId]);
      signer.approve({ provider: 'MOCK', sessionId: session?.provider_session_ref as string, expiresAt: new Date(Date.now() + 600_000) });
      const completed = await world.as('rpt-signer', 'POST', `/report-engine/signature-sessions/${sessionId}/completion`);
      assertStatus(completed, 200);
      expect(completed.json).toMatchObject({ status: 'SIGNED' });

      // Step 3: the period is locked after the signing, and the copy shows its signature and the lock.
      const locks = await world.as('rpt-reader', 'GET', '/report-engine/period-locks?open_only=true');
      assertStatus(locks, 200);
      const lock = (locks.json.items as Array<{ id: string; layout_code: string; period_code: string; issue_id: string; version: number }>).find((item) => item.issue_id === issueId);
      expect(lock).toMatchObject({ layout_code: 'MOF-DIS-MONTHLY', period_code: 'MONTH:2027-02' });
      const shown = await world.as('rpt-reader', 'GET', `/report-engine/issues/${issueId}/signature`);
      expect(shown.json).toMatchObject({ signed: true, signature: { counts_for_delivery: true }, period_lock: { id: lock?.id } });
      expect((await world.audits(issueId, 'rpt.signature_completed'))[0]?.actor_id).toBe(world.idOf('rpt-signer'));
      expect(await count("select 1 from machvon.audit_event where action = 'rpt.period_locked' and resource_id = $1", [lock?.id])).toBe(1);

      // Step 4: the lock is released with its own right (a reader is refused), with a reason of enough words (a short one is 422), and by somebody other than the signer (403 SELF_APPROVAL_DENIED).
      const unlock = (persona: string, words: string): Promise<Reply> => world.as(persona, 'POST', `/report-engine/period-locks/${String(lock?.id)}/unlock`, { ifMatch: lock?.version as number, body: { reason: words } });
      const enough = 'The Ministry asked for a correction of the figures';
      assertStatus(await unlock('rpt-reader', enough), 403);
      assertStatus(await unlock('rpt-unlocker', 'too short'), 422, 'VALIDATION_FAILED');
      assertStatus(await unlock('rpt-signer', enough), 403, 'SELF_APPROVAL_DENIED');
      expect(await count("select 1 from machvon.report_period_lock where id = $1 and unlocked_at is null", [lock?.id])).toBe(1);
      const released = await unlock('rpt-unlocker', enough);
      assertStatus(released, 200);
      expect(released.json).toMatchObject({ status: 'UNLOCKED' });
      expect((await world.audits(lock?.id as string, 'rpt.period_unlocked'))[0]).toMatchObject({ actor_id: world.idOf('rpt-unlocker'), reason: enough });
      expect((await world.as('rpt-reader', 'GET', '/report-engine/period-locks?open_only=true')).json.items as unknown[]).toEqual([]);
    } finally {
      for (const spy of [start, collect, cancel]) spy.mockRestore();
    }
  });

  it('UAT-RPT-PRF-01 the PDF of an issued copy, the heaviest of its files, is served within 20 seconds at the p95 and the list of 500 issued copies within 5 seconds', async () => {
    // The heaviest PDF the product makes: the six forms of the catalogue are issued and the one with the largest PDF is the one measured.
    await approveRule('REPORT_FORM_MODE', { demo_forms: true });
    let heaviest = { issueId: '', size: 0 };
    for (const entry of REPORT_FORM_CATALOGUE) {
      // Another period than the one of the first case, so that none of these is a correction that asks for a reason.
      const draftId = await approvedDraft(entry.code, entry.period === 'QUARTER' ? { kind: 'QUARTER', year: 2026, index: 2 } : { kind: 'MONTH', year: 2026, index: 9 });
      const issued = await step('rpt-approver', draftId, 3, 'issue');
      if (issued.status !== 200) continue;
      const pdf = await world.as('rpt-sender', 'GET', `/report-engine/issues/${String(issued.json.resource_id)}/files/PDF`);
      assertStatus(pdf, 200);
      expect(Buffer.from(pdf.json.content_base64 as string, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-');
      if ((pdf.json.size_bytes as number) > heaviest.size) heaviest = { issueId: issued.json.resource_id as string, size: pdf.json.size_bytes as number };
    }
    expect(heaviest.size).toBeGreaterThan(0);
    const columns = (await world.rows<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'machvon' and table_name = 'report_issue' order by ordinal_position")).map((row) => row.column_name);
    const copied = columns.map((column) => (column === 'id' || column === 'draft_id' ? 'gen_random_uuid()' : column === 'period_code' ? "'CLONE-' || g" : `i.${column}`));
    // The copy is written 500 times with its own series (period code): one row each, the bytes of the same PDF behind the same hash.
    await world.seedAsAdmin([[`insert into machvon.report_issue (${columns.join(', ')}) select ${copied.join(', ')} from machvon.report_issue i cross join generate_series(1, $2::int) g where i.id = $1`, [heaviest.issueId, 500]]]);
    expect(await count('select 1 from machvon.report_issue')).toBeGreaterThanOrEqual(500);

    const pdfUrl = `/report-engine/issues/${heaviest.issueId}/files/PDF`;
    const file = await measureP95(world, () => world.as('rpt-sender', 'GET', pdfUrl), 20_000);
    assertWithinBudget(file);
    const listed = await world.as('rpt-sender', 'GET', '/report-engine/issues?limit=200');
    assertStatus(listed, 200);
    const list = await measureP95(world, () => world.as('rpt-sender', 'GET', '/report-engine/issues?limit=200'), 5000);
    assertWithinBudget(list);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'TEMPLATE_UNCONFIRMED'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'OTHER' } }, 409, 'REPORT_CROSSCHECK_BLOCKED'));
    expectCheckFails(() => assertWithinBudget({ p95Ms: 21_000, budgetMs: 20_000, failures: 0 }));
  });
});

