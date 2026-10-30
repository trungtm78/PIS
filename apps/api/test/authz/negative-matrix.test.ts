import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DocumentStore, EffectiveAccessStore, InMemoryAuthzCache, SYSTEM_ROLES, TenantDatabase, seedSystemRoles } from '@machvon/db';
import { PERMISSIONS, STEP_UP } from '@machvon/contracts';
import { STEP_UP_WINDOW_MINUTES, decide, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { SystemRole } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, grantId, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { writeOperationsOf } from '../conformance/command-cases';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, loadOpenApi, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { COMMAND_FIXTURES, evaluateGuardDenial, evaluateWrongTenant, negativeCasesFor, operationsOf } from './negative-matrix';
import type { MatrixCase, MatrixRequest, MatrixTargets, Observation } from './negative-matrix';
import { APPROVER_COMMANDS, SEED_APPRAISAL, STEP_UP_REPLAYS, derivedId, evaluateSelfApproval, evaluateStepUpDenial, makerCheckerCasesFor, seedBidPlan, stepUpCasesFor } from './maker-checker';

const SIGNING_KEY = randomBytes(32);
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const MATRIX_COMMANDS: string[] = (JSON.parse(readFileSync(join(__dirname, 'matrix-commands.json'), 'utf8')) as { commands: string[] }).commands;

const ROLE_MEMBER_BASE = 10; // member n = ROLE_MEMBER_BASE + index of the role in SYSTEM_ROLES
const RECIPIENT = 5;
/** A second TENANT_OWNER: the master permissions are held by that role alone, so the checker of a maker-checker case needs a colleague of it. */
const SECOND_OWNER = 6;
const OTHER_TENANT_OWNER = 1;
const CUSTOM_ROLE = 90;
const ONE_GRANT_TO_REVOKE = 900;
const TENANT_A_MARKERS = [unitId(1), unitId(2), unitId(3), memberId(RECIPIENT), grantId(ONE_GRANT_TO_REVOKE), TENANT_A, 'MATRIX_CUSTOM'];

const roleMember = (code: string): number => ROLE_MEMBER_BASE + SYSTEM_ROLES.findIndex((role) => role.code === code);

describe('negative authorization matrix generator', () => {
  const roles: readonly SystemRole[] = SYSTEM_ROLES;

  it('mirrors matrix-commands.json: one fixture per listed command, in the same set', () => {
    expect(Object.keys(COMMAND_FIXTURES).sort()).toEqual([...MATRIX_COMMANDS].sort());
  });

  it('covers every write operation that the real application implements (the list is not hand-kept)', async () => {
    const harness = new AuthzHarness();
    await harness.start();
    try {
      const database = new TenantDatabase(harness.appPool);
      const app = await startTestApp({
        signingKey: SIGNING_KEY,
        imports: [
          AppModule.register({
            database,
            registry: loadErrorRegistry(ERROR_CODES_PATH),
            policy: { database, access: new EffectiveAccessStore(database, new InMemoryAuthzCache()) },
          }),
        ],
      });
      try {
        const writes = new Set(writeOperationsOf(loadOpenApi()).map((operation) => operation.operationId));
        const implementedCommands = [...app.implementedOperations].filter((operationId) => writes.has(operationId)).sort();
        expect(implementedCommands).toEqual([...MATRIX_COMMANDS].sort());
      } finally {
        await app.close();
      }
    } finally {
      await harness.stop();
    }
  }, 180_000);

  it('generates one case per role without the permission, plus a wrong-tenant and a control-plane case, for each command (AC-ST-KERNEL-027-2)', () => {
    const operations = operationsOf(MATRIX_COMMANDS);
    const cases = negativeCasesFor(operations, roles);
    for (const operation of operations) {
      const mine = cases.filter((matrixCase) => matrixCase.operationId === operation.operationId);
      const roleCases = mine.filter((matrixCase) => matrixCase.kind === 'role').map((matrixCase) => matrixCase.roleCode);
      const holders = roles.filter((role) => role.permissions.some((held) => held === operation.permission || (held.endsWith('.*') && operation.permission.startsWith(held.slice(0, -1)))));
      expect(roleCases.sort()).toEqual(
        roles
          .filter((role) => !holders.includes(role))
          .map((role) => role.code)
          .sort(),
      );
      expect(mine.filter((matrixCase) => matrixCase.kind === 'wrong-tenant')).toHaveLength(1);
      expect(mine.filter((matrixCase) => matrixCase.kind === 'control-plane')).toHaveLength(1);
    }
    // TENANT_OWNER holds everything the commands need, so it never appears as a denied role.
    expect(cases.some((matrixCase) => matrixCase.roleCode === 'TENANT_OWNER')).toBe(false);
    expect(new Set(cases.map((matrixCase) => matrixCase.id)).size).toBe(cases.length);
  });

  it('refuses an operation with no permission in the generated table', () => {
    expect(() => operationsOf(['no_such_operation'])).toThrow(/no permission/);
  });

  describe('verdicts (negative controls: a request that gets through turns the matrix red)', () => {
    const refused: Observation = { status: 403, code: 'SCOPE_DENIED', text: '{}', deniedRows: 1, stateChanged: false };

    it('accepts a refusal with its DENIED audit row and an untouched state', () => {
      expect(evaluateGuardDenial(refused)).toEqual([]);
    });

    it('reports a request that the guard let through, with its changed state', () => {
      expect(evaluateGuardDenial({ status: 201, code: undefined, text: '{}', deniedRows: 0, stateChanged: true })).toEqual(['answered 201 instead of 403', 'code undefined instead of SCOPE_DENIED', '0 DENIED audit rows instead of 1', 'tenant state changed']);
    });

    it('reports a refusal with another code, a missing audit row or a changed state each on its own', () => {
      expect(evaluateGuardDenial({ ...refused, code: 'ROLE_ESCALATION_DENIED' })).toHaveLength(1);
      expect(evaluateGuardDenial({ ...refused, deniedRows: 0 })).toHaveLength(1);
      expect(evaluateGuardDenial({ ...refused, stateChanged: true })).toHaveLength(1);
    });

    it('accepts 403 and 404 for a wrong-tenant caller and reports a success, a leak and a change', () => {
      // A command that names no foreign id may succeed in the caller's own tenant, but must not touch or show tenant A.
      expect(evaluateWrongTenant({ ...refused, status: 201, deniedRows: 0 }, ['abc'], false)).toEqual([]);
      expect(evaluateWrongTenant({ ...refused, status: 201, text: 'ABC', deniedRows: 0, stateChanged: true }, ['abc'], false)).toEqual(['body exposes data of another tenant', 'tenant state changed']);
      expect(evaluateWrongTenant({ ...refused, status: 404, deniedRows: 0 }, ['abc'])).toEqual([]);
      expect(evaluateWrongTenant({ status: 200, code: undefined, text: 'Contains ABC', deniedRows: 0, stateChanged: true }, ['abc'])).toEqual(['answered 200 instead of 403 or 404', 'body exposes data of another tenant', 'tenant state changed']);
    });
  });
});

describe('maker-checker and MFA replay cases', () => {
  const NOW = new Date('2026-06-01T10:00:00Z');

  it('derives the step-up commands from the generated STEP_UP table, never from a hand-kept list', () => {
    const cases = stepUpCasesFor(MATRIX_COMMANDS);
    const commands = [...new Set(cases.map((stepUpCase) => stepUpCase.operationId))].sort();
    expect(commands).toEqual(MATRIX_COMMANDS.filter((operationId) => (STEP_UP as Readonly<Record<string, string>>)[operationId] !== undefined).sort());
    expect(commands).toEqual(expect.arrayContaining(['grantRole', 'revokeRoleGrant']));
    expect(cases).toHaveLength(commands.length * STEP_UP_REPLAYS.length);
    expect(new Set(cases.map((stepUpCase) => stepUpCase.id)).size).toBe(cases.length);
  });

  it('offers only claims that the policy refuses: aal1, aal2 without a time, and aal2 older than the 15 minute window', () => {
    const everything: EffectiveAccess = {
      membershipId: memberId(1),
      scopeVersion: 1,
      membershipActive: true,
      grants: [{ roleCode: 'ALL', rank: 99, permissions: [PERMISSIONS.grantRole], scope: { kind: 'TENANT' }, status: 'Active', effectiveFrom: new Date(0), effectiveUntil: null }],
    };
    for (const replay of STEP_UP_REPLAYS) {
      const claims = replay.claims(NOW);
      const decision = decide({
        required: { permission: PERMISSIONS.grantRole, plane: 'tenant', stepUp: 'aal2' },
        principal: {
          audience: 'tenant',
          assurance: claims.aal === 'aal2' ? 'aal2' : 'aal1',
          aal2At: typeof claims.aal2At === 'string' ? new Date(claims.aal2At) : undefined,
          sessionRevoked: false,
          tokenScopeVersion: 1,
        },
        access: everything,
        now: NOW,
      });
      expect({ replay: replay.id, allow: decision.allow }).toEqual({ replay: replay.id, allow: false });
    }
    expect(STEP_UP_REPLAYS.map((replay) => replay.id)).toEqual(['aal1', 'aal2-without-time', 'aal2-just-expired', 'aal2-long-ago']);
    const justExpired = STEP_UP_REPLAYS.find((replay) => replay.id === 'aal2-just-expired')?.claims(NOW);
    expect(NOW.getTime() - new Date(justExpired?.aal2At as string).getTime()).toBe((STEP_UP_WINDOW_MINUTES * 60 + 1) * 1000);
  });

  it('generates one maker-checker case per role that holds the permission of a command with an approver', () => {
    const cases = makerCheckerCasesFor(APPROVER_COMMANDS, SYSTEM_ROLES);
    expect(APPROVER_COMMANDS.map((command) => command.operationId)).toEqual([
      'decideProjectAppraisal',
      'releaseLegalHold',
      'publishSecurityPolicy',
      'publishAvcPolicy',
      'decideDoaMatrix',
      'decideMasterChangeRequest',
      'post_master_records_id_publish',
      'decideMasterImport',
      'publishMasterImport',
      'decideGlossaryTerm',
      'publishGlossaryTerm',
      'publishDocumentTemplate',
      'confirmDocumentTemplateLegalBasis',
      'verifyContractor',
      'verifyGuarantee',
      'releaseGuarantee',
      'decideAppropriation',
      'decideAllocationExtension',
      'reopenFiscalYear',
      'decideCapitalPlan',
      'post_plans_id_publish',
      'decidePeriodReopen',
      'publishMneForm',
      'publishMneObligationRule',
      'publishRetentionPolicy',
      'decideProcurementPlan',
      'approveCriteriaVersion',
      'grantPermitGateWaiver',
      'approveQualityRuleVersion',
    ]);
    for (const command of APPROVER_COMMANDS) expect(MATRIX_COMMANDS).toContain(command.operationId);
    expect(cases.map((makerCase) => makerCase.roleCode).sort()).toEqual([
      'SECURITY_ADMIN',
      'SECURITY_ADMIN',
      'TENANT_ADMIN',
      'TENANT_ADMIN',
      'TENANT_ADMIN',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
      'TENANT_OWNER',
    ]);
    expect(new Set(cases.map((makerCase) => makerCase.id)).size).toBe(cases.length);
  });

  describe('verdicts (negative controls)', () => {
    const refused: Observation = { status: 403, code: 'MFA_REQUIRED', text: '{}', deniedRows: 1, stateChanged: false };

    it('accepts a step-up refusal and reports a command that went through, a wrong code, no audit row and a changed state', () => {
      expect(evaluateStepUpDenial(refused)).toEqual([]);
      expect(evaluateStepUpDenial({ status: 201, code: undefined, text: '{}', deniedRows: 0, stateChanged: true })).toEqual(['answered 201 instead of 403', 'code undefined instead of MFA_REQUIRED', '0 DENIED audit rows instead of 1', 'tenant state changed']);
      expect(evaluateStepUpDenial({ ...refused, code: 'SCOPE_DENIED' })).toHaveLength(1);
    });

    it('accepts a self-approval refusal that changed nothing and reports an approval that went through', () => {
      const selfApproval: Observation = { status: 403, code: 'SELF_APPROVAL_DENIED', text: '{}', deniedRows: 0, stateChanged: false };
      expect(evaluateSelfApproval(selfApproval)).toEqual([]);
      expect(evaluateSelfApproval({ status: 200, code: undefined, text: '{}', deniedRows: 0, stateChanged: true })).toEqual(['answered 200 instead of 403', 'code undefined instead of SELF_APPROVAL_DENIED', 'tenant state changed']);
      expect(evaluateSelfApproval({ ...selfApproval, code: 'SCOPE_DENIED' })).toHaveLength(1);
    });
  });
});

interface Reply {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

describe('negative authorization matrix against the real application (ST-IAM-004 TK-5)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let targets: MatrixTargets;
  let admin: Client;

  // Only tenant A is fingerprinted: every case must leave it untouched, whoever the caller is.
  const FINGERPRINT = `select md5(concat_ws('|',
    (select string_agg(id::text || path || version::text, ',' order by id) from machvon.organization_unit where tenant_id = $1),
    (select string_agg(id::text || version::text || permissions::text, ',' order by id) from machvon.role_definition where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.role_grant where tenant_id = $1),
    (select string_agg(id::text || scope_version::text, ',' order by id) from machvon.membership where tenant_id = $1),
    (select string_agg(id::text || status || version::text || coalesce(read_at::text, '') || coalesce(acknowledged_at::text, ''), ',' order by id) from machvon.notification_instance where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.legal_hold where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.signing_certificate where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.security_policy_version where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.work_calendar_version where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.doa_matrix_version where tenant_id = $1),
    (select count(*)::text from machvon.doa_rule where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.data_retention_policy where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.integration_connector where tenant_id = $1),
    (select string_agg(id::text || status || version::text || attempts::text, ',' order by id) from machvon.integration_event_inbox where tenant_id = $1),
    (select string_agg(id::text || status || version::text || last_number::text, ',' order by id) from machvon.document_number_register where tenant_id = $1),
    (select count(*)::text from machvon.document where tenant_id = $1),
    (select string_agg(id::text || version::text || coalesce(effective_until::text, ''), ',' order by id) from machvon.doc_type where tenant_id = $1),
    (select string_agg(id::text || status || version::text || coalesce(current_version_id::text, ''), ',' order by id) from machvon.master_record where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.master_record_version where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.master_change_request where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.master_import_batch where tenant_id = $1),
    (select string_agg(id::text || status || confirmation_status || version::text || coalesce(effective_until::text, ''), ',' order by id) from machvon.document_template where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.reporting_period where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.procurement_petition where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.inspection where tenant_id = $1),
    (select string_agg(id::text || status || version::text || accepted_amount_vnd::text, ',' order by id) from machvon.acceptance where tenant_id = $1),
    (select string_agg(id::text || active::text || amount_vnd::text, ',' order by id) from machvon.acceptance_line where tenant_id = $1),
    (select string_agg(id::text || status || version::text || gross_vnd::text || net_vnd::text, ',' order by id) from machvon.payment_request where tenant_id = $1),
    (select count(*)::text from machvon.payment_document where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.quality_acceptance where tenant_id = $1),
    (select count(*)::text from machvon.qms_signature where tenant_id = $1),
    (select string_agg(id::text || status || version::text || coalesce(content_hash, ''), ',' order by id) from machvon.site_diary where tenant_id = $1),
    (select string_agg(id::text, ',' order by id) from machvon.site_photo where tenant_id = $1),
    (select string_agg(id::text || status || version::text || coalesce(register_id::text, ''), ',' order by id) from machvon.incoming_document where tenant_id = $1),
    (select count(*)::text from machvon.document_number_allocation where tenant_id = $1),
    (select string_agg(id::text || status || version::text || coalesce(assignee_user_id::text, ''), ',' order by id) from machvon.quality_incident where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.quality_exception where tenant_id = $1),
    (select count(*)::text from machvon.quality_incident_event where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.dataset_source_mapping where tenant_id = $1),
    (select count(*)::text from machvon.reconciliation_run where tenant_id = $1),
    (select count(*)::text from machvon.dataset_batch_gate where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.workflow_version where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.workflow_instance where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.approval_task where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.delegation_grant where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.unit_reorganization where tenant_id = $1),
    (select count(*)::text from machvon.organization_unit_succession where tenant_id = $1),
    (select string_agg(id::text || coalesce(revoked_at::text, ''), ',' order by id) from machvon.user_session where tenant_id = $1),
    (select string_agg(id::text || coalesce(revoked_at::text, '') || coalesce(push_secret_ref, ''), ',' order by id) from machvon.device_registration where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.dossier where tenant_id = $1),
    (select count(*)::text from machvon.dossier_item where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.mne_report_form where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.mne_obligation_rule where tenant_id = $1),
    (select count(*)::text from machvon.mne_report where tenant_id = $1),
    (select string_agg(id::text || status || version::text || contract_value_vnd::text, ',' order by id) from machvon.contract where tenant_id = $1),
    (select count(*)::text from machvon.contract_party where tenant_id = $1),
    (select string_agg(id::text || status || version::text || coalesce(evaluated_delta_vnd::text, ''), ',' order by id) from machvon.change_request where tenant_id = $1),
    (select string_agg(id::text || tier_count::text || version::text || coalesce(locked_at::text, ''), ',' order by id) from machvon.change_chain_config where tenant_id = $1),
    (select string_agg(id::text || status || version::text || quantity_period::text, ',' order by id) from machvon.measurement where tenant_id = $1),
    (select count(*)::text from machvon.outbox_event where tenant_id = $1),
    (select count(*)::text from machvon.audit_event where tenant_id = $1 and outcome <> 'DENIED'))) as fingerprint`;

  const fingerprint = async (): Promise<string> => (await admin.query<{ fingerprint: string }>(FINGERPRINT, [TENANT_A])).rows[0]?.fingerprint ?? '';
  const deniedRows = async (operationId: string, member: string): Promise<number> => Number((await admin.query<{ n: string }>("select count(*) as n from machvon.audit_event where action = $1 and outcome = 'DENIED' and actor_id = $2", [`authz.denied:${operationId}`, member])).rows[0]?.n);

  async function send(request: MatrixRequest, caller: { tenantId: string; member: number; claims: Record<string, unknown> }): Promise<Reply> {
    const token = signTenantContext(contextFor(caller.tenantId, memberId(caller.member)), SIGNING_KEY);
    const headers: Record<string, string> = {
      [TENANT_HEADER]: token,
      [CLAIMS_HEADER]: JSON.stringify(caller.claims),
      'content-type': 'application/json',
      'idempotency-key': `key-${randomUUID()}`,
    };
    if (request.ifMatch !== undefined) headers['if-match'] = request.ifMatch;
    const response = await fetch(`${app.baseUrl}${request.path}`, { method: request.method, headers, body: JSON.stringify(request.body) });
    const text = await response.text();
    return { status: response.status, json: JSON.parse(text) as Record<string, unknown>, text };
  }

  const aal2 = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ aal: 'aal2', aal2At: new Date().toISOString(), ...extra });

  async function observe(matrixCase: MatrixCase): Promise<Observation> {
    const fixture = COMMAND_FIXTURES[matrixCase.operationId];
    if (fixture === undefined) throw new Error(`no fixture for ${matrixCase.operationId}`);
    const request = fixture.build(targets);
    const caller =
      matrixCase.kind === 'wrong-tenant'
        ? { tenantId: TENANT_B, member: OTHER_TENANT_OWNER, claims: aal2() }
        : matrixCase.kind === 'control-plane'
          ? { tenantId: TENANT_A, member: roleMember('TENANT_OWNER'), claims: aal2({ aud: 'control' }) }
          : { tenantId: TENANT_A, member: roleMember(matrixCase.roleCode ?? ''), claims: aal2() };
    const actor = memberId(caller.member);
    const stateBefore = await fingerprint();
    const deniedBefore = await deniedRows(matrixCase.operationId, actor);
    const reply = await send(request, caller);
    return {
      status: reply.status,
      code: reply.json.code,
      text: reply.text,
      deniedRows: (await deniedRows(matrixCase.operationId, actor)) - deniedBefore,
      stateChanged: (await fingerprint()) !== stateBefore,
    };
  }

  const roleId = async (tenant: string, code: string): Promise<string> => (await admin.query<{ id: string }>('select id from machvon.role_definition where tenant_id = $1 and code = $2', [tenant, code])).rows[0]?.id ?? '';

  const giveSystemRole = (tenant: string, member: number, grantN: number, roleUuid: string): Promise<unknown> =>
    harness.owner(tenant, [
      [
        `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
         values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'matrix')`,
        [tenant, grantId(grantN), memberId(member), roleUuid, ACTOR],
      ],
    ]);

  /** An Active contract of a contractor in tenant A, owned by a project of unit 2 (foreign keys to unrelated modules are off for the seeding). */
  async function seedContract(contractorId: string, contractId: string): Promise<void> {
    const seeder = new Client({ connectionString: harness.database.adminUrl });
    await seeder.connect();
    try {
      await seeder.query('set session_replication_role = replica');
      await seeder.query(
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
         values ($1, $2, '0100000077', 'Matrix Builders', 'VERIFIED', $3)`,
        [TENANT_A, contractorId, id(0x77, 3)],
      );
      await seeder.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version)
         values ($1, $2, 'MX-P', 'Matrix project', $3, $4, 'INTERNAL', 1000, 'CONCEPT', 1)`,
        [TENANT_A, id(0x77, 4), unitId(2), id(0x77, 5)],
      );
      await seeder.query(
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from, completion_due)
         values ($1, $2, $3, $4, $5, 'MX-C', 'LUMP_SUM', 'VND', 'ACTIVE', 1, 1000, date '2026-01-01', date '2026-01-01', date '2027-06-30')`,
        [TENANT_A, contractId, id(0x77, 4), id(0x77, 6), contractorId],
      );
    } finally {
      await seeder.end();
    }
  }

  /**
   * What the contract commands act on: the package of the project above awarded to its contractor under an approved capital plan, a second
   * verified contractor, and a DRAFT joint-venture contract of value 1000 with its first revision (foreign keys to unrelated modules are off).
   */
  async function seedDraftContract(contractorId: string, draftId: string, memberId_: string): Promise<void> {
    const seeder = new Client({ connectionString: harness.database.adminUrl });
    await seeder.connect();
    try {
      await seeder.query('set session_replication_role = replica');
      const project = id(0x77, 4);
      const pkg = id(0x77, 6);
      const statements: Array<[string, unknown[]]> = [
        [
          `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
           values ($1, $2, '0100000078', 'Matrix Partners', 'VERIFIED', $3)`,
          [TENANT_A, memberId_, id(0x77, 3)],
        ],
        [`update machvon.project set status = 'IMPLEMENTATION', project_group = 'B' where id = $1`, [project]],
        [`insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status) values ($1, $2, $3, 'MX-PKG', 1000, 'OPEN', 1, 'AWARDED')`, [TENANT_A, pkg, project]],
        [
          `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, outcome, status, decision_document_id, submitted_by, approved_by, approved_at, created_by, updated_by)
           values ($1, $2, $3, $4, 1000, 'AWARDED', 'APPROVED', $5, $6, $7, now(), $6, $6)`,
          [TENANT_A, id(0x77, 11), pkg, contractorId, id(0x78, 1), memberId(RECIPIENT), memberId(SECOND_OWNER)],
        ],
        [`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2026, 1, $4, 'APPROVED', now())`, [TENANT_A, id(0x77, 12), project, id(0x78, 1)]],
        [
          `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, is_joint_venture, contract_value_vnd, estimate_ceiling_vnd, created_by)
           values ($1, $2, $3, $4, $5, 'MX-DRAFT', 'LUMP_SUM', 'VND', 'DRAFT', 1, 'Matrix draft', true, 1000, 1000, $6)`,
          [TENANT_A, draftId, project, pkg, contractorId, ACTOR],
        ],
        [
          `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by)
           values ($1, $2, $3, 1, 1000, $4, date '2026-01-01', 'DRAFT', 'BASE', 1, $5)`,
          [TENANT_A, id(0x77, 9), draftId, id(0x78, 2), ACTOR],
        ],
        [
          `insert into machvon.guarantee (tenant_id, id, contract_id, kind, issuer, guarantee_no, amount_vnd, expires_at, verification_status, status, valid_from, document_version_id, created_by, updated_by)
           values ($1, $2, $3, 'PERFORMANCE', 'Matrix bank', 'MX-GUARANTEE', 1000, now() + interval '1 year', 'UNVERIFIED', 'PENDING_VERIFICATION', date '2026-01-01', $4, $5, $5)`,
          [TENANT_A, id(0x77, 13), draftId, id(0x78, 2), ACTOR],
        ],
        [
          `insert into machvon.change_request (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, code, stage, submitted_by, created_by, updated_by)
           values ($1, $2, $3, $4, 0, 0, 'Matrix change event', 'SUBMITTED', 1, 'CE-001', 'EVENT', $5, $5, $5)`,
          [TENANT_A, id(0x77, 14), draftId, id(0x77, 9), memberId(RECIPIENT)],
        ],
        [
          `insert into machvon.measurement
             (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no, submitted_by, submitted_at, created_by, updated_by, version)
           values ($1, $2, $3, $4, $5, $6, $7, 10, 0, 1, 'SUBMITTED', jsonb_build_array(jsonb_build_object('document_version_id', $8::text)), 'MX-MEASUREMENT', $9, now(), $9, $9, 1)`,
          [TENANT_A, id(0x77, 15), draftId, id(0x77, 9), id(0x77, 16), id(0x77, 17), id(0x77, 18), id(0x78, 2), memberId(RECIPIENT)],
        ],
        [
          `insert into machvon.inspection (tenant_id, id, project_id, contract_id, inspection_no, inspection_type, title, requested_by, requested_for, status, created_by, updated_by, version)
           values ($1, $2, $3, $4, 'KT-MX', 'SAFETY', 'Matrix inspection', $5, date '2026-12-31', 'REQUESTED', $5, $5, 1)`,
          [TENANT_A, id(0x77, 19), project, draftId, memberId(RECIPIENT)],
        ],
        [
          `insert into machvon.acceptance (tenant_id, id, contract_id, measurement_ids, document_version_id, signer_refs, status, version, acceptance_no, period_id, accepted_amount_vnd, created_by, updated_by)
           values ($1, $2, $3, jsonb_build_array($4::text), $5, '[]'::jsonb, 'DRAFT', 1, 'NT-MX', $6, 10000, $7, $7)`,
          [TENANT_A, id(0x77, 21), draftId, id(0x77, 15), id(0x78, 2), id(0x77, 18), memberId(RECIPIENT)],
        ],
        [
          `insert into machvon.acceptance_line (tenant_id, id, acceptance_id, measurement_id, boq_item_id, contract_revision_id, quantity, unit_price_snapshot, amount_vnd, active, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, $3, $4, $5, 10, 1000, 10000, false, $6, $6)`,
          [TENANT_A, id(0x77, 21), id(0x77, 15), id(0x77, 17), id(0x77, 9), memberId(RECIPIENT)],
        ],
        [
          `insert into machvon.acceptance (tenant_id, id, contract_id, measurement_ids, document_version_id, signer_refs, status, version, acceptance_no, period_id, accepted_amount_vnd, approved_at, decided_by, decision_reason, submitted_by, submitted_at, created_by, updated_by)
           values ($1, $2, $3, jsonb_build_array($4::text), $5, '[]'::jsonb, 'APPROVED', 3, 'NT-MX-PAY', $6, 10000, now(), $7, 'Checked.', $8, now(), $8, $8)`,
          [TENANT_A, id(0x77, 22), draftId, id(0x77, 15), id(0x78, 2), id(0x77, 18), ACTOR, memberId(RECIPIENT)],
        ],
        [
          `insert into machvon.payment_request (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, request_kind, request_no, claims_acceptance, created_by, updated_by)
           values ($1, $2, $3, $4, $5, 'VND', 0, 0, 0, 0, 0, 'SUBMITTED', 1, 'INTERIM', 'DNTT-MX', true, $6, $6)`,
          [TENANT_A, id(0x77, 23), project, draftId, id(0x77, 22), memberId(RECIPIENT)],
        ],
        [
          `insert into machvon.quality_acceptance (tenant_id, id, project_id, contract_id, inspection_id, record_no, acceptance_scope, document_version_id, status, required_roles, content_hash, created_by, updated_by, version)
           values ($1, $2, $3, $4, $5, 'QA-MX', 'WORK_ITEM', $6, 'DRAFT', '["CONTRACTOR","SUPERVISOR","OWNER"]'::jsonb, repeat('a', 64), $7, $7, 1)`,
          [TENANT_A, id(0x77, 20), project, draftId, id(0x77, 19), id(0x77, 9), memberId(RECIPIENT)],
        ],
        [
          `insert into machvon.site_diary (tenant_id, id, project_id, contract_id, record_date, client_operation_id, content, author_id, version, diary_no, status, created_by, updated_by)
           values ($1, $2, $3, $4, '2026-10-19', $5, '{"summary": "Matrix"}'::jsonb, $6, 1, 'NK-MX-20261019', 'DRAFT', $6, $6)`,
          [TENANT_A, id(0x77, 40), project, draftId, id(0x77, 41), memberId(RECIPIENT)],
        ],
        [
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
           values ($1, $2, 'INCOMING', 'CV', 'Matrix incoming letter', 'INTERNAL', $3, $3)`,
          [TENANT_A, id(0x77, 51), memberId(RECIPIENT)],
        ],
        [
          `insert into machvon.incoming_document (tenant_id, id, document_id, status, channel, received_at, received_by, sender_name, created_by, updated_by)
           values ($1, $2, $3, 'RECEIVED', 'UPLOAD', now(), $4, 'Matrix sender', $4, $4)`,
          [TENANT_A, id(0x77, 50), id(0x77, 51), memberId(RECIPIENT)],
        ],
        [
          `insert into machvon.dossier (tenant_id, id, dossier_code, year, title, organization_unit_id, category_code, created_by, updated_by)
           values ($1, $2, 'DS-MX-SEED', 2026, 'Matrix dossier', $3, 'PROJECT_INVESTMENT', $4, $4)`,
          [TENANT_A, id(0x77, 52), unitId(2), memberId(RECIPIENT)],
        ],
      ];
      for (const [sql, params] of statements) await seeder.query(sql, params);
    } finally {
      await seeder.end();
    }
  }

  beforeAll(async () => {
    await harness.start();
    admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    // Tenant B has units with other ids, so the ids that the fixtures name exist in tenant A only.
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: '/u1/' },
      { n: 2, path: '/u1/u2/', parent: 1 },
      { n: 3, path: '/u1/u3/', parent: 1 },
    ]);
    await harness.seedUnits(TENANT_B, [
      { n: 11, path: '/u11/' },
      { n: 12, path: '/u11/u12/', parent: 11 },
    ]);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.tenants.withTenant(contextFor(tenant, memberId(1)), (tx) => seedSystemRoles(tx, ACTOR));
    }
    await harness.seedMembership(TENANT_B, OTHER_TENANT_OWNER, 11);
    await harness.seedMembership(TENANT_A, RECIPIENT, 1);
    await harness.seedMembership(TENANT_A, SECOND_OWNER, 1);
    for (const [index, role] of SYSTEM_ROLES.entries()) {
      const member = ROLE_MEMBER_BASE + index;
      await harness.seedMembership(TENANT_A, member, 1);
      await giveSystemRole(TENANT_A, member, 100 + index, await roleId(TENANT_A, role.code));
    }
    await giveSystemRole(TENANT_A, SECOND_OWNER, 99, await roleId(TENANT_A, 'TENANT_OWNER'));
    // The wrong-tenant caller is a full TENANT_OWNER of tenant B: only the tenant boundary may stop it.
    await giveSystemRole(TENANT_B, OTHER_TENANT_OWNER, 100, await roleId(TENANT_B, 'TENANT_OWNER'));
    await harness.seedRole(TENANT_A, CUSTOM_ROLE, 'MATRIX_CUSTOM', ['iam.unit.manage'], 10);
    await harness.seedGrants(TENANT_A, [{ n: ONE_GRANT_TO_REVOKE, member: RECIPIENT, role: CUSTOM_ROLE, kind: 'TENANT' }]);
    const notificationId = id(0x70, 1);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'NOTIFICATION', 1, '{}'::jsonb, 'Published', 'NOTIFICATION', 'matrix.notification', $3, repeat('a', 64))`,
        [TENANT_A, id(0x71, 1), ACTOR],
      ],
      [
        `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, display_name, webhook_secret_ref)
         values ($1, $2, 'WHATSAPP', 'matrix-channel-account', 'secret://matrix/fixture-token', 'v1', 'PendingVerification', 'Matrix fixture', 'secret://matrix/fixture-webhook')`,
        [TENANT_A, id(0x7b, 1)],
      ],
      [
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, purpose, lockscreen_safe, content_hash, created_by)
         values ($1, $2, 'matrix.template.fixture', 'EMAIL', 'vi-VN', 1, '{"body":"Hello"}'::jsonb, '{}'::jsonb, 'Draft', 'OPERATIONAL', false, repeat('a', 64), $3)`,
        [TENANT_A, id(0x7f, 1), ACTOR],
      ],
      [
        `insert into machvon.contact (tenant_id, id, display_name, verified_identities, classification, status) values ($1, $2, 'Matrix contact fixture', '[]'::jsonb, 'CITIZEN', 'Unverified')`,
        [TENANT_A, id(0x7f, 3)],
      ],
      [
        `insert into machvon.contact_consent (tenant_id, id, contact_id, membership_id, channel, purpose, status, evidence_reference, effective_at, legal_basis, consent_text_version, capture_method)
         values ($1, $2, $3, null, 'SMS', 'OPERATIONAL', 'Granted', 'matrix-contact-consent', now(), 'CONSENT', 'matrix-1', 'IN_APP')`,
        [TENANT_A, id(0x7f, 5), id(0x7f, 3)],
      ],
      [
        `insert into machvon.contact_identity (tenant_id, id, contact_id, channel, external_id_hash, external_id_masked, status) values ($1, $2, $3, 'PHONE', repeat('b', 64), '+84*******98', 'Pending')`,
        [TENANT_A, id(0x7f, 4), id(0x7f, 3)],
      ],
      [
        `insert into machvon.notification_campaign (tenant_id, id, name, purpose, template_version_id, segment_json, status, created_by)
         values ($1, $2, 'Matrix campaign fixture', 'ANNOUNCEMENT', $3, '{"unit_ids":[],"role_codes":["STAFF"],"include_guests":false}'::jsonb, 'Draft', $4)`,
        [TENANT_A, id(0x7f, 2), id(0x7f, 1), ACTOR],
      ],
      [
        `insert into machvon.notification_instance (tenant_id, id, event_id, workflow_version_id, recipient_id, purpose, dedupe_key, expires_at, status, source_event_type, ack_required)
         values ($1, $2, $3, $4, $5, 'OPERATIONAL', $6, now() + interval '1 day', 'Delivered', 'matrix.notification', true)`,
        [TENANT_A, notificationId, id(0x72, 1), id(0x71, 1), memberId(RECIPIENT), `n1:${'a'.repeat(64)}`],
      ],
      [
        `insert into machvon.contact_consent (tenant_id, id, membership_id, channel, purpose, status, evidence_reference, effective_at, consent_text_version, capture_method)
         values ($1, $2, $3, 'SMS', 'OPERATIONAL', 'Granted', 'matrix-fixture', now(), 'matrix-1', 'IN_APP')`,
        [TENANT_A, id(0x7e, 1), memberId(RECIPIENT)],
      ],
    ]);
    const legalHoldId = id(0x73, 1);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.legal_hold (tenant_id, id, resource_scope, authority_reference, reason, effective_at, hold_kind, status, placed_by, version)
         values ($1, $2, '{"kind":"TENANT","ids":[]}'::jsonb, 'MATRIX-FIXTURE-REF', 'negative matrix fixture hold', '2026-01-01T00:00:00Z', 'AUDIT', 'Active', $3, 1)`,
        [TENANT_A, legalHoldId, memberId(RECIPIENT)],
      ],
    ]);
    const registerId = id(0x74, 1);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.document_number_register (tenant_id, id, register_code, name, direction, organization_unit_id, year, created_by, updated_by)
         values ($1, $2, 'MATRIX-FIXTURE', 'Matrix fixture register', 'OUTGOING', $3, 2026, $4, $4)`,
        [TENANT_A, registerId, unitId(2), ACTOR],
      ],
    ]);
    const documentVersionId = id(0x78, 2);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
         values ($1, $2, 'OUTGOING', 'QD', 'Matrix fixture document', 'INTERNAL', $3, $3)`,
        [TENANT_A, id(0x78, 1), ACTOR],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/matrix/fixture.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, documentVersionId, id(0x78, 1)],
      ],
    ]);
    const contractorId = id(0x77, 1);
    const contractId = id(0x77, 2);
    await seedContract(contractorId, contractId);
    const draftContractId = id(0x77, 8);
    const contractMemberId = id(0x77, 10);
    await seedDraftContract(contractorId, draftContractId, contractMemberId);
    const certificateId = id(0x75, 1);
    const supportGrantId = id(0xa3, 1);
    const policyId = id(0x76, 1);
    const workCalendarId = id(0xa0, 1);
    const doaDraftId = id(0xa1, 1);
    const doaPendingId = id(0xa1, 2);
    const outgoingDocumentId = id(0x78, 3);
    const signingSessionId = id(0x78, 4);
    const distributionId = id(0x78, 5);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.support_access_grant (tenant_id, id, ticket_reference, operator_id, scope_json, expires_at, request_reason, access_mode, status, version)
         values ($1, $2, 'SUP-2026-000001', $3, '{"modules":["PRJ"],"resource_ids":[],"duration_minutes":60}'::jsonb, now() + interval '1 hour', 'Matrix fixture request', 'READ_ONLY', 'Requested', 1)`,
        [TENANT_A, supportGrantId, ACTOR],
      ],
    ]);
    const layoutProfileId = (await harness.tenants.withTenant(contextFor(TENANT_A, memberId(1)), (tx) => new DocumentStore().seedDefaults(tx, ACTOR))).layoutProfileId;
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.signing_certificate (tenant_id, id, kind, organization_unit_id, certificate_serial, issuer_dn, subject_dn, provider_code, valid_from, valid_until, fingerprint_sha256, status, registered_by, version)
         values ($1, $2, 'ORGANIZATION', $3, '0A', 'CN=Matrix CA', 'CN=Matrix unit', 'MATRIX-CA', now() - interval '1 day', now() + interval '1 year', repeat('b', 64), 'Active', $4, 1)`,
        [TENANT_A, certificateId, unitId(2), ACTOR],
      ],
      [
        `insert into machvon.security_policy_version (tenant_id, id, revision, policy_json, status, created_by, version)
         values ($1, $2, 1, '{"mfa_required_roles":[],"session_idle_minutes":30,"session_max_hours":8}'::jsonb, 'Draft', $3, 1)`,
        [TENANT_A, policyId, ACTOR],
      ],
      [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, version)
         values ($1, $2, 'MATRIX-FIXTURE', 2026, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Matrix fixture notice', 'Draft', $3, 1)`,
        [TENANT_A, workCalendarId, ACTOR],
      ],
      [
        `insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version)
         values ($1, $2, 1, 'Draft', date '2026-01-01', 'Matrix fixture regulation', $3, $3, 1), ($1, $4, 2, 'Draft', date '2026-01-01', 'Matrix fixture regulation', $3, $3, 1)`,
        [TENANT_A, doaDraftId, ACTOR, doaPendingId],
      ],
      [
        `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, amount_min_vnd, amount_max_vnd, approver_role_id)
         select $1, gen_random_uuid(), matrix_id, 'MATRIX', $3, 0, null, (select id from machvon.role_definition where code = 'MEMBER')
           from unnest(array[$2::uuid, $4::uuid]) as matrix_id`,
        [TENANT_A, doaDraftId, unitId(2), doaPendingId],
      ],
      ["update machvon.doa_matrix_version set status = 'PendingApproval' where id = $1", [doaPendingId]],
      [
        `insert into machvon.outgoing_document (tenant_id, id, document_id, layout_profile_id, status, drafting_unit_id, drafter_user_id, signer_user_id, created_by, updated_by)
         values ($1, $2, $3, $4, 'SUBMITTED', $5, $6, $6, $6, $6)`,
        [TENANT_A, outgoingDocumentId, id(0x78, 1), layoutProfileId, unitId(2), memberId(RECIPIENT)],
      ],
      [
        `insert into machvon.doc_signing_session (tenant_id, id, outgoing_document_id, role, signer_user_id, signing_certificate_id, adapter_code, adapter_status, status, base_version_id, digest_hex, byte_range, provider_txn_ref, expires_at, created_by, updated_by)
         values ($1, $2, $3, 'LEADER', $4, $5, 'MOCK', 'MOCK', 'AWAITING_SIGNER', $6, repeat('a', 64), '[0,1,2,3]'::jsonb, 'matrix-session', now() + interval '1 day', $4, $4)`,
        [TENANT_A, signingSessionId, outgoingDocumentId, memberId(RECIPIENT), certificateId, documentVersionId],
      ],
      [
        `insert into machvon.document_distribution (tenant_id, id, outgoing_document_id, recipient_kind, recipient_name, channel, status, sent_at, attempts, created_by, updated_by)
         values ($1, $2, $3, 'EXTERNAL_AGENCY', 'Matrix fixture recipient', 'PAPER_HANDOVER', 'SENT', now(), 1, $4, $4)`,
        [TENANT_A, distributionId, outgoingDocumentId, memberId(RECIPIENT)],
      ],
    ]);
    const masterRecordId = id(0x79, 1);
    const masterDraftChangeId = id(0x79, 3);
    const masterReviewChangeId = id(0x79, 5);
    const masterImportId = id(0x79, 10);
    const masterCrosswalkId = id(0x79, 11);
    const integrationCursorId = id(0x79, 12);
    const datasetId = id(0x79, 16);
    const glossaryDraftTermId = id(0x79, 13);
    const glossaryReviewTermId = id(0x79, 14);
    const glossaryApprovedTermId = id(0x79, 15);
    const glossaryOwnerId = memberId(RECIPIENT);
    const glossaryTerm = (termId: string, status: string): [string, unknown[]] => [
      `insert into machvon.glossary_term
         (tenant_id, id, term_code, term_vi, definition, domain, owner_membership_id, revision, status, approved_by, decided_by, decided_at, created_by, updated_by)
       values ($1, $2, $3, 'Thuật ngữ ma trận', 'Định nghĩa của thuật ngữ do ma trận phân quyền tạo ra.', 'MATRIX', $4, 1, $5,
               case $5::text when 'APPROVED' then $6::uuid end, case $5::text when 'APPROVED' then $6::uuid end, case $5::text when 'APPROVED' then now() end, $7, $7)`,
      [TENANT_A, termId, `MATRIX_TERM_${status}`, glossaryOwnerId, status, memberId(SECOND_OWNER), ACTOR],
    ];
    const projectId = id(0x8a, 1);
    const projectAreaVersionId = id(0x8a, 3);
    const appraisalId = id(0x8a, 4);
    const decisionDocumentId = id(0x78, 1);
    const templateId = id(0x7a, 1);
    const impact = '{"counts":{},"total":0,"computed_at":"2026-01-01T00:00:00.000Z"}';
    const masterRecord = (n: number, status: string): [string, unknown[]] => [
      `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
       values ($1, $2, 'TENANT', 'MATRIX', $3, $4, $5, $5)`,
      [TENANT_A, id(0x79, n), `MX-FIXTURE-${n}`, status, ACTOR],
    ];
    // The record and its version point at each other: the version is inserted first, then the record names it.
    const masterCurrent = (recordN: number, versionN: number): [string, unknown[]] => ['update machvon.master_record set current_version_id = $2 where id = $1', [id(0x79, recordN), id(0x79, versionN)]];
    const masterVersion = (n: number, recordN: number, status: string): [string, unknown[]] => [
      `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
       values ($1, $2, $3, 'MATRIX', $4, 1, 'Matrix fixture', '{}', '2026-01-01', $5, 'TENANT', $6, $6)`,
      [TENANT_A, id(0x79, n), id(0x79, recordN), `MX-FIXTURE-${recordN}`, status, ACTOR],
    ];
    const masterChange = (n: number, recordN: number, status: string): [string, unknown[]] => [
      `insert into machvon.master_change_request (tenant_id, id, change_kind, master_type, master_record_id, proposed_json, reason, impact_json, effective_from, status, reviewed_by, decided_at, created_by, updated_by)
       values ($1, $2, 'UPDATE', 'MATRIX', $3, '{"label":"Renamed"}'::jsonb, 'negative matrix fixture', $4::jsonb, '2026-06-01', $5, null, null, $6, $6)`,
      [TENANT_A, id(0x79, n), id(0x79, recordN), impact, status, ACTOR],
    ];
    await harness.owner(TENANT_A, [
      masterRecord(1, 'EFFECTIVE'),
      masterVersion(2, 1, 'EFFECTIVE'),
      masterCurrent(1, 2),
      masterRecord(6, 'EFFECTIVE'),
      masterVersion(7, 6, 'EFFECTIVE'),
      masterCurrent(6, 7),
      masterChange(3, 6, 'DRAFT'),
      masterRecord(8, 'EFFECTIVE'),
      masterVersion(9, 8, 'EFFECTIVE'),
      masterCurrent(8, 9),
      masterChange(5, 8, 'IN_REVIEW'),
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'MX-AREA', 'EFFECTIVE', $3, $3)`, [TENANT_A, id(0x8a, 2), ACTOR]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
         values ($1, $2, $3, 'AREA', 'MX-AREA', 1, 'Matrix area', '{}', '2020-01-01', 'EFFECTIVE', 'TENANT', now(), $4, $4)`,
        [TENANT_A, projectAreaVersionId, id(0x8a, 2), ACTOR],
      ],
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version)
         values ($1, $2, 'MX-PRJ', 'Matrix register project', $3, $4, 'INTERNAL', 1000, 'CONCEPT', 1)`,
        [TENANT_A, projectId, unitId(2), projectAreaVersionId],
      ],
      [SEED_APPRAISAL, [appraisalId, ACTOR, memberId(RECIPIENT)]],
      [
        `insert into machvon.master_import_batch (tenant_id, id, master_type, file_object_key, file_sha256, mapping_json, mode, status, total_rows, error_rows, errors_json, created_by, updated_by)
         values ($1, $2, 'MATRIX', 'tenants/matrix/import/fixture', repeat('c', 64), '{}'::jsonb, 'ATOMIC', 'IN_REVIEW', 0, 0, '[]'::jsonb, $3, $3)`,
        [TENANT_A, masterImportId, ACTOR],
      ],
      [
        `insert into machvon.master_crosswalk (tenant_id, id, master_record_id, source_system, external_type, external_code, valid_from, match_method, status, created_by, updated_by)
         values ($1, $2, $3, 'MATRIX', 'MATRIX_CODE', 'MX-OLD', '2026-01-01', 'MANUAL', 'ACTIVE', $4, $4)`,
        [TENANT_A, masterCrosswalkId, masterRecordId, ACTOR],
      ],
      [
        `insert into machvon.integration_cursor (tenant_id, id, connector_code, source_scope, cursor_json, schema_version, adapter_status, status, last_error_code)
         values ($1, $2, 'MATRIX_FILE', 'DEFAULT', '{}'::jsonb, '1', 'PROPOSED', 'FAILED', 'FILE_REJECTED')`,
        [TENANT_A, integrationCursorId],
      ],
      [
        `insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by)
         values ($1, $2, 'DS-MATRIX', 'Matrix dataset', 'MATRIX', 'one row per matrix case', 'PAY', $3, $3, 'INTERNAL', false, 3600, 'DRAFT', $3, $3)`,
        [TENANT_A, datasetId, glossaryOwnerId],
      ],
      [
        `insert into machvon.document_template (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema,
           legal_basis, watermark_text, origin, content_sha256, effective_from, status, created_by, updated_by)
         values ($1, $2, 'MATRIX-FIXTURE', 1, 'OTHER', 'QD', 'Matrix fixture template', $3, '[{"kind":"paragraph","text":"{{body}}"}]'::jsonb, '{"required":["body"]}'::jsonb,
           'Matrix fixture legal basis', 'Waiting for confirmation', 'TENANT', repeat('d', 64), '2026-01-01', 'DRAFT', $4, $4)`,
        [TENANT_A, templateId, layoutProfileId, ACTOR],
      ],
      glossaryTerm(glossaryDraftTermId, 'DRAFT'),
      glossaryTerm(glossaryReviewTermId, 'IN_REVIEW'),
      glossaryTerm(glossaryApprovedTermId, 'APPROVED'),
    ]);
    const issueCategoryRecordId = id(0x7a, 1);
    const issueCategoryVersionId = id(0x7a, 2);
    const slaPolicyId = id(0x7a, 3);
    const issueId = id(0x7a, 4);
    const issueEscalationId = id(0x7a, 5);
    const permitTypeId = id(0x7b, 1);
    const gateRuleId = id(0x7b, 2);
    const gateWaiverId = id(0x7b, 3);
    const contractorToVerifyId = id(0x7c, 1);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by)
         values ($1, $2, '0100000066', 'Matrix unverified contractor', 'UNVERIFIED', $3, $4, $4)`,
        [TENANT_A, contractorToVerifyId, decisionDocumentId, ACTOR],
      ],
    ]);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
         values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', 'MX-ISSUE-CATEGORY', 'EFFECTIVE', $3, $3)`,
        [TENANT_A, issueCategoryRecordId, ACTOR],
      ],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
         values ($1, $2, $3, 'ISSUE_CATEGORY', 'MX-ISSUE-CATEGORY', 1, 'Matrix issue category', '{}', '2026-01-01', 'EFFECTIVE', 'TENANT', $4, $4)`,
        [TENANT_A, issueCategoryVersionId, issueCategoryRecordId, ACTOR],
      ],
      ['update machvon.master_record set current_version_id = $2 where id = $1', [issueCategoryRecordId, issueCategoryVersionId]],
      [
        `insert into machvon.issue_sla_policy (tenant_id, id, code, revision, category_version_id, category_record_id, severity, calendar_code, response_hours, resolve_hours, valid_from, status, created_by, updated_by)
         values ($1, $2, 'MX-SLA', 1, $3, $4, 'HIGH', 'WORKDAY_VN', 4, 8, '2026-01-01', 'ACTIVE', $5, $5)`,
        [TENANT_A, slaPolicyId, issueCategoryVersionId, issueCategoryRecordId, ACTOR],
      ],
      [
        `insert into machvon.issue (tenant_id, id, code, project_id, category_version_id, severity, title, description, owner_unit_id, sla_policy_id, status, version, reported_by,
                                    opened_at, response_due_at, due_at, created_by, updated_by)
         values ($1, $2, 'VM-2026-000001', $3, $4, 'HIGH', 'Matrix issue', 'Matrix issue description', $5, $6, 'OPEN', 1, $7, now(), now() + interval '4 hours', now() + interval '16 hours', $7, $7)`,
        [TENANT_A, issueId, projectId, issueCategoryVersionId, unitId(2), slaPolicyId, ACTOR],
      ],
      [
        `insert into machvon.issue_escalation (tenant_id, id, issue_id, level, "trigger", target_unit_id, reason, due_at, created_by, updated_by)
         values ($1, $2, $3, 2, 'SLA_AUTO', $4, 'SLA_L2_THRESHOLD_REACHED', now() + interval '8 hours', $5, $5)`,
        [TENANT_A, issueEscalationId, issueId, unitId(2), ACTOR],
      ],
      [
        `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
         values ($1, $2, 'MATRIX_FIXTURE', 'Matrix fixture permit type', 'OTHER', 'Matrix authority', 'Matrix fixture legal basis', '2026-01-01', '{}'::jsonb, 'PUBLISHED', $3, $3)`,
        [TENANT_A, permitTypeId, ACTOR],
      ],
      [
        `insert into machvon.permit_gate_rule (tenant_id, id, gate_code, permit_type_id, requirement, applies_to_rule, legal_basis, effective_from, revision, status, created_by, updated_by)
         values ($1, $2, 'HANDOVER', $3, 'VALID_PERMIT', '{}'::jsonb, 'Matrix fixture gate basis', '2026-01-01', 1, 'PUBLISHED', $4, $4)`,
        [TENANT_A, gateRuleId, permitTypeId, ACTOR],
      ],
      [
        `insert into machvon.permit_gate_waiver (tenant_id, id, project_id, gate_code, permit_type_id, reason, decision_document_version_id, valid_until, approved_by, status, created_by, updated_by)
         values ($1, $2, $3, 'HANDOVER', $4, 'Matrix fixture waiver', $5, current_date + 30, $6, 'ACTIVE', $7, $6)`,
        [TENANT_A, gateWaiverId, projectId, permitTypeId, documentVersionId, '00000000-0000-4000-8000-0000000000f2', ACTOR],
      ],
    ]);
    // The permit dossier of the CONCEPT project of unit 2 and a permit in it that is in appraisal: the permit commands act on them.
    const permitDossierId = id(0x7d, 1);
    const permitId = id(0x7d, 2);
    await harness.owner(TENANT_A, [
      ['insert into machvon.permit_dossier (tenant_id, id, project_id, owner_unit_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5)', [TENANT_A, permitDossierId, projectId, unitId(2), ACTOR]],
      ["insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, status, created_by, updated_by) values ($1, $2, $3, $4, 'IN_APPRAISAL', $5, $5)", [TENANT_A, permitId, permitDossierId, permitTypeId, ACTOR]],
    ]);
    // A land parcel of that project, answered for by unit 2: the notice command acts on it.
    const parcelId = id(0xb2, 1);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.land_parcel (tenant_id, id, project_id, owner_unit_id, parcel_code, land_use_group, area_total_m2, area_affected_m2, status, version, created_by, updated_by)
         values ($1, $2, $3, $4, 'MX-PARCEL', 'AGRICULTURAL', 100, 50, 'SURVEYED', 1, $5, $5)`,
        [TENANT_A, parcelId, projectId, unitId(2), ACTOR],
      ],
    ]);
    // A section of that project: the handover command acts on it.
    const sectionId = id(0xb2, 2);
    await harness.owner(TENANT_A, [[`insert into machvon.land_handover_section (tenant_id, id, project_id, code, name, required_area_m2, status, created_by, updated_by) values ($1, $2, $3, 'MX-SEC', 'Matrix section', 100, 'NOT_READY', $4, $4)`, [TENANT_A, sectionId, projectId, ACTOR]]]);
    // Who answers for that project and a task force of its unit: the assignment commands act on them.
    const accountabilityId = id(0xb3, 1);
    const taskForceId = id(0xb3, 2);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
         values ($1, $2, $3, $4, 'DEPUTY_LEADER', '2026-01-01', 'ACTIVE', $5, $5)`,
        [TENANT_A, accountabilityId, projectId, memberId(RECIPIENT), ACTOR],
      ],
      [
        `insert into machvon.task_force (tenant_id, id, code, name, purpose, lead_membership_id, scope_unit_id, valid_from, status, created_by, updated_by)
         values ($1, $2, 'MX-TF', 'Matrix task force', 'Fixture of the authorization matrix', $3, $4, '2026-01-01', 'ACTIVE', $5, $5)`,
        [TENANT_A, taskForceId, memberId(RECIPIENT), unitId(2), ACTOR],
      ],
    ]);
    const fundSourceRecordId = id(0x8c, 1);
    const fundSourceVersionId = id(0x8c, 2);
    const appropriationId = id(0x8c, 3);
    const capitalPlanId = id(0x8c, 4);
    const allocationLineId = id(0x8c, 5);
    const allocationExtensionId = id(0x8c, 6);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
         values ($1, $2, 'TENANT', 'FUND_SOURCE', 'MX-CAP-FUND', 'EFFECTIVE', $3, $3)`,
        [TENANT_A, fundSourceRecordId, ACTOR],
      ],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
         values ($1, $2, $3, 'FUND_SOURCE', 'MX-CAP-FUND', 1, 'Matrix fund source', '{"category":"NSTW","relation":"ADDITIVE"}', '2020-01-01', 'EFFECTIVE', 'TENANT', now(), $4, $4)`,
        [TENANT_A, fundSourceVersionId, fundSourceRecordId, ACTOR],
      ],
      [
        `insert into machvon.appropriation (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, decision_document_id, issuing_authority, source_year, revision, status, created_by, updated_by)
         values ($1, $2, $3, 2026, 'LOCAL_ADDED', 'LOCAL', 1000, $4, 'Matrix authority', 2026, 1, 'DRAFT', $5, $5)`,
        [TENANT_A, appropriationId, fundSourceVersionId, decisionDocumentId, ACTOR],
      ],
      [
        `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, created_by, updated_by)
         values ($1, $2, 'MX-CAP-PLAN', 'ANNUAL', 2026, 2026, 2026, $3, 1, 'DRAFT', $4, $4)`,
        [TENANT_A, capitalPlanId, unitId(2), ACTOR],
      ],
    ]);
    // Two periods of 2026 whose deadline has passed: one OPEN (it could be soft closed) and one SOFT_CLOSED (it could be locked).
    const periodOpenId = id(0xd5, 1);
    const periodSoftClosedId = id(0xd5, 2);
    const matrixPeriod = (periodId: string, code: string, start: string, end: string, status: string): [string, unknown[]] => [
      `insert into machvon.reporting_period
         (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'DEFAULT', 'WEEK', 2026, $6,
               case $6::text when 'OPEN' then null else $5::date + interval '4 hours' end, $7, $8, $8)`,
      [TENANT_A, periodId, code, start, end, status, id(0x79, 2), ACTOR],
    ];
    await harness.owner(TENANT_A, [matrixPeriod(periodOpenId, 'MX-W2026-01', '2026-01-03', '2026-01-09', 'OPEN'), matrixPeriod(periodSoftClosedId, 'MX-W2026-02', '2026-01-10', '2026-01-16', 'SOFT_CLOSED')]);
    // A locked period, and a request to reopen it made by someone other than the callers: the reopening commands act on them.
    const periodLockedId = id(0xd5, 3);
    const reopenRequestId = id(0xd5, 4);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.reporting_period
           (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, locked_at, locked_by, calendar_version_id, created_by, updated_by)
         values ($1, $2, 'MX-W2026-03', 1, date '2026-01-17', date '2026-01-23', date '2026-01-23' + interval '3 hours', 'DEFAULT', 'WEEK', 2026, 'LOCKED',
                 date '2026-01-23' + interval '4 hours', date '2026-01-23' + interval '5 hours', $4, $3, $4, $4)`,
        [TENANT_A, periodLockedId, id(0x79, 2), ACTOR],
      ],
      [
        `insert into machvon.period_reopen (tenant_id, id, period_id, scope_kind, reason, requested_by, requested_window_hours, status, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD', 'Matrix fixture request to reopen the period', $4, 24, 'REQUESTED', $4, $4)`,
        [TENANT_A, reopenRequestId, periodLockedId, ACTOR],
      ],
    ]);
    // A DRAFT report form and a DRAFT obligation rule of it, made by someone other than the callers: the MNE commands act on them.
    const mneFormId = id(0xd6, 1);
    const mneRuleId = id(0xd6, 2);
    const mneReportId = id(0xd6, 4);
    const mnePackageId = id(0xd6, 5);
    await harness.owner(TENANT_A, [
      // The DOC template that the forms above name, published by the platform pack: a form is published only while its template is in force.
      [
        `insert into machvon.document_template (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema,
           legal_basis, watermark_text, origin, content_sha256, effective_from, status, published_at, created_by, updated_by)
         values ($1, $2, 'MX-TEMPLATE', 1, 'REPORT_MONITORING', 'BC', 'Matrix monitoring template', $3, '[{"kind":"paragraph","text":"{{body}}"}]'::jsonb, '{"required":["body"]}'::jsonb,
           'Matrix legal basis', 'Waiting for confirmation', 'PLATFORM_PACK', repeat('e', 64), '2026-01-01', 'PUBLISHED', now(), $4, $4)`,
        [TENANT_A, id(0xd6, 3), layoutProfileId, ACTOR],
      ],
      [
        `insert into machvon.mne_report_form (tenant_id, id, form_code, title, report_kind, legal_basis, effective_from, schema_json, doc_template_code, export_formats, revision, status, created_by, updated_by)
         values ($1, $2, 'MX-FORM', 'Matrix report form', 'OVERALL_SEMIANNUAL', 'Matrix legal basis', '2026-01-01', '{}'::jsonb, 'MX-TEMPLATE', array['XLSX'], 1, 'DRAFT', $3, $3)`,
        [TENANT_A, mneFormId, ACTOR],
      ],
      [
        `insert into machvon.mne_obligation_rule (tenant_id, id, rule_code, form_id, reporting_role, recipient, frequency, due_rule_json, legal_basis, effective_from, revision, status, created_by, updated_by)
         values ($1, $2, 'MX-RULE', $3, 'INVESTOR', 'Matrix recipient', 'SEMIANNUAL', '{"period":"H1","month":7,"day":10}'::jsonb, 'Matrix legal basis', '2026-01-01', 1, 'DRAFT', $4, $4)`,
        [TENANT_A, mneRuleId, mneFormId, ACTOR],
      ],
      [
        `insert into machvon.mne_report (tenant_id, id, form_id, report_year, period_label, scope_unit_id, due_date, revision, status, payload_json, created_by, updated_by)
         values ($1, $2, $3, 2026, 'H1-2026', $4, date '2026-06-30', 1, 'DRAFT', '{}'::jsonb, $5, $5)`,
        [TENANT_A, mneReportId, mneFormId, unitId(2), ACTOR],
      ],
      [
        `insert into machvon.mne_export_package (tenant_id, id, mne_report_id, target_system, format, object_key, file_sha256, adapter_status, status, created_by, updated_by)
         values ($1, $2, $3, 'NATIONAL_PIM_SYSTEM', 'CSV', $4, repeat('c', 64), 'MISSING', 'GENERATED', $5, $5)`,
        [TENANT_A, mnePackageId, mneReportId, `tenants/${TENANT_A}/report_export/${mnePackageId}`, ACTOR],
      ],
    ]);
    // A DRAFT retention policy version made by someone other than the callers: the publication acts on it.
    const retentionDraftId = id(0xa2, 1);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.data_retention_policy (tenant_id, id, record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from, status, created_by, version)
         values ($1, $2, 'matrix_fixture_dossier', 1, 10, 'FROM_CLOSED', 'Matrix fixture legal basis', 'REVIEW_FOR_DESTRUCTION', date '2026-01-01', 'Draft', $3, 1)`,
        [TENANT_A, retentionDraftId, ACTOR],
      ],
    ]);
    // A draft connector and a failed inbox event: the connector update and the replay act on them.
    const connectorId = id(0xa3, 1);
    const inboxEventId = id(0xa3, 2);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.integration_connector (tenant_id, id, connector_code, adapter_status, mode, config_json, status, version)
         values ($1, $2, 'matrix-fixture', 'PROPOSED', 'FILE_IMPORT', '{}'::jsonb, 'Draft', 1)`,
        [TENANT_A, connectorId],
      ],
      [
        `insert into machvon.integration_event_inbox (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id, attempts, error_code)
         values ($1, $2, 'MATRIX', 'matrix-event-1', repeat('a', 64), 'tenants/matrix/webhook/fixture', now(), 'FAILED', 'k1', 3, 'PROVIDER_DOWN')`,
        [TENANT_A, inboxEventId],
      ],
    ]);
    // A DRAFT procurement plan and one IN_REVIEW of two projects of unit 2, each on a line of capital in a published plan, made by someone other than the callers.
    const bidDraftObject = id(0xb5, 1);
    const bidReviewObject = id(0xb5, 2);
    await harness.owner(TENANT_A, [
      [seedBidPlan(bidDraftObject, ACTOR, 'DRAFT'), []],
      [seedBidPlan(bidReviewObject, ACTOR), []],
    ]);
    // A package of an approved plan in the CONCEPT project of unit 2 and a draft of its criteria: the criteria commands act on them.
    const criteriaPackageId = id(0xb6, 1);
    const criteriaDraftId = id(0xb6, 2);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title)
         values ($1, $2, $3, 'MX-CRIT-PKG', 1000, 'OPEN_BIDDING', 1, 'PLANNED', 'Matrix criteria package')`,
        [TENANT_A, criteriaPackageId, projectId],
      ],
      [
        `insert into machvon.criteria_version (tenant_id, id, package_id, revision, criteria_json, legal_basis, weights_sum, status, created_by, version)
         values ($1, $2, $3, 1, $4::jsonb, 'Matrix legal basis', 100, 'DRAFT', $5, 1)`,
        [TENANT_A, criteriaDraftId, criteriaPackageId, JSON.stringify({ criteria: [{ code: 'MX1', name: 'Matrix criterion', kind: 'SCORED', weight: 100, max_score: 10, threshold: 5, mandatory: false, required_evidence: [] }] }), ACTOR],
      ],
    ]);
    // A declaration of conflict of interest of that package, made by the actor of the seed and waiting for a decision.
    const conflictDeclarationId = id(0xb6, 3);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.bid_conflict_declaration (tenant_id, id, package_id, user_id, has_conflict, relation_text, created_by, updated_by)
         values ($1, $2, $3, $4, true, 'Matrix relation', $4, $4)`,
        [TENANT_A, conflictDeclarationId, criteriaPackageId, ACTOR],
      ],
    ]);
    // A SUBMITTED result of that package, submitted by the actor of the seed: the decision command acts on it.
    const resultId = id(0xb6, 4);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.procurement_result (tenant_id, id, package_id, outcome, status, submitted_by, evaluation_minutes_document_id, created_by, updated_by)
         values ($1, $2, $3, 'CANCELLED', 'SUBMITTED', $4, $5, $4, $4)`,
        [TENANT_A, resultId, criteriaPackageId, ACTOR, id(0x78, 1)],
      ],
    ]);
    // A RECEIVED petition of the contractor on that package, logged by the actor of the seed: the resolution command acts on it.
    const petitionId = id(0xb6, 5);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.procurement_petition (tenant_id, id, package_id, contractor_id, petition_kind, received_on, due_on, petition_document_id, status, days_applied, rule_version_id, created_by, updated_by)
         values ($1, $2, $3, $4, 'PROCESS', date '2026-10-20', date '2026-10-27', $5, 'RECEIVED', 7, gen_random_uuid(), $6, $6)`,
        [TENANT_A, petitionId, criteriaPackageId, id(0x77, 1), id(0x78, 1), ACTOR],
      ],
    ]);
    // A dataset of the DIS module with a working contract, a DRAFT quality rule of it made by someone other than the callers, and a frozen snapshot of the open period: the quality commands act on them.
    const qualityDatasetId = id(0xde, 1);
    const qualityContractId = id(0xde, 2);
    const qualityRuleId = id(0xde, 3);
    const qualitySnapshotId = id(0xde, 4);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by)
         values ($1, $2, 'DS-MATRIX-QUALITY', 'Matrix quality dataset', 'MATRIX', 'one row per matrix case', 'DIS', $3, $3, 'INTERNAL', false, 3600, 'DRAFT', $3, $3)`,
        [TENANT_A, qualityDatasetId, glossaryOwnerId],
      ],
      [
        `insert into machvon.dataset_contract (tenant_id, id, dataset_code, revision, owner_id, schema_json, quality_json, freshness_seconds, classification, status, dataset_id)
         values ($1, $2, 'DS-MATRIX-QUALITY', 1, $3, '{}'::jsonb, '{}'::jsonb, 3600, 'INTERNAL', 'DRAFT', $4)`,
        [TENANT_A, qualityContractId, glossaryOwnerId, qualityDatasetId],
      ],
      [
        `insert into machvon.quality_rule_version (tenant_id, id, contract_id, dataset_id, code, revision, expression_ast, severity, threshold_json, status, dimension, field_path, action_on_fail, criticality_weight, created_by)
         values ($1, $2, $3, $4, 'R-MATRIX', 1, '{"op":"not_null","field":"project_id"}'::jsonb, 'MEDIUM', '{"min_pass_rate_pct":"100.000000"}'::jsonb, 'DRAFT', 'COMPLETENESS', 'project_id', 'QUARANTINE', 1, $5)`,
        [TENANT_A, qualityRuleId, qualityContractId, qualityDatasetId, ACTOR],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', now(), current_date, current_date, 'FROZEN', 'v1', 'PROPOSED_PENDING_SIGNOFF', 0, repeat('c', 64), $4, now(), $4, $4)`,
        [TENANT_A, qualitySnapshotId, periodOpenId, ACTOR],
      ],
    ]);
    // An OPEN quality incident and an OPEN quality exception, of a finished run of the quality dataset, made by someone other than the callers.
    const qualityRunId = id(0xde, 5);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.quality_run (tenant_id, id, dataset_contract_id, snapshot_id, rule_version_ids, passed_count, failed_count, quarantined_count, started_at, finished_at, dataset_id, trigger, status, overall_result, score, hard_fail, certified_blocked)
         values ($1, $2, $3, $4, jsonb_build_array($5::text), 1, 0, 0, now(), now(), $6, 'MANUAL', 'COMPLETED', 'FAILED', 70, false, false)`,
        [TENANT_A, qualityRunId, qualityContractId, qualitySnapshotId, qualityRuleId, qualityDatasetId],
      ],
      [
        `insert into machvon.quality_incident (tenant_id, id, rule_id, dataset_version_id, affected_refs, severity, owner_id, status, due_at, title, run_id, sla_hours)
         values ($1, $2, $3, $4, '[]'::jsonb, 'HIGH', $5, 'OPEN', now() + interval '1 day', 'Matrix incident', $6, 24)`,
        [TENANT_A, id(0xde, 6), qualityRuleId, qualitySnapshotId, glossaryOwnerId, qualityRunId],
      ],
      [
        `insert into machvon.quality_exception (tenant_id, id, run_id, record_reference, owner_id, reason, status, evidence, rule_version_id, incident_id)
         values ($1, $2, $3, '{"row_id":"matrix"}'::jsonb, $4, 'Matrix exception', 'OPEN', '{}'::jsonb, $5, $6)`,
        [TENANT_A, id(0xde, 7), qualityRunId, glossaryOwnerId, qualityRuleId, id(0xde, 6)],
      ],
    ]);
    // A PROPOSED mapping of a field of a source into that dataset, proposed by someone other than the callers: the decision command acts on it.
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.dataset_source_mapping (tenant_id, id, dataset_id, source_system, source_field, target_field, unit, status, created_by, updated_by)
         values ($1, $2, $3, 'PAY', 'matrix_field', 'matrix_target', 'VND', 'PROPOSED', $4, $4)`,
        [TENANT_A, id(0xde, 8), qualityDatasetId, glossaryOwnerId],
      ],
    ]);
    // A live session and a live device of someone other than the callers: the sign-out commands act on them.
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.user_session (tenant_id, id, user_account_id, membership_id, idp_session_id, assurance_level, ip_hash, user_agent_summary)
         values ($1, $2, (select user_id from machvon.membership where id = $3), $3, 'matrix-session', 'aal1', repeat('a', 64), 'Matrix browser')`,
        [TENANT_A, id(0xde, 9), glossaryOwnerId],
      ],
      [
        `insert into machvon.device_registration (tenant_id, id, membership_id, device_public_id, push_secret_ref, platform, last_seen_at, token_fingerprint, app_version)
         values ($1, $2, $3, 'matrix-device', 'secret://matrix', 'android', now(), repeat('b', 64), '1.0.0')`,
        [TENANT_A, id(0xde, 10), glossaryOwnerId],
      ],
    ]);
    // A DRAFT workflow definition written by someone other than the callers, and a running instance with a PENDING task given to someone other than the callers.
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, created_by, definition_hash, version)
         values ($1, $2, 'report.accept', 1, '{"steps":[],"terminal":{}}'::jsonb, 'Draft', 'APPROVAL', $3, repeat('a', 64), 1)`,
        [TENANT_A, id(0xde, 11), glossaryOwnerId],
      ],
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, created_by, published_by, published_at, definition_hash, version)
         values ($1, $2, 'report.accept', 2, '{"steps":[],"terminal":{}}'::jsonb, 'Published', 'APPROVAL', $3, $4, now(), repeat('b', 64), 2)`,
        [TENANT_A, id(0xde, 12), glossaryOwnerId, ACTOR],
      ],
      [
        `insert into machvon.workflow_instance (tenant_id, id, workflow_version_id, resource_type, resource_id, resource_version, status, started_at, temporal_workflow_id, initiator_membership_id, initiator_user_id, document_type, unit_id, business_type)
         values ($1, $2, $3, 'report', $4, 1, 'Running', now(), 'appr:matrix', $5, (select user_id from machvon.membership where id = $5), 'REPORT_ACCEPT', $6, 'report.accept')`,
        [TENANT_A, id(0xde, 13), id(0xde, 12), id(0xde, 14), glossaryOwnerId, unitId(2)],
      ],
      [
        `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, step_id, step_index, status)
         values ($1, $2, $3, $4, now() + interval '1 day', 'review', 0, 'Pending')`,
        [TENANT_A, id(0xde, 15), id(0xde, 13), glossaryOwnerId],
      ],
      [
        `insert into machvon.unit_reorganization (tenant_id, id, kind, effective_from, legal_basis_ref, mapping_json, status, requested_by)
         values ($1, $2, 'DISSOLVE', date '2099-01-01', 'Matrix fixture reorganisation', '{"predecessor_unit_ids":[],"successors":[],"mapping":{"memberships":[],"projects":[]}}'::jsonb, 'PendingApproval', $3)`,
        [TENANT_A, id(0xde, 17), glossaryOwnerId],
      ],
      [
        `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, status)
         values ($1, $2, $3, $4, '{approval.decide}', '{"kind":"UNIT_ONLY","ref_ids":[]}'::jsonb, now(), now() + interval '30 days', 'Matrix fixture delegation', 'Active')`,
        [TENANT_A, id(0xde, 16), glossaryOwnerId, memberId(SECOND_OWNER)],
      ],
    ]);
    // A DRAFT availability control policy made by someone other than the callers: the publication of a policy is judged against it.
    const avcPolicyId = id(0xdf, 1);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.avc_policy (tenant_id, id, policy_code, scope_kind, scope_value, control_object, warn_pct, block_pct, legal_basis, effective_from, revision, status, created_by, updated_by, version)
         values ($1, $2, 'MX-FIXTURE', 'FUND_SOURCE', 'MX-FIXTURE', 'ALLOCATION_LINE', 90, 100, 'Matrix fixture basis', date '2026-01-01', 1, 'DRAFT', $3, $3, 1)`,
        [TENANT_A, avcPolicyId, ACTOR],
      ],
    ]);
    targets = {
      avcPolicyId,
      bidPlanProjectId: derivedId(bidDraftObject, 'bid-project'),
      bidPlanLineId: derivedId(bidDraftObject, 'bid-line'),
      bidPlanDraftId: derivedId(bidDraftObject, 'bid-plan'),
      bidPlanInReviewId: derivedId(bidReviewObject, 'bid-plan'),
      criteriaPackageId,
      criteriaDraftId,
      conflictDeclarationId,
      resultId,
      petitionId,
      inspectionId: id(0x77, 19),
      acceptanceId: id(0x77, 20),
      diaryId: id(0x77, 40),
      incomingId: id(0x77, 50),
      qualityIncidentId: id(0xde, 6),
      qualityExceptionId: id(0xde, 7),
      sourceMappingId: id(0xde, 8),
      otherSessionId: id(0xde, 9),
      otherDeviceId: id(0xde, 10),
      workflowDraftId: id(0xde, 11),
      approvalTaskId: id(0xde, 15),
      workflowInstanceId: id(0xde, 13),
      delegationId: id(0xde, 16),
      reorganizationId: id(0xde, 17),
      qualityDatasetId,
      dossierId: id(0x77, 52),
      qualityContractId,
      qualityRuleId,
      qualitySnapshotId,
      accountabilityId,
      taskForceId,
      connectorId,
      inboxEventId,
      retentionDraftId,
      mneFormId,
      mneRuleId,
      mneReportId,
      mnePackageId,
      periodOpenId,
      periodSoftClosedId,
      periodLockedId,
      reopenRequestId,
      fundSourceVersionId,
      appropriationId,
      capitalPlanId,
      allocationLineId,
      allocationExtensionId,
      permitTypeId,
      gateRuleId,
      gateWaiverId,
      permitDossierId,
      permitId,
      parcelId,
      sectionId,
      issueCategoryVersionId,
      slaPolicyId,
      issueId,
      issueEscalationId,
      masterRecordId,
      masterDraftChangeId,
      masterReviewChangeId,
      masterImportId,
      masterCrosswalkId,
      integrationCursorId,
      projectId,
      projectAreaVersionId,
      appraisalId,
      datasetId,
      glossaryOwnerId,
      glossaryDraftTermId,
      glossaryReviewTermId,
      glossaryApprovedTermId,
      decisionDocumentId,
      templateId,
      layoutProfileId,
      notificationId,
      notificationWorkflowId: id(0x71, 1),
      notificationTemplateId: id(0x7f, 1),
      campaignId: id(0x7f, 2),
      contactId: id(0x7f, 3),
      contactIdentityId: id(0x7f, 4),
      contactConsentId: id(0x7f, 5),
      channelAccountId: id(0x7b, 1),
      consentId: id(0x7e, 1),
      legalHoldId,
      registerId,
      documentVersionId,
      certificateId,
      tenantId: TENANT_A,
      supportGrantId,
      policyId,
      workCalendarId,
      doaDraftId,
      doaPendingId,
      outgoingDocumentId,
      signingSessionId,
      distributionId,
      unit2: unitId(2),
      unit3: unitId(3),
      customRoleId: id(0x30, CUSTOM_ROLE),
      memberRoleId: await roleId(TENANT_A, 'MEMBER'),
      guestRoleId: await roleId(TENANT_A, 'GUEST_CONTRACTOR'),
      contractorId,
      contractorToVerifyId,
      contractId,
      contractProjectId: id(0x77, 4),
      contractPackageId: id(0x77, 6),
      draftContractId,
      contractMemberId,
      draftRevisionId: id(0x77, 9),
      guaranteeId: id(0x77, 13),
      changeRequestId: id(0x77, 14),
      measurementId: id(0x77, 15),
      workAcceptanceId: id(0x77, 21),
      paymentRequestId: id(0x77, 23),
      paymentAcceptanceId: id(0x77, 22),
      paymentDocumentVersionId: id(0x78, 2),
      advanceId: id(0x77, 24),
      treasuryTransactionId: id(0x77, 25),
      reconciliationItemId: id(0x77, 26),
      settlementId: id(0x77, 27),
      nonconformanceId: id(0x77, 28),
      correctiveActionId: id(0x77, 29),
      handoverId: id(0x77, 30),
      punchItemId: id(0x77, 31),
      assetId: id(0x77, 32),
      warrantyId: id(0x77, 33),
      retentionHoldId: id(0x77, 34),
      householdId: id(0x77, 35),
      inventoryId: id(0x77, 36),
      planId: id(0x77, 37),
      boqItemId: id(0x77, 17),
      periodId: id(0x77, 18),
      recipientMembershipId: memberId(RECIPIENT),
      grantToRevoke: grantId(ONE_GRANT_TO_REVOKE),
    };
    const database = new TenantDatabase(harness.appPool);
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          policy: { database, access: new EffectiveAccessStore(database, new InMemoryAuthzCache()) },
        }),
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await admin?.end();
    await harness.stop();
  }, 60_000);

  const cases = negativeCasesFor(operationsOf(MATRIX_COMMANDS), SYSTEM_ROLES);

  it.each(MATRIX_COMMANDS)(
    '%s: every generated case is refused and changes nothing',
    async (operationId) => {
      const mine = cases.filter((matrixCase) => matrixCase.operationId === operationId);
      expect(mine.length).toBeGreaterThan(2);
      const failures: string[] = [];
      for (const matrixCase of mine) {
        const observation = await observe(matrixCase);
        const problems = matrixCase.kind === 'wrong-tenant' ? evaluateWrongTenant(observation, TENANT_A_MARKERS, COMMAND_FIXTURES[operationId]?.referencesTenantIds ?? true) : evaluateGuardDenial(observation);
        for (const problem of problems) failures.push(`${matrixCase.id}: ${problem}`);
      }
      expect(failures).toEqual([]);
    },
    300_000,
  );

  const MAKER_BASE = 0x74;

  it.each(stepUpCasesFor(MATRIX_COMMANDS).map((stepUpCase) => [stepUpCase.id, stepUpCase] as const))(
    'MFA replay %s: a caller that holds the permission is refused MFA_REQUIRED and nothing changes (AC-ST-KERNEL-027-3)',
    async (_id, stepUpCase) => {
      const fixture = COMMAND_FIXTURES[stepUpCase.operationId];
      if (fixture === undefined) throw new Error(`no fixture for ${stepUpCase.operationId}`);
      const caller = { tenantId: TENANT_A, member: roleMember('TENANT_OWNER'), claims: stepUpCase.replay.claims(new Date()) };
      const stateBefore = await fingerprint();
      const deniedBefore = await deniedRows(stepUpCase.operationId, memberId(caller.member));
      const reply = await send(fixture.build(targets), caller);
      const observation: Observation = {
        status: reply.status,
        code: reply.json.code,
        text: reply.text,
        deniedRows: (await deniedRows(stepUpCase.operationId, memberId(caller.member))) - deniedBefore,
        stateChanged: (await fingerprint()) !== stateBefore,
      };
      expect(evaluateStepUpDenial(observation)).toEqual([]);
    },
    60_000,
  );

  it('MFA replay: the same grantRole request with a fresh aal2 is accepted (the replays above are refused for the right reason)', async () => {
    const fixture = COMMAND_FIXTURES.grantRole;
    const reply = await send(fixture?.build(targets) as MatrixRequest, { tenantId: TENANT_A, member: roleMember('TENANT_OWNER'), claims: aal2() });
    expect(reply.status).toBe(201);
  });

  const makerCases = makerCheckerCasesFor(APPROVER_COMMANDS, SYSTEM_ROLES);

  it.each(makerCases.map((makerCase) => [makerCase.id, makerCase] as const))(
    'maker-checker %s: the person who made the object cannot approve it, another holder can (AC-ST-KERNEL-027-1)',
    async (_id, makerCase) => {
      const command = APPROVER_COMMANDS.find((candidate) => candidate.operationId === makerCase.operationId);
      if (command === undefined) throw new Error(`no approver command ${makerCase.operationId}`);
      const maker = roleMember(makerCase.roleCode);
      // Another holder of this command's permission: a member of one of its roles, or the second owner (who holds every tenant permission).
      const checker = [...makerCases.filter((other) => other.operationId === makerCase.operationId).map((other) => roleMember(other.roleCode)), SECOND_OWNER].find((member) => member !== maker) ?? -1;
      const objectId = id(MAKER_BASE, maker);
      await harness.owner(TENANT_A, [command.seedMadeBy(objectId, memberId(maker), memberId(checker))]);
      const request = command.build(objectId);

      const stateBefore = await fingerprint();
      const reply = await send(request, { tenantId: TENANT_A, member: maker, claims: aal2() });
      expect(evaluateSelfApproval({ status: reply.status, code: reply.json.code, text: reply.text, deniedRows: 0, stateChanged: (await fingerprint()) !== stateBefore })).toEqual([]);

      const approved = await send(request, { tenantId: TENANT_A, member: checker, claims: aal2() });
      expect(approved.status).toBe(200);
    },
    60_000,
  );

  it('allows the same request for a role that holds the permission (the cases above are refused for the right reason)', async () => {
    const reply = await send(COMMAND_FIXTURES.createOrganizationUnit?.build(targets) as MatrixRequest, {
      tenantId: TENANT_A,
      member: roleMember('TENANT_ADMIN'),
      claims: aal2(),
    });
    expect(reply.status).toBe(201);
  });
});
