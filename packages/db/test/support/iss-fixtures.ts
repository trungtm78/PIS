import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { IssSlaDeadlines } from '../../src/iss-sla-deadline';
import { IssIssueStore, issueScope } from '../../src/iss-issue-store';
import type { CreatedIssue, IssueScopes, NewIssue } from '../../src/iss-issue-store';
import { IssSlaPolicyStore } from '../../src/iss-sla-policy-store';
import type { TenantTx } from '../../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './authz-fixtures';

/** The people of the issue worlds, by the number `memberId` turns into a membership id. */
export const PEOPLE = {
  REPORTER: 1,
  ASSIGNER: 2,
  WORKER_U1: 3,
  WORKER_U2: 4,
  NO_GRANT: 5,
  SUSPENDED: 6,
  WORKER_ALL: 7,
  GUEST: 8,
  VERIFIER: 9,
  EXTENDER: 10,
  UNIT_HEAD: 11,
  TF_MEMBER: 12,
  TF_LEAD: 13,
  OUTSIDER: 14,
  SYSTEM: 15,
} as const;

export const FAMILY = 0x7d;
export const PROJECT = id(FAMILY, 1);
export const PROJECT_OTHER = id(FAMILY, 2);
export const CONTRACT = id(FAMILY, 3);
export const CONTRACT_OTHER_PROJECT = id(FAMILY, 4);
export const DOCUMENT_CLEAN = id(FAMILY, 5);
export const DOCUMENT_PENDING = id(FAMILY, 6);
export const FOREIGN_PROJECT = id(FAMILY, 7);
export const CONTRACTOR = id(FAMILY, 8);
export const UNIT_1 = unitId(1);
export const UNIT_2 = unitId(2);
export const UNIT_3 = unitId(3);
/** Monday 10 August 2026, 09:00 in Vietnam: inside the window of the SLA (07:30 to 17:00). */
export const NOW = new Date('2026-08-10T02:00:00Z');

/** A world of issues on a migrated database: units, people, projects, documents, the working calendar and the clients of the stores. */
export class IssWorld {
  readonly harness = new AuthzHarness();
  readonly policies = new IssSlaPolicyStore({ today: () => '2026-08-01' });
  readonly deadlines = new IssSlaDeadlines(this.policies);
  readonly issues = new IssIssueStore(this.deadlines);
  category = '';
  private counter = 0;

  as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member: number = PEOPLE.REPORTER): Promise<T> => this.harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);

  owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => this.harness.owner<R>(tenant, [[sql, params]]);

  /** The error a command raised: its code, status and the field it names. */
  async refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
    try {
      await work;
    } catch (error) {
      const e = error as { code?: string; status?: number; detail?: string };
      return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
    }
    throw new Error('expected a refusal');
  }

  /** What the database said when it refused a statement. */
  async sqlRefusal(work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> {
    try {
      await work;
    } catch (error) {
      const e = error as { code?: string; message: string };
      return { sqlstate: e.code ?? '', message: e.message };
    }
    throw new Error('expected the database to refuse');
  }

  accessOf(permissions: readonly string[], scope: Scope, member: number = PEOPLE.REPORTER): EffectiveAccess {
    return {
      membershipId: memberId(member),
      scopeVersion: 1,
      membershipActive: true,
      grants: [{ roleCode: 'TEST', rank: 10, permissions, scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
    };
  }

  subtree = (n: number): Scope => ({ kind: 'UNIT_SUBTREE', refIds: [unitId(n)], paths: [`/u${n}/`] });
  tenantWide: Scope = { kind: 'TENANT' };

  /** The scopes of a command for a caller whose grant carries the permission over `scope`. */
  scopesOf(permission: string, scope: Scope, member: number = PEOPLE.REPORTER, reporter = false, at: Date = NOW): IssueScopes {
    const access = this.accessOf([permission, 'issue.read'], scope, member);
    const options = reporter ? { reporter: memberId(member) } : {};
    return { act: issueScope(access, permission, at, options), read: issueScope(access, 'issue.read', at, options) };
  }

  everything = (permission: string, member: number = PEOPLE.REPORTER): IssueScopes => this.scopesOf(permission, this.tenantWide, member);

  request(extra: Partial<NewIssue> = {}): NewIssue {
    this.counter += 1;
    return {
      projectId: PROJECT,
      categoryVersionId: this.category,
      severity: 'HIGH',
      title: `Land handover is blocked ${this.counter}`,
      description: 'The handover of plot 12 is blocked by an unresolved compensation',
      ownerUnitId: UNIT_1,
      clientOperationId: randomUUID(),
      ...extra,
    };
  }

  open(data: NewIssue = this.request(), at: Date = NOW, member: number = PEOPLE.REPORTER, tenant = TENANT_A): Promise<CreatedIssue> {
    return this.as((tx) => this.issues.create(tx, data, memberId(member), at, () => undefined), tenant, member);
  }

  async row(issueId: string): Promise<Record<string, unknown>> {
    return (await this.owner<Record<string, unknown>>('select * from machvon.issue where id = $1::uuid', [issueId]))[0] as Record<string, unknown>;
  }

  events(issueId: string): Promise<Array<{ event_kind: string; from_status: string | null; to_status: string | null; note: string | null; payload: Record<string, unknown>; created_by: string }>> {
    return this.owner(
      'select event_kind, from_status, to_status, note, payload, created_by from machvon.issue_event where issue_id = $1::uuid order by created_at, id',
      [issueId],
    );
  }

  /** Moves an open issue to IN_PROGRESS under `assignee` the way the commands do (assign, then start), by the owner of the tables. */
  async inProgress(created: CreatedIssue, assignee: number = PEOPLE.WORKER_U1): Promise<void> {
    await this.owner("update machvon.issue set status = 'ASSIGNED', assignee_id = $2::uuid, version = version + 1 where id = $1::uuid", [created.id, memberId(assignee)]);
    await this.owner("update machvon.issue set status = 'IN_PROGRESS', responded_at = now(), version = version + 1 where id = $1::uuid", [created.id]);
  }

  async seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: this.harness.database.adminUrl });
    await client.connect();
    try {
      // The tables this module only reads (projects, contracts, documents, task forces) are seeded with the foreign keys they have to other modules switched off.
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  async seedCategory(tenant: string, masterType: string, key: string, status = 'EFFECTIVE'): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await this.harness.owner(tenant, [
      [
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
         values ($1, $2, 'TENANT', $3, $4, $5, $6, $6)`,
        [tenant, recordId, masterType, key, status, memberId(PEOPLE.REPORTER)],
      ],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
         values ($1, $2, $3, $4, $5, 1, $5, '{}', '2024-01-01', $6, 'TENANT', $7, $7)`,
        [tenant, versionId, recordId, masterType, key, status, memberId(PEOPLE.REPORTER)],
      ],
      ['update machvon.master_record set current_version_id = $2 where id = $1', [recordId, versionId]],
    ]);
    return versionId;
  }

  async seedWorld(tenant: string): Promise<void> {
    const { harness } = this;
    await harness.seedUnits(tenant, [
      { n: 1, path: '/u1/' },
      { n: 2, path: '/u2/' },
      { n: 3, path: '/u3/' },
    ]);
    for (const n of [PEOPLE.REPORTER, PEOPLE.ASSIGNER, PEOPLE.WORKER_U1, PEOPLE.WORKER_U2, PEOPLE.NO_GRANT, PEOPLE.VERIFIER, PEOPLE.EXTENDER, PEOPLE.UNIT_HEAD, PEOPLE.TF_MEMBER, PEOPLE.TF_LEAD, PEOPLE.OUTSIDER, PEOPLE.SYSTEM]) {
      await harness.seedMembership(tenant, n, 1);
    }
    await harness.seedMembership(tenant, PEOPLE.SUSPENDED, 1, { status: 'Suspended' });
    await harness.seedMembership(tenant, PEOPLE.WORKER_ALL, 1);
    await harness.seedMembership(tenant, PEOPLE.GUEST, 1);
    await this.seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $4, 'Bridge', $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'), ($1, $3, $7, 'Road', $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [tenant, tenant === TENANT_A ? PROJECT : FOREIGN_PROJECT, PROJECT_OTHER, `PRJ-${tenant.slice(-1)}-1`, UNIT_1, id(FAMILY, 20), `PRJ-${tenant.slice(-1)}-2`],
      ],
      [
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version)
         values ($1, $2, $3, $4, $4, $5, 'LUMP_SUM', 'VND', 'DRAFT', 1), ($1, $6, $7, $4, $4, $8, 'LUMP_SUM', 'VND', 'DRAFT', 1)`,
        [tenant, CONTRACT, tenant === TENANT_A ? PROJECT : FOREIGN_PROJECT, id(FAMILY, 21), `HD-${tenant.slice(-1)}-1`, CONTRACT_OTHER_PROJECT, PROJECT_OTHER, `HD-${tenant.slice(-1)}-2`],
      ],
      [
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
         values ($1, $2, '0100000001', 'Lead Builders', 'VERIFIED', $3)`,
        [tenant, CONTRACTOR, id(FAMILY, 22)],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'CV', 'Evidence', 'INTERNAL', $3, $3)`,
        [tenant, id(FAMILY, 22), memberId(PEOPLE.REPORTER)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $4, 1, 'tenants/iss/clean.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $3, $4, 2, 'tenants/iss/pending.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
        [tenant, DOCUMENT_CLEAN, DOCUMENT_PENDING, id(FAMILY, 22)],
      ],
    ]);
    await harness.owner(
      tenant,
      [2026, 2027, 2028].map((year, index): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, $2, 'WORKDAY_VN', $3, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $4, $4, now())`,
        [tenant, id(0x7e, (tenant === TENANT_A ? 1 : 4) + index), year, memberId(PEOPLE.REPORTER)],
      ]),
    );
    await harness.owner(tenant, [
      ["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1", [memberId(PEOPLE.GUEST), CONTRACTOR]],
    ]);
    await harness.seedRole(tenant, 1, 'WORKER', ['issue.work', 'issue.read'], 20);
    await harness.seedRole(tenant, 2, 'ASSIGNER', ['issue.assign', 'issue.read'], 30);
    await harness.seedRole(tenant, 3, 'ESCALATION_ACCEPTOR', ['issue.escalation.accept', 'issue.read'], 40);
    await harness.seedGrants(tenant, [
      { n: 1, member: PEOPLE.WORKER_U1, role: 1, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 2, member: PEOPLE.WORKER_U2, role: 1, kind: 'UNIT_SUBTREE', refs: [UNIT_2] },
      { n: 3, member: PEOPLE.ASSIGNER, role: 2, kind: 'TENANT' },
      { n: 4, member: PEOPLE.SUSPENDED, role: 1, kind: 'TENANT' },
      { n: 5, member: PEOPLE.WORKER_ALL, role: 1, kind: 'TENANT' },
    ]);
  }

  /** Starts the database, seeds the world of both tenants and publishes the policy of the HIGH issues of the category LAND (response 4, resolution 16 working hours). */
  async start(options: { evidence?: boolean; independent?: boolean } = {}): Promise<void> {
    await this.harness.start();
    await this.seedWorld(TENANT_A);
    await this.seedWorld(TENANT_B);
    this.category = await this.seedCategory(TENANT_A, 'ISSUE_CATEGORY', 'LAND');
    await this.as((tx) =>
      this.policies.publish(
        tx,
        {
          code: 'SLA-LAND-HIGH',
          categoryVersionId: this.category,
          severity: 'HIGH',
          calendarCode: 'WORKDAY_VN',
          responseHours: 4,
          resolveHours: 16,
          validFrom: '2026-08-05',
          ...(options.evidence === undefined ? {} : { requireEvidence: options.evidence }),
          ...(options.independent === undefined ? {} : { requireIndependentVerifier: options.independent }),
        },
        memberId(PEOPLE.REPORTER),
      ),
    );
  }

  stop(): Promise<void> {
    return this.harness.stop();
  }
}

export { TENANT_A, TENANT_B, id, memberId, unitId };
