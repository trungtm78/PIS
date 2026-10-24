import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { APP_GUARD, ModuleRef, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ControlDatabase,
  EffectiveAccessStore,
  EntitlementStore,
  InMemoryAuthzCache,
  AuditWriter,
  InMemoryEntitlementCache,
  LicenseStore,
  PLATFORM_TENANT_ID,
  TenantDatabase,
  TenantBootstrapStore,
  TenantRegistry,
  ThemeStore,
  UserSessionStore,
  seedSystemRoles,
  applyBaseline,
  BASELINE_PACK,
} from '@machvon/db';
import type { ThemeConfig } from '@machvon/db';
import { startMigratedTestDatabase } from '@machvon/db/src/migrated-test-database';
import type { TestDatabase } from '@machvon/db/src/test-database';
import { DomainError, STANDARD_FEATURES, loadErrorRegistry, verifyTenantContext } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { createAlertSink } from '../../src/alerts/alert-sinks';
import { AppModule } from '../../src/app.module';
import { AuthGuard } from '../../src/auth/auth.guard';
import type { AuthGuardOptions } from '../../src/auth/auth.guard';
import { HttpJwksSource, discoverJwksUri } from '../../src/auth/jwks-source';
import { JwksTokenVerifier } from '../../src/auth/jwks-token-verifier';
import { ReadOnlyModeGuard } from '../../src/session/read-only-mode.guard';
import { DatabaseTenantRuntime, TENANT_RUNTIME } from '../../src/session/tenant-runtime';
import { UserSessionDenyList } from '../../src/session/user-session-deny-list';
import { MockProvisioningPorts } from '../../src/provisioning/mock-ports';
import { createProvisioningConsumer } from '../../src/provisioning/provisioning-wiring';
import { DOCUMENT_FILE_PORT } from '../../src/modules/doc/file-port';
import { DOC_SIGNING_PORT, DOC_TRUST_STORE } from '../../src/modules/doc/tokens';
import { seedOutgoingDocuments } from './outgoing-seed';
import type { OutgoingSeed } from './outgoing-seed';
import { createOutboxConsumers } from '../../src/workers/outbox-consumers';
import { createOutboxPublisher } from '../../src/workers/outbox-publisher';
import { startWorkers } from '../../src/workers/workers';
import type { RunningWorkers } from '../../src/workers/workers';
import { PRINCIPAL_REQUEST_KEY } from '../../src/principal';
import { INVITATION_MAILER } from '../../src/modules/adm/invitation-mailer';
import type { InvitationMailer } from '../../src/modules/adm/invitation-mailer';
import { Ed25519LicenseSigner } from '../../src/modules/sas/license-signer';
import type { LicenseKeyStore } from '../../src/modules/sas/license-signer';
import type { MockInvitationMailer } from '../../src/modules/adm/invitation-mailer';
import { PUBLIC_METADATA_KEY, Public } from '../../src/public.decorator';
import { TENANT_REQUEST_KEY } from '../../src/tenant-context.decorator';
import { id as fixtureId } from '../../../../packages/db/test/support/authz-fixtures';
import { CONTROL_AUDIENCE, IDENTITY_AUDIENCE, TENANT_ISSUER, issuerKey, newIssuer } from '../auth/auth-fixtures';
import { ERROR_CODES_PATH } from '../isolation/test-app';
import { E2eIdentityProvider } from './oidc-idp';

/**
 * The API stack of the browser end-to-end tests (apps/web/e2e): one embedded PostgreSQL with every migration, the
 * real Nest application (policy guard, command pipeline, all controllers), two seeded tenants and the fixture users of
 * apps/web/e2e/support/e2e-fixtures.json. It is started as the `e2e:stack` script (a jest run that serves until it is
 * told to stop) and describes itself in the JSON file named by E2E_STACK_INFO once it is ready.
 *
 * Two kinds of bearer token are accepted. The development stand-in of the web is a token signed with E2E_SESSION_KEY,
 * whose payload may carry the `aal` and `aal2At` claims. A real tenant token (three dot-separated parts) goes through
 * the production authentication guard: the stack also runs a test identity provider (E2E_IDP_PORT) that signs in the
 * fixture users, and the tenant selection route, so the OIDC sign-in and the tenant chooser run against the real API.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const FIXTURES_PATH = resolve(REPO_ROOT, 'apps', 'web', 'e2e', 'support', 'e2e-fixtures.json');
/** The temporary directory prefix of the stack's database: the orphan cleaner recognises its leftovers by it. */
export const STACK_TEMP_PREFIX = 'machvon-e2e-pg-';
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const LICENSE_KEY_ID = 'e2e-license-key';
const DAY_MS = 86_400_000;
const STANDARD_PLAN = '00000000-0000-4000-9000-000000000001';

/** The theme defaults of the prototype (SAS-04): what a tenant shows until a System Admin brands it. */
const SEED_THEME: ThemeConfig = {
  name: 'Cao Bằng',
  title: 'Hệ Thống Lý Dự Án Đầu Tư Công',
  subtitle: 'Không gian quản lý đầu tư công',
  header: 'Cổng quản lý đầu tư công',
  footer: '© 2026 · Thông tin thuộc phạm vi được phân quyền',
  address: 'Địa chỉ cơ quan · cập nhật theo tenant',
  email: 'hotro@donvi.example',
  phone: '',
  primary: '#b4233d',
  primaryText: '#ffffff',
  menu: '#ffffff',
  menuText: '#615b66',
  selected: '#fff0f2',
  selectedText: '#a11d37',
  headerBg: '#ffffff',
  headerText: '#514a56',
  footerBg: '#ffffff',
  footerText: '#68616c',
  background: '#f7f5f4',
  titleColor: '#29272d',
  logoAssetId: null,
};

interface FixtureUser {
  key: string;
  displayName: string;
  membershipId: string;
  /** Control-plane users have no membership in any tenant. */
  audience?: string;
}

type TenantName = 'A' | 'B' | 'C';

interface Fixtures {
  tenants: Record<TenantName, string>;
  recipientMembershipId: string;
  /** An Active member of unit 2 of tenant A that the ADM-02 flow suspends and reactivates. */
  lifecycleMembershipId: string;
  users: FixtureUser[];
}

const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as Fixtures;
const userKey = (key: string): FixtureUser => {
  const user = fixtures.users.find((candidate) => candidate.key === key);
  if (user === undefined) throw new Error(`fixture user ${key} is missing`);
  return user;
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

const unitId = (n: number): string => fixtureId(0x10, n);
const roleId = (n: number): string => fixtureId(0x30, n);
const grantId = (n: number): string => fixtureId(0x40, n);
const pathOf = (...chain: number[]): string => `/${chain.map(unitId).join('/')}/`;

interface UnitSeed {
  n: number;
  code: string;
  name: string;
  parent?: number;
  chain: number[];
}

const UNITS: Record<TenantName, UnitSeed[]> = {
  A: [
    { n: 1, code: 'CB-HQ', name: 'Ủy ban nhân dân tỉnh Cao Bằng', chain: [1] },
    { n: 2, code: 'CB-SKHDT', name: 'Sở Kế hoạch và Đầu tư', parent: 1, chain: [1, 2] },
    { n: 3, code: 'CB-STC', name: 'Sở Tài chính', parent: 1, chain: [1, 3] },
    { n: 4, code: 'CB-SKHDT-VP', name: 'Văn phòng Sở Kế hoạch và Đầu tư', parent: 2, chain: [1, 2, 4] },
    { n: 5, code: 'CB-SKHDT-QLDA', name: 'Ban Quản lý dự án', parent: 2, chain: [1, 2, 5] },
  ],
  B: [
    { n: 1, code: 'LC-HQ', name: 'Ủy ban nhân dân tỉnh Lào Cai', chain: [1] },
    { n: 2, code: 'LC-SKHDT', name: 'Sở Kế hoạch và Đầu tư Lào Cai', parent: 1, chain: [1, 2] },
  ],
  C: [
    { n: 1, code: 'HG-HQ', name: 'Ủy ban nhân dân tỉnh Hà Giang', chain: [1] },
    { n: 2, code: 'HG-SKHDT', name: 'Sở Kế hoạch và Đầu tư Hà Giang', parent: 1, chain: [1, 2] },
  ],
};

/** The catalogue maker and checker of the master data flows: two roles, since no system role holds the master permissions but the owner's. */
const MASTER_ROLES = [
  { n: 91, code: 'E2E_MASTER_MAKER', permissions: ['master.propose', 'master.import', 'master.crosswalk.manage', 'integration_cursor.read', 'integration.cursor.reset', 'glossary.propose', 'glossary.approve', 'glossary.read', 'master.read', 'master_record_version.read'], rank: 40 },
  { n: 92, code: 'E2E_MASTER_CHECKER', permissions: ['master.review', 'master.publish', 'glossary.approve', 'glossary.read', 'master.read', 'master_record_version.read'], rank: 50 },
];

const READER_ROLE = { n: 90, code: 'E2E_READER', permissions: ['organization_unit.read', 'role_grant.read', 'membership.read', 'contract.read'], rank: 20 };

/** The second person of the delegation-of-authority flow: the owner writes the matrix, this role approves it (no system role holds adm.doa.approve but the administrators'). */
const DOA_CHECKER_ROLE = { n: 96, code: 'E2E_DOA_CHECKER', permissions: ['adm.doa.approve', 'adm.doa.read', 'organization_unit.read', 'role_grant.read'], rank: 50 };

/** The person who only reads the governance screens (ADM-09, ADM-10, ADM-11, ADM-12): no system role holds these read permissions but the administrators'. */
const ADM_READER_ROLE = { n: 98, code: 'E2E_ADM_READER', permissions: ['adm.retention.read', 'adm.integration.read', 'audit_event.read', 'integration_cursor.read', 'legal_hold.read'], rank: 20 };

/** The manager of the SLA policies of the issue module (ISS-09): no system role holds issue.sla.manage but the owner's. */
const ISS_ROLE = { n: 97, code: 'E2E_SLA_MANAGER', permissions: ['issue.sla.manage', 'issue.read', 'master.read', 'organization_unit.read'], rank: 40 };

/**
 * The people of the project register (PRJ-01 to 03), the capital register (CAP-04, 14, 16) and the reporting period calendar (DIS-14). No system
 * role holds these permissions but the owner's, so each person gets a role of their own: the planner and the approver of the capital are two
 * people (the approver of an appropriation is never its registrant), and so are the one who soft closes a period and the one who locks it.
 * The permissions are the ones of apps/web/e2e/support/e2e-fixtures.json; a screen is gated by both lists.
 */
const INVESTMENT_ROLES = [
  { n: 110, user: 'projectManager', code: 'E2E_PROJECT_MANAGER', permissions: ['project.read', 'project.create', 'project.update', 'organization_unit.read', 'master.read'], rank: 40 },
  { n: 111, user: 'projectViewer', code: 'E2E_PROJECT_VIEWER', permissions: ['project.read', 'organization_unit.read', 'master.read'], rank: 20 },
  { n: 112, user: 'capPlanner', code: 'E2E_CAPITAL_PLANNER', permissions: ['capital.read', 'capital.appropriation.manage', 'master.read'], rank: 40 },
  { n: 113, user: 'capApprover', code: 'E2E_CAPITAL_APPROVER', permissions: ['capital.read', 'capital.appropriation.approve'], rank: 50 },
  { n: 114, user: 'capReader', code: 'E2E_CAPITAL_READER', permissions: ['capital.read'], rank: 20 },
  { n: 115, user: 'periodManager', code: 'E2E_PERIOD_MANAGER', permissions: ['period.manage', 'reporting_period.read'], rank: 40 },
  { n: 116, user: 'periodLocker', code: 'E2E_PERIOD_LOCKER', permissions: ['period.lock', 'reporting_period.read'], rank: 50 },
  { n: 117, user: 'periodReader', code: 'E2E_PERIOD_READER', permissions: ['reporting_period.read'], rank: 20 },
];

/**
 * The people of the dataset catalogue (DGV-03, 04), the template library (DOC-14: the drafter and publisher, the publisher who must not confirm
 * their own work, the legal officer) and the contractor registry (BID-01, 02: the manager who may both register and verify, the verifier, the reader
 * who sees the tax id covered). The permissions are the ones of apps/web/e2e/support/e2e-fixtures.json; a screen is gated by both lists.
 */
const STORY_ROLES = [
  { n: 120, user: 'dgvSteward', code: 'E2E_DGV_STEWARD', permissions: ['data.catalog.manage', 'data.catalog.read', 'membership.read'], rank: 40 },
  { n: 121, user: 'dgvReader', code: 'E2E_DGV_READER', permissions: ['data.catalog.read'], rank: 20 },
  { n: 122, user: 'templateAdmin', code: 'E2E_TEMPLATE_ADMIN', permissions: ['doc.template.manage', 'doc.template.approve', 'doc.template.read'], rank: 60 },
  { n: 123, user: 'templatePublisher', code: 'E2E_TEMPLATE_PUBLISHER', permissions: ['doc.template.approve', 'doc.template.confirm_legal', 'doc.template.read'], rank: 50 },
  { n: 124, user: 'legalOfficer', code: 'E2E_LEGAL_OFFICER', permissions: ['doc.template.confirm_legal', 'doc.template.read'], rank: 50 },
  { n: 125, user: 'templateReader', code: 'E2E_TEMPLATE_READER', permissions: ['doc.template.read'], rank: 20 },
  { n: 126, user: 'bidManager', code: 'E2E_BID_MANAGER', permissions: ['bid.contractor.manage', 'bid.contractor.verify', 'bid.contractor.read', 'contractor.read'], rank: 40 },
  { n: 127, user: 'bidVerifier', code: 'E2E_BID_VERIFIER', permissions: ['bid.contractor.verify', 'bid.contractor.read', 'contractor.read'], rank: 50 },
  { n: 128, user: 'bidReader', code: 'E2E_BID_READER', permissions: ['contractor.read'], rank: 20 },
  // The monitoring calendar (MNE-01) and the form catalogue (MNE-02): the administrator drafts forms and rules and generates the year and also holds the approvals (so the server, not the screen, refuses the author's own publication), the approver is the second person, the reader only reads.
  { n: 129, user: 'mneAdmin', code: 'E2E_MNE_ADMIN', permissions: ['mne.form.manage', 'mne.form.approve', 'mne.calendar.manage', 'mne.calendar.approve', 'mne.read'], rank: 60 },
  { n: 130, user: 'mneApprover', code: 'E2E_MNE_APPROVER', permissions: ['mne.form.approve', 'mne.calendar.approve', 'mne.read'], rank: 50 },
  { n: 131, user: 'mneReader', code: 'E2E_MNE_READER', permissions: ['mne.read'], rank: 20 },
];

interface GrantPlan {
  n: number;
  user: string;
  role: string;
  kind: 'TENANT' | 'UNIT_SUBTREE';
  refs: string[];
}

const GRANTS: GrantPlan[] = [
  { n: 1, user: 'owner', role: 'TENANT_OWNER', kind: 'TENANT', refs: [] },
  { n: 2, user: 'unitAdmin', role: 'UNIT_ADMIN', kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
  { n: 3, user: 'unitAdmin', role: READER_ROLE.code, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
  { n: 4, user: 'auditor', role: READER_ROLE.code, kind: 'TENANT', refs: [] },
  { n: 20, user: 'doaChecker', role: DOA_CHECKER_ROLE.code, kind: 'TENANT', refs: [] },
  { n: 5, user: 'nobody', role: 'MEMBER', kind: 'TENANT', refs: [] },
  { n: 6, user: 'steward', role: MASTER_ROLES[0]?.code ?? '', kind: 'TENANT', refs: [] },
  { n: 7, user: 'dataChecker', role: MASTER_ROLES[1]?.code ?? '', kind: 'TENANT', refs: [] },
  { n: 21, user: 'slaManager', role: ISS_ROLE.code, kind: 'TENANT', refs: [] },
  { n: 22, user: 'admReader', role: ADM_READER_ROLE.code, kind: 'TENANT', refs: [] },
  ...STORY_ROLES.map((role, index): GrantPlan => ({ n: 60 + index, user: role.user, role: role.code, kind: 'TENANT', refs: [] })),
  ...INVESTMENT_ROLES.map((role, index): GrantPlan => ({ n: 30 + index, user: role.user, role: role.code, kind: 'TENANT', refs: [] })),
];

/** Runs statements as machvon_owner with the tenant set (FORCE RLS applies to the owner too). */
async function asOwner<T extends object = Record<string, unknown>>(
  database: TestDatabase,
  tenantId: string,
  statements: Array<[string, unknown[]?]>,
): Promise<T[]> {
  const client = new Client({ connectionString: database.urlFor('machvon_owner') });
  await client.connect();
  try {
    await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
    let last: T[] = [];
    for (const [text, params] of statements) last = (await client.query(text, params)).rows as T[];
    return last;
  } finally {
    await client.end();
  }
}

/**
 * What the SLA policy screen (ISS-09) needs and no screen of this build makes: two issue categories in force, and the published working
 * calendar WORKDAY_VN of this year and the next one (a policy may begin in the days to come, and a calendar is published by ADM-07).
 */
function issueFixtures(tenantId: string): Array<[string, unknown[]]> {
  const statements: Array<[string, unknown[]]> = [];
  for (const n of [1, 2]) {
    const record = fixtureId(0x5a, n * 2 - 1);
    const version = fixtureId(0x5a, n * 2);
    statements.push(
      [
        "insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', $3, 'EFFECTIVE', $4, $4)",
        [tenantId, record, `E2E_ISSUE_CATEGORY_${n}`, ACTOR],
      ],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
         values ($1, $2, $3, 'ISSUE_CATEGORY', $4, 1, $5, '{}', '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $6, $6)`,
        [tenantId, version, record, `E2E_ISSUE_CATEGORY_${n}`, n === 1 ? 'Giải phóng mặt bằng' : 'Chất lượng công trình', ACTOR],
      ],
      ['update machvon.master_record set current_version_id = $2 where id = $1', [record, version]],
    );
  }
  const year = new Date().getUTCFullYear();
  [year, year + 1].forEach((calendarYear, index) => {
    statements.push([
      `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
       values ($1, $2, 'WORKDAY_VN', $3, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $4, $4, now())`,
      [tenantId, fixtureId(0x5b, index + 1), calendarYear, ACTOR],
    ]);
  });
  return statements;
}

/**
 * What the project register (PRJ-02) and the capital register (CAP-16) need and no screen of this build makes: one area in force, which is the
 * area the seeded project DA-01 already names (the version fixtureId(0x52, 1)), and three documents of the tenant that can back a decision on
 * capital. The fund sources, the sectors and the group thresholds come from the baseline the tenant applies.
 */
function investmentFixtures(tenantId: string): Array<[string, unknown[]]> {
  const record = fixtureId(0x5c, 1);
  const statements: Array<[string, unknown[]]> = [
    [
      "insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'E2E_AREA_1', 'EFFECTIVE', $3, $3)",
      [tenantId, record, ACTOR],
    ],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
       values ($1, $2, $3, 'AREA', 'E2E_AREA_1', 1, 'Thành phố Cao Bằng', '{}', '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $4, $4)`,
      [tenantId, fixtureId(0x52, 1), record, ACTOR],
    ],
    ['update machvon.master_record set current_version_id = $2 where id = $1', [record, fixtureId(0x52, 1)]],
  ];
  for (const n of [1, 2, 3, 4]) {
    statements.push([
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', $3, $4, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $5, $5)`,
      [tenantId, fixtureId(0x5d, n), `Quyết định giao vốn e2e ${n}`, `QD-E2E-${n}/2026`, ACTOR],
    ]);
  }
  return statements;
}

/**
 * What the governance screens (ADM-09, ADM-10, ADM-11, ADM-12) show before a flow touches anything: three audit rows (one of each outcome),
 * a published and a draft retention rule written by other people than the owner (so the owner may publish the draft), a record that waits for
 * review, an active legal hold, a connector of each adapter status that matters and inbound events (one still held, one whose payload is purged).
 */
function governanceFixtures(tenantId: string): Array<[string, unknown[]]> {
  const nobody = userKey('nobody').membershipId;
  const owner = userKey('owner').membershipId;
  const published = fixtureId(0x7b, 1);
  const statements: Array<[string, unknown[]]> = [];
  for (const [n, action, outcome, actor, diff] of [
    [1, 'e2e.seed.read', 'SUCCESS', nobody, { field: 'value' }],
    [2, 'e2e.seed.refused', 'DENIED', nobody, {}],
    [3, 'e2e.seed.crashed', 'FAILED', owner, {}],
  ] as const) {
    statements.push([
      `insert into machvon.audit_event (tenant_id, id, actor_id, action, resource_type, resource_id, safe_diff, correlation_id, request_id, occurred_at, outcome)
       values ($1, $2, $3, $4, 'e2e_seed', $2, $5::jsonb, $2, $2, timestamptz '2026-03-02T09:15:00Z' + $6::int * interval '1 minute', $7)`,
      [tenantId, fixtureId(0x7a, n), actor, action, JSON.stringify(diff), n, outcome],
    ]);
  }
  statements.push(
    [
      `insert into machvon.data_retention_policy
         (tenant_id, id, record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from, status, created_by, approved_by, published_at, version)
       values ($1, $2, 'payment_dossier', 1, 10, 'FROM_CLOSED', 'Luật Lưu trữ 2011 [E2E-RET-01]', 'REVIEW_FOR_DESTRUCTION', date '2026-01-01', 'Published', $3, $4, timestamptz '2026-01-02T00:00:00Z', 2)`,
      [tenantId, published, ACTOR, fixtureId(0x7b, 9)],
    ],
    [
      `insert into machvon.data_retention_policy
         (tenant_id, id, record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from, status, created_by, version)
       values ($1, $2, 'contract_dossier', 1, 15, 'FROM_CONTRACT_END', 'Luật Lưu trữ 2011 [E2E-RET-02]', 'ARCHIVE_TRANSFER', date '2026-01-01', 'Draft', $3, 1)`,
      [tenantId, fixtureId(0x7b, 2), ACTOR],
    ],
    [
      `insert into machvon.retention_review_item (tenant_id, id, record_class, resource_type, resource_id, policy_id, basis_date, due_on, end_action)
       values ($1, $2, 'payment_dossier', 'payment_request', $3, $4, date '2015-03-01', date '2025-03-01', 'REVIEW_FOR_DESTRUCTION')`,
      [tenantId, fixtureId(0x7b, 3), fixtureId(0x7b, 4), published],
    ],
    [
      `insert into machvon.legal_hold (tenant_id, id, resource_scope, authority_reference, reason, effective_at, hold_kind, status, placed_by, version)
       values ($1, $2, '{"kind":"TENANT","ids":[]}'::jsonb, 'Quyết định thanh tra E2E-01', 'Thanh tra chuyên đề e2e', timestamptz '2026-02-01T00:00:00Z', 'INSPECTION', 'Active', $3, 1)`,
      [tenantId, fixtureId(0x7b, 5), owner],
    ],
  );
  for (const [n, code, adapter, mode] of [
    [1, 'e2e-verified-file', 'VERIFIED', 'FILE_IMPORT'],
    [2, 'e2e-mock-gateway', 'MOCK', 'LGSP'],
    [3, 'e2e-proposed-api', 'PROPOSED', 'API'],
  ] as const) {
    statements.push([
      `insert into machvon.integration_connector (tenant_id, id, connector_code, adapter_status, mode, config_json, credential_secret_ref, mapping_version, status, last_test_result)
       values ($1, $2, $3, $4, $5, '{"directory":"/e2e/inbox"}'::jsonb, 'secret://e2e/connectors/' || $3::text, 'v1', 'Draft', 'NOT_TESTED')`,
      [tenantId, fixtureId(0x7c, n), code, adapter, mode],
    ]);
  }
  for (const [n, key, status, attempts, kept] of [
    [1, 'e2e-evt-failed', 'FAILED', 3, true],
    [2, 'e2e-evt-dead', 'DEAD', 10, false],
    [3, 'e2e-evt-done', 'PROCESSED', 1, true],
  ] as const) {
    statements.push([
      `insert into machvon.integration_event_inbox
         (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id, attempts, error_code, payload_purged_at)
       values ($1, $2, 'E2E_TREASURY', $3, repeat('d', 64), $4::text, timestamptz '2026-10-24T09:00:00Z', $5, 'k1', $6, case when $5 in ('FAILED', 'DEAD') then 'PROVIDER_DOWN' end, case when $4::text is null then now() end)`,
      [tenantId, fixtureId(0x7d, n), key, kept ? `tenants/${tenantId}/webhook/E2E-SECRET-PAYLOAD-${key}` : null, status, attempts],
    ]);
  }
  statements.push([
    `insert into machvon.integration_cursor (tenant_id, id, connector_code, source_scope, cursor_json, schema_version, adapter_status, status, last_file_sha256)
     values ($1, $2, 'E2E_TREASURY_FILE', 'DEFAULT', '{}'::jsonb, '1', 'PROPOSED', 'ACTIVE', repeat('e', 64))`,
    [tenantId, fixtureId(0x7e, 1)],
  ]);
  return statements;
}

async function seedTenant(database: TestDatabase, tenants: TenantDatabase, name: TenantName): Promise<void> {
  const tenantId = fixtures.tenants[name];
  await tenants.withTenant({ tenantId, membershipId: ACTOR, scopeVersion: 1 }, (tx) => seedSystemRoles(tx, ACTOR));
  const memberships = name === 'A' ? fixtures.users.filter((user) => user.audience !== 'control').map((user) => user.membershipId).concat(fixtures.recipientMembershipId) : [userKey('owner').membershipId];
  const statements: Array<[string, unknown[]?]> = [];
  for (const unit of UNITS[name]) {
    statements.push([
      `insert into machvon.organization_unit (tenant_id, id, code, name, parent_id, valid_from, path, depth)
       values ($1, $2, $3, $4, $5, date '2026-01-01', $6, $7)`,
      [tenantId, unitId(unit.n), unit.code, unit.name, unit.parent === undefined ? null : unitId(unit.parent), pathOf(...unit.chain), unit.chain.length - 1],
    ]);
  }
  for (const membershipId of memberships) {
    const organization = membershipId === userKey('unitAdmin').membershipId ? unitId(2) : unitId(1);
    statements.push([
      "insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, $4, 'Active') on conflict do nothing",
      [membershipId, `e2e-${membershipId}`, `${membershipId}@example.test`, `E2E ${membershipId.slice(-2)}`],
    ]);
    statements.push([
      "insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $3, $4, 'Active', now() - interval '1 day')",
      [tenantId, membershipId, membershipId, organization],
    ]);
  }
  for (const role of [READER_ROLE, DOA_CHECKER_ROLE, ADM_READER_ROLE, ISS_ROLE, ...INVESTMENT_ROLES, ...STORY_ROLES, ...MASTER_ROLES]) {
    statements.push([
      "insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, $3, $3, $4, $5, 'Active', $6)",
      [tenantId, roleId(role.n), role.code, role.permissions, role.rank, ACTOR],
    ]);
  }
  if (name === 'A') statements.push(...issueFixtures(tenantId), ...investmentFixtures(tenantId), ...governanceFixtures(tenantId));
  // The units that owe the reports of the investors in the monitoring calendar (MNE-01): the Office and the Project Management Board of the Department.
  if (name === 'A') statements.push(["update machvon.organization_unit set is_investor = true where tenant_id = $1 and code = any($2::text[])", [tenantId, ['CB-SKHDT-VP', 'CB-SKHDT-QLDA']]]);
  await asOwner(database, tenantId, statements);
  // The tenant that the browser flows use starts from the baseline the platform publishes (catalogues and rule data), as a provisioned tenant does.
  if (name === 'A') await tenants.withTenant({ tenantId, membershipId: ACTOR, scopeVersion: 1 }, (tx) => applyBaseline(tx, BASELINE_PACK, ACTOR));

  const roles = await asOwner<{ id: string; code: string }>(database, tenantId, [['select id, code from machvon.role_definition', []]]);
  const roleByCode = new Map(roles.map((row) => [row.code, row.id]));
  const plans: GrantPlan[] = name === 'A' ? GRANTS : GRANTS.filter((grant) => grant.user === 'owner');
  await asOwner(
    database,
    tenantId,
    plans.map((plan): [string, unknown[]] => [
      `insert into machvon.role_grant
         (tenant_id, id, membership_id, role_id, scope_json, effective_from, effective_until, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
       values ($1, $2, $3, $4, $5::jsonb, '2026-01-01T00:00:00Z', null, $6, $7::uuid[], 'Active', $8, 'e2e fixture')`,
      [tenantId, grantId(plan.n), userKey(plan.user).membershipId, roleByCode.get(plan.role), JSON.stringify({ kind: plan.kind, ref_ids: plan.refs }), plan.kind, plan.refs, ACTOR],
    ]),
  );
}

/** A member the lifecycle flow of ADM-02 may suspend, and a contractor with contracts the guest invitation of ADM-17 picks from. */
async function seedMemberFixtures(database: TestDatabase): Promise<void> {
  const tenantId = fixtures.tenants.A;
  const roleRows = await asOwner<{ id: string }>(database, tenantId, [["select id from machvon.role_definition where code = 'MEMBER'", []]]);
  await asOwner(database, tenantId, [
    [
      "insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, 'Thành viên thử', 'Active') on conflict do nothing",
      [fixtures.lifecycleMembershipId, `e2e-${fixtures.lifecycleMembershipId}`, `${fixtures.lifecycleMembershipId}@example.test`],
    ],
    [
      "insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $2, $3, 'Active', now() - interval '1 day')",
      [tenantId, fixtures.lifecycleMembershipId, unitId(2)],
    ],
    [
      `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
       values ($1, $2, $3, $4, '{"kind":"UNIT_ONLY","ref_ids":["${unitId(2)}"]}'::jsonb, '2026-01-01T00:00:00Z', 'UNIT_ONLY', $5::uuid[], 'Active', $6, 'e2e fixture')`,
      [tenantId, grantId(50), fixtures.lifecycleMembershipId, roleRows[0]?.id, [unitId(2)], ACTOR],
    ],
  ]);
  // Foreign keys to the modules that do not exist yet are switched off for this seeding (the superuser may).
  const client = new Client({ connectionString: database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    const contractor = fixtureId(0x54, 1);
    const project = fixtureId(0x50, 1);
    await client.query(
      "insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, '0100000001', 'Nhà thầu Cao Bằng', 'VERIFIED', $3)",
      [tenantId, contractor, fixtureId(0x55, 1)],
    );
    await client.query(
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version)
       values ($1, $2, 'DA-01', 'Dự án thử', $3, $4, 'INTERNAL', 1000, 'CONCEPT', 1)`,
      [tenantId, project, unitId(2), fixtureId(0x52, 1)],
    );
    // The completion date is relative to the day the stack is seeded: a guest invitation may end up to 365 days after the
    // latest completion, and a fixed date would turn the guest flow of the browser suite into a test that fails from a day on.
    for (const [n, code, status, daysToCompletion] of [
      [1, 'HD-01', 'ACTIVE', 200],
      [2, 'HD-02', 'SIGNED', null],
    ] as const) {
      await client.query(
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from, completion_due)
         values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, 1000, date '2026-01-01', date '2026-01-01', current_date + $8::int)`,
        [tenantId, fixtureId(0x51, n), project, fixtureId(0x53, 1), contractor, code, status, daysToCompletion],
      );
    }
  } finally {
    await client.end();
  }
}

const PLACEMENT_NORTH = '00000000-0000-4000-8000-0000000000c1';

/** The control plane needs one Active placement for the DB_PLACEMENT step; the STANDARD plan comes from migration V009. */
/** The first published theme (version 1) of the three fixture tenants, as the provisioning saga will leave it: the prototype defaults under the name of the tenant. */
async function seedThemes(control: ControlDatabase): Promise<void> {
  const themes = new ThemeStore();
  const names: Readonly<Record<TenantName, string>> = { A: 'Cao Bằng', B: 'Lào Cai', C: 'Hà Giang' };
  for (const name of Object.keys(names) as TenantName[]) {
    const tenantId = fixtures.tenants[name];
    const config = { ...SEED_THEME, name: names[name] };
    await control.withTenantOf(PLATFORM_TENANT_ID, (tx) => themes.actingAs(tx, tenantId, PLATFORM_TENANT_ID, () => themes.createInitialVersion(tx, { tenantId, config, publishedBy: ACTOR })));
  }
}

async function seedPlacement(database: TestDatabase): Promise<void> {
  const client = new Client({ connectionString: database.adminUrl });
  await client.connect();
  try {
    await client.query(
      "insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'north-1', 'kms-1', 'Active') on conflict do nothing",
      [PLACEMENT_NORTH],
    );
    // Tenant A is already a registered, Active tenant of the control plane, so the registry and the entitlement view have a row to show.
    await client.query(
      "insert into machvon.tenant (id, code, name, status, placement_id, region, governing_body_type, isolation_mode) values ($1, 'cao-bang', 'Cao Bằng', 'Active', $2, 'vn-north', 'PROVINCE', 'POOL') on conflict do nothing",
      [fixtures.tenants.A, PLACEMENT_NORTH],
    );
    // The tenant chooser lists the registered tenants a person belongs to: B is Active, C is suspended for non-payment (a read-only session).
    const others: Array<[string, string, string, string, string | null]> = [
      [fixtures.tenants.B, 'lao-cai', 'Lào Cai', 'Active', null],
      [fixtures.tenants.C, 'ha-giang', 'Hà Giang', 'Suspended', 'NON_PAYMENT'],
    ];
    for (const [tenantId, code, name, status, reason] of others) {
      await client.query(
        "insert into machvon.tenant (id, code, name, status, placement_id, region, governing_body_type, isolation_mode, lifecycle_reason) values ($1, $2, $3, $4, $5, 'vn-north', 'PROVINCE', 'POOL', $6) on conflict do nothing",
        [tenantId, code, name, status, PLACEMENT_NORTH, reason],
      );
    }
  } finally {
    await client.end();
  }
}

const SIGNING_KEY = Symbol('E2E_SIGNING_KEY');

interface GuardedRequest {
  headers: Record<string, string | string[] | undefined>;
  [TENANT_REQUEST_KEY]?: unknown;
  [PRINCIPAL_REQUEST_KEY]?: unknown;
}

interface TokenClaims {
  aal?: string;
  aal2At?: string;
  aud?: string;
  roles?: string[];
}

function claimsOf(token: string): TokenClaims {
  const payload = token.split('.')[0] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
}

const REAL_AUTH_GUARD = Symbol('E2E_REAL_AUTH_GUARD');
/** A signed JWT has three dot-separated parts; the development token has two. */
const isJwt = (token: string): boolean => token.split('.').length === 3;

/**
 * Trusts a bearer token signed with the stack key (public routes need none) and states the assurance it carries.
 * A JWT is a real tenant token and goes through the production authentication guard instead.
 */
@Injectable()
class E2eAuthGuard implements CanActivate {
  constructor(
    @Inject(SIGNING_KEY) private readonly key: Buffer,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(REAL_AUTH_GUARD) private readonly real: AuthGuard,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    if (this.reflector.get<boolean | undefined>(PUBLIC_METADATA_KEY, context.getHandler()) === true) return true;
    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw new DomainError('SESSION_EXPIRED', 401);
    const token = header.slice('Bearer '.length);
    if (isJwt(token)) return this.real.canActivate(context);
    const tenant = verifyTenantContext(token, this.key);
    const claims = claimsOf(token);
    request[TENANT_REQUEST_KEY] = tenant;
    const control = claims.aud === 'control';
    request[PRINCIPAL_REQUEST_KEY] = {
      tenant,
      audience: control ? 'control' : 'tenant',
      ...(control ? { roles: claims.roles ?? [] } : {}),
      assurance: claims.aal === 'aal2' ? 'aal2' : 'aal1',
      aal2At: claims.aal2At === undefined ? undefined : new Date(claims.aal2At),
      sessionId: `e2e-${tenant.membershipId}`,
    };
    return true;
  }
}

/**
 * The development stack keeps invitation mail in memory (the MOCK mailer) instead of sending it; this route hands the
 * newest message to an address to the development session of the web, which shows how to accept it. It exists only in
 * this stack: the application has no such route.
 */
@Controller('__dev')
class DevMailboxController {
  constructor(@Inject(ModuleRef) private readonly modules: ModuleRef) {}

  @Get('mailbox')
  @Public()
  mailbox(@Query('email') email: string | undefined): { invitation_id: string; token: string; expires_at: string } {
    const mailer = this.modules.get<MockInvitationMailer>(INVITATION_MAILER, { strict: false });
    const message = email === undefined ? undefined : mailer.lastTo(email);
    if (message === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { invitation_id: message.invitationId, token: message.token, expires_at: message.expiresAt.toISOString() };
  }
}

@Controller('__e2e')
class HealthController {
  @Get('health')
  @Public()
  health(): { ok: true } {
    return { ok: true };
  }
}

@Module({})
class E2eRootModule {}

export interface StackInfo {
  apiPort: number;
  /** A superuser connection for the tests' own assertions about rows. */
  adminUrl: string;
  tenants: Fixtures['tenants'];
  /** The published STANDARD plan a tenant request names. */
  planVersionId: string;
  units: Record<TenantName, Record<string, string>>;
  /** The test identity provider's issuer address. */
  idpIssuer: string;
  /** Outgoing documents of tenant A: the two the visual cases read and the one the signing flow changes. */
  documents: OutgoingSeed['documents'];
}

function unitIds(name: TenantName): Record<string, string> {
  return Object.fromEntries(UNITS[name].map((unit) => [unit.code, unitId(unit.n)]));
}

const pollUntil = async (done: () => boolean, intervalMs: number): Promise<void> => {
  while (!done()) await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
};

describe('e2e API stack', () => {
  it('serves the application on E2E_API_PORT until the stop file appears', async () => {
    const infoPath = required('E2E_STACK_INFO');
    const stopPath = `${infoPath}.stop`;
    const port = Number(required('E2E_API_PORT'));
    const key = Buffer.from(required('E2E_SESSION_KEY'), 'base64');
    mkdirSync(dirname(infoPath), { recursive: true });
    for (const stale of [infoPath, stopPath]) rmSync(stale, { force: true });
    writeFileSync(`${infoPath}.pid`, String(process.pid));

    const database = await startMigratedTestDatabase(REPO_ROOT, { tempPrefix: STACK_TEMP_PREFIX });
    const pool = new Pool({ connectionString: database.urlFor('machvon_app'), max: 8 });
    pool.on('error', () => undefined);
    const controlPool = new Pool({ connectionString: database.urlFor('machvon_control'), max: 4 });
    controlPool.on('error', () => undefined);
    const relayPool = new Pool({ connectionString: database.urlFor('machvon_outbox_relay'), max: 2 });
    relayPool.on('error', () => undefined);
    const lockPool = new Pool({ connectionString: database.urlFor('machvon_outbox_relay'), max: 6 });
    lockPool.on('error', () => undefined);
    let workers: RunningWorkers | undefined;
    let app: INestApplication | undefined;
    let idp: E2eIdentityProvider | undefined;
    try {
      const tenants = new TenantDatabase(pool);
      await seedTenant(database, tenants, 'A');
      await seedTenant(database, tenants, 'B');
      await seedTenant(database, tenants, 'C');
      await seedMemberFixtures(database);
      await seedPlacement(database);
      // Outgoing documents of tenant A with a signed PDF, a certificate authority of the test and a signing adapter that approves by itself.
      const outgoing = await seedOutgoingDocuments({
        database,
        tenants,
        tenantId: fixtures.tenants.A,
        signerMembershipId: userKey('owner').membershipId,
        drafterMembershipId: userKey('unitAdmin').membershipId,
        draftingUnitId: unitId(2),
        organizationUnitId: unitId(1),
      });
      const authzCache = new InMemoryAuthzCache();
      const entitlementCache = new InMemoryEntitlementCache();
      const tenantRuntime = new DatabaseTenantRuntime(tenants);
      const access = new EffectiveAccessStore(tenants, authzCache);
      const control = new ControlDatabase(controlPool);
      const registry = new TenantRegistry(control);
      const entitlementStore = new EntitlementStore(tenants, entitlementCache);
      await seedThemes(control);
      await tenants.withTenant({ tenantId: fixtures.tenants.A, membershipId: ACTOR, scopeVersion: 1 }, (tx) =>
        entitlementStore.record(tx, { cause: 'PROVISIONING', planVersionId: STANDARD_PLAN, features: STANDARD_FEATURES }),
      );
      // The license signing key of the stack lives in this process: the private half is never written anywhere, the public half is registered.
      const licensePair = generateKeyPairSync('ed25519');
      const licenseSigner = new Ed25519LicenseSigner(LICENSE_KEY_ID, licensePair.privateKey);
      const licenseKeys: LicenseKeyStore = {
        current: () => Promise.resolve(licenseSigner),
        publicKeys: () => Promise.resolve(new Map([[LICENSE_KEY_ID, licensePair.publicKey.export({ format: 'der', type: 'spki' })]])),
      };
      const licenseStore = new LicenseStore(entitlementStore);
      await control.withControl((tx) =>
        licenseStore.registerSigningKey(tx, {
          keyId: LICENSE_KEY_ID,
          publicKeyPem: licensePair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
          kmsKeyRef: 'e2e-memory',
          notBefore: new Date(Date.now() - 30 * DAY_MS),
          notAfter: new Date(Date.now() + 730 * DAY_MS),
        }),
      );
      // Real sign-in: the test identity provider signs in the fixture people, the production guard verifies the tenant tokens the API issues.
      idp = await E2eIdentityProvider.start({
        users: fixtures.users.filter((user) => user.audience !== 'control').map((user) => ({ key: user.key, subject: `e2e-${user.membershipId}`, name: user.displayName })),
        clientId: IDENTITY_AUDIENCE,
        port: Number(process.env.E2E_IDP_PORT ?? 0),
      });
      const issuer = newIssuer(issuerKey());
      const verifier = new JwksTokenVerifier({
        issuer: idp.issuer,
        identityAudience: IDENTITY_AUDIENCE,
        controlAudience: CONTROL_AUDIENCE,
        jwks: new HttpJwksSource({ jwksUri: await discoverJwksUri(idp.issuer) }),
        tenantTokenKeys: async () => (await issuer.publicKeys()).keys,
        tenantIssuer: TENANT_ISSUER,
      });
      const sessions = new UserSessionStore(tenants);
      const denyList = new UserSessionDenyList(sessions);
      const authOptions: AuthGuardOptions = { verifier, denyList, controlAudience: CONTROL_AUDIENCE };
      const moduleRef = await Test.createTestingModule({
        imports: [
          {
            module: E2eRootModule,
            imports: [AppModule.register({
                database: tenants,
                registry: loadErrorRegistry(ERROR_CODES_PATH),
                policy: { database: tenants, access, denyList },
                session: { verifier, control, tenants, sessions, issuer, denyList },
                control: { database: control, registry },
                entitlements: { store: entitlementStore, control },
                licenses: { store: licenseStore, keys: licenseKeys },
                tenantState: { runtime: tenantRuntime, entitlementCache, authzCache },
              })],
            controllers: [HealthController, DevMailboxController],
            providers: [
              { provide: SIGNING_KEY, useValue: key },
              { provide: TENANT_RUNTIME, useValue: tenantRuntime },
              { provide: REAL_AUTH_GUARD, useValue: new AuthGuard(authOptions, new Reflector()) },
              { provide: APP_GUARD, useClass: E2eAuthGuard },
              // A session of a suspended tenant reads and exports only; it runs right after the token is authenticated.
              { provide: APP_GUARD, useClass: ReadOnlyModeGuard },
            ],
          },
        ],
      })
        .overrideProvider(DOCUMENT_FILE_PORT)
        .useValue(outgoing.files)
        .overrideProvider(DOC_SIGNING_PORT)
        .useValue(outgoing.signing)
        .overrideProvider(DOC_TRUST_STORE)
        .useValue(outgoing.trust)
        .compile();
      app = moduleRef.createNestApplication();
      await app.listen(port, '127.0.0.1');
      // The background work is the code of the API process (apps/api/src/workers): the saga runs in this process behind the
      // outbox relay, over mock infrastructure ports, and all eleven steps run; the invitation goes to the mailer of the
      // application, which the dev mailbox route reads. Only the relay polls faster than in production, so a flow does not wait 5 s.
      const signingKey = randomBytes(32);
      const alerts = createAlertSink({ alertWebhookUrl: undefined, telemetry: { exporter: 'none', otlpEndpoint: undefined, serviceName: 'machvon-e2e-stack' } });
      const security = { signingKey, alerts };
      const provisioning = createProvisioningConsumer({
        tenants,
        registry,
        services: {
          control,
          entitlements: entitlementStore,
          licenses: licenseStore,
          keys: licenseKeys,
          themes: new ThemeStore(),
          bootstrap: new TenantBootstrapStore(),
          audit: new AuditWriter(tenants),
          mailer: moduleRef.get<InvitationMailer>(INVITATION_MAILER, { strict: false }),
        },
        ports: new MockProvisioningPorts(),
        security,
        delay: () => Promise.resolve(),
      });
      const consumers = createOutboxConsumers({ tenants, control, access, entitlementCache, authzCache, tenantRuntime, security, provisioning });
      workers = startWorkers(
        { tenants, control, relayPool, lockPool, signingKey, alerts, publish: createOutboxPublisher(consumers), accessCache: authzCache },
        // The job that closes and locks the periods by the calendar runs once a day here: the period flows of DIS-14 move a period by hand and must not race it.
        { intervalSeconds: { 'outbox-relay': 1, 'dis-period-autoclose': 86_400 } },
      );
      const listening = (app.getHttpServer().address() as AddressInfo).port;
      const info: StackInfo = { apiPort: listening, adminUrl: database.adminUrl, tenants: fixtures.tenants, planVersionId: STANDARD_PLAN, units: { A: unitIds('A'), B: unitIds('B'), C: unitIds('C') }, idpIssuer: idp.issuer, documents: outgoing.documents };
      writeFileSync(infoPath, JSON.stringify(info, null, 2));
      await pollUntil(() => existsSync(stopPath), 500);
    } finally {
      rmSync(infoPath, { force: true });
      await workers?.stop();
      if (app) await app.close();
      await idp?.stop();
      await Promise.all([pool.end(), controlPool.end(), relayPool.end(), lockPool.end()]);
      await database.stop();
      rmSync(`${infoPath}.pid`, { force: true });
    }
  }, 24 * 60 * 60 * 1000);
});
