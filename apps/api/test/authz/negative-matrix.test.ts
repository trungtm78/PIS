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
import { APPROVER_COMMANDS, STEP_UP_REPLAYS, evaluateSelfApproval, evaluateStepUpDenial, makerCheckerCasesFor, stepUpCasesFor } from './maker-checker';

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
      expect(roleCases.sort()).toEqual(roles.filter((role) => !holders.includes(role)).map((role) => role.code).sort());
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
      expect(evaluateGuardDenial({ status: 201, code: undefined, text: '{}', deniedRows: 0, stateChanged: true })).toEqual([
        'answered 201 instead of 403',
        'code undefined instead of SCOPE_DENIED',
        '0 DENIED audit rows instead of 1',
        'tenant state changed',
      ]);
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
      expect(evaluateWrongTenant({ status: 200, code: undefined, text: 'Contains ABC', deniedRows: 0, stateChanged: true }, ['abc'])).toEqual([
        'answered 200 instead of 403 or 404',
        'body exposes data of another tenant',
        'tenant state changed',
      ]);
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
    expect(APPROVER_COMMANDS.map((command) => command.operationId)).toEqual(['releaseLegalHold', 'publishSecurityPolicy', 'decideMasterChangeRequest', 'post_master_records_id_publish', 'decideMasterImport', 'publishMasterImport']);
    for (const command of APPROVER_COMMANDS) expect(MATRIX_COMMANDS).toContain(command.operationId);
    expect(cases.map((makerCase) => makerCase.roleCode).sort()).toEqual(['SECURITY_ADMIN', 'SECURITY_ADMIN', 'TENANT_ADMIN', 'TENANT_OWNER', 'TENANT_OWNER', 'TENANT_OWNER', 'TENANT_OWNER', 'TENANT_OWNER', 'TENANT_OWNER']);
    expect(new Set(cases.map((makerCase) => makerCase.id)).size).toBe(cases.length);
  });

  describe('verdicts (negative controls)', () => {
    const refused: Observation = { status: 403, code: 'MFA_REQUIRED', text: '{}', deniedRows: 1, stateChanged: false };

    it('accepts a step-up refusal and reports a command that went through, a wrong code, no audit row and a changed state', () => {
      expect(evaluateStepUpDenial(refused)).toEqual([]);
      expect(evaluateStepUpDenial({ status: 201, code: undefined, text: '{}', deniedRows: 0, stateChanged: true })).toEqual([
        'answered 201 instead of 403',
        'code undefined instead of MFA_REQUIRED',
        '0 DENIED audit rows instead of 1',
        'tenant state changed',
      ]);
      expect(evaluateStepUpDenial({ ...refused, code: 'SCOPE_DENIED' })).toHaveLength(1);
    });

    it('accepts a self-approval refusal that changed nothing and reports an approval that went through', () => {
      const selfApproval: Observation = { status: 403, code: 'SELF_APPROVAL_DENIED', text: '{}', deniedRows: 0, stateChanged: false };
      expect(evaluateSelfApproval(selfApproval)).toEqual([]);
      expect(evaluateSelfApproval({ status: 200, code: undefined, text: '{}', deniedRows: 0, stateChanged: true })).toEqual([
        'answered 200 instead of 403',
        'code undefined instead of SELF_APPROVAL_DENIED',
        'tenant state changed',
      ]);
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
    (select string_agg(id::text || status || version::text || last_number::text, ',' order by id) from machvon.document_number_register where tenant_id = $1),
    (select count(*)::text from machvon.document where tenant_id = $1),
    (select string_agg(id::text || version::text || coalesce(effective_until::text, ''), ',' order by id) from machvon.doc_type where tenant_id = $1),
    (select string_agg(id::text || status || version::text || coalesce(current_version_id::text, ''), ',' order by id) from machvon.master_record where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.master_record_version where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.master_change_request where tenant_id = $1),
    (select string_agg(id::text || status || version::text, ',' order by id) from machvon.master_import_batch where tenant_id = $1),
    (select count(*)::text from machvon.outbox_event where tenant_id = $1),
    (select count(*)::text from machvon.audit_event where tenant_id = $1 and outcome <> 'DENIED'))) as fingerprint`;

  const fingerprint = async (): Promise<string> => (await admin.query<{ fingerprint: string }>(FINGERPRINT, [TENANT_A])).rows[0]?.fingerprint ?? '';
  const deniedRows = async (operationId: string, member: string): Promise<number> =>
    Number(
      (
        await admin.query<{ n: string }>("select count(*) as n from machvon.audit_event where action = $1 and outcome = 'DENIED' and actor_id = $2", [
          `authz.denied:${operationId}`,
          member,
        ])
      ).rows[0]?.n,
    );

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

  const roleId = async (tenant: string, code: string): Promise<string> =>
    (await admin.query<{ id: string }>('select id from machvon.role_definition where tenant_id = $1 and code = $2', [tenant, code])).rows[0]?.id ?? '';

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
        `insert into machvon.notification_instance (tenant_id, id, event_id, workflow_version_id, recipient_id, purpose, dedupe_key, expires_at, status, source_event_type, ack_required)
         values ($1, $2, $3, $4, $5, 'OPERATIONAL', $6, now() + interval '1 day', 'Delivered', 'matrix.notification', true)`,
        [TENANT_A, notificationId, id(0x72, 1), id(0x71, 1), memberId(RECIPIENT), `n1:${'a'.repeat(64)}`],
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
    const certificateId = id(0x75, 1);
    const policyId = id(0x76, 1);
    const outgoingDocumentId = id(0x78, 3);
    const signingSessionId = id(0x78, 4);
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
        `insert into machvon.outgoing_document (tenant_id, id, document_id, layout_profile_id, status, drafting_unit_id, drafter_user_id, signer_user_id, created_by, updated_by)
         values ($1, $2, $3, $4, 'SUBMITTED', $5, $6, $6, $6, $6)`,
        [TENANT_A, outgoingDocumentId, id(0x78, 1), layoutProfileId, unitId(2), memberId(RECIPIENT)],
      ],
      [
        `insert into machvon.doc_signing_session (tenant_id, id, outgoing_document_id, role, signer_user_id, signing_certificate_id, adapter_code, adapter_status, status, base_version_id, digest_hex, byte_range, provider_txn_ref, expires_at, created_by, updated_by)
         values ($1, $2, $3, 'LEADER', $4, $5, 'MOCK', 'MOCK', 'AWAITING_SIGNER', $6, repeat('a', 64), '[0,1,2,3]'::jsonb, 'matrix-session', now() + interval '1 day', $4, $4)`,
        [TENANT_A, signingSessionId, outgoingDocumentId, memberId(RECIPIENT), certificateId, documentVersionId],
      ],
    ]);
    const masterRecordId = id(0x79, 1);
    const masterDraftChangeId = id(0x79, 3);
    const masterReviewChangeId = id(0x79, 5);
    const masterImportId = id(0x79, 10);
    const masterCrosswalkId = id(0x79, 11);
    const integrationCursorId = id(0x79, 12);
    const decisionDocumentId = id(0x78, 1);
    const impact = '{"counts":{},"total":0,"computed_at":"2026-01-01T00:00:00.000Z"}';
    const masterRecord = (n: number, status: string): [string, unknown[]] => [
      `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
       values ($1, $2, 'TENANT', 'MATRIX', $3, $4, $5, $5)`,
      [TENANT_A, id(0x79, n), `MX-FIXTURE-${n}`, status, ACTOR],
    ];
    // The record and its version point at each other: the version is inserted first, then the record names it.
    const masterCurrent = (recordN: number, versionN: number): [string, unknown[]] => [
      'update machvon.master_record set current_version_id = $2 where id = $1',
      [id(0x79, recordN), id(0x79, versionN)],
    ];
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
    ]);
    targets = {
      masterRecordId,
      masterDraftChangeId,
      masterReviewChangeId,
      masterImportId,
      masterCrosswalkId,
      integrationCursorId,
      decisionDocumentId,
      notificationId,
      legalHoldId,
      registerId,
      documentVersionId,
      certificateId,
      policyId,
      outgoingDocumentId,
      signingSessionId,
      unit2: unitId(2),
      unit3: unitId(3),
      customRoleId: id(0x30, CUSTOM_ROLE),
      memberRoleId: await roleId(TENANT_A, 'MEMBER'),
      guestRoleId: await roleId(TENANT_A, 'GUEST_CONTRACTOR'),
      contractorId,
      contractId,
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

  it.each(MATRIX_COMMANDS)('%s: every generated case is refused and changes nothing', async (operationId) => {
    const mine = cases.filter((matrixCase) => matrixCase.operationId === operationId);
    expect(mine.length).toBeGreaterThan(2);
    const failures: string[] = [];
    for (const matrixCase of mine) {
      const observation = await observe(matrixCase);
      const problems = matrixCase.kind === 'wrong-tenant' ? evaluateWrongTenant(observation, TENANT_A_MARKERS, COMMAND_FIXTURES[operationId]?.referencesTenantIds ?? true) : evaluateGuardDenial(observation);
      for (const problem of problems) failures.push(`${matrixCase.id}: ${problem}`);
    }
    expect(failures).toEqual([]);
  }, 300_000);

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
      await harness.owner(TENANT_A, [command.seedMadeBy(objectId, memberId(maker))]);
      const request = command.build(objectId);

      const stateBefore = await fingerprint();
      const reply = await send(request, { tenantId: TENANT_A, member: maker, claims: aal2() });
      expect(
        evaluateSelfApproval({ status: reply.status, code: reply.json.code, text: reply.text, deniedRows: 0, stateChanged: (await fingerprint()) !== stateBefore }),
      ).toEqual([]);

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
