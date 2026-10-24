/** Names of the fixture tenants in Design/MACHVON_Design/03_Engineering/test_fixtures.json. */
export type TenantName = 'TNT-A' | 'TNT-B';

export const TENANT_NAMES: readonly TenantName[] = ['TNT-A', 'TNT-B'];

// The fixture tenants are names, not UUIDs, so fixed UUIDs stand in for them.
export const TENANT_IDS: Readonly<Record<TenantName, string>> = {
  'TNT-A': '00000000-0000-4000-8000-00000000000a',
  'TNT-B': '00000000-0000-4000-8000-00000000000b',
};

export interface UnitFixture {
  id: string;
  code: string;
  name: string;
}

/** Synthetic organization units; the names are distinctive so a leak is easy to recognise. */
export const UNIT_FIXTURES: Readonly<Record<TenantName, readonly UnitFixture[]>> = {
  'TNT-A': [
    { id: '00000000-0000-4000-a001-000000000001', code: 'A-HQ', name: 'Sở Tài chính Alpha Đà Nẵng' },
    { id: '00000000-0000-4000-a001-000000000002', code: 'A-OPS', name: 'Phòng Vận hành Alpha' },
    { id: '00000000-0000-4000-a001-000000000003', code: 'A-AUD', name: 'Ban Kiểm toán Alpha' },
  ],
  'TNT-B': [
    { id: '00000000-0000-4000-b002-000000000001', code: 'B-HQ', name: 'Văn phòng Bí mật Beta Huế' },
    { id: '00000000-0000-4000-b002-000000000002', code: 'B-OPS', name: 'Phòng Dự án Beta' },
  ],
};

export interface RoleFixture {
  id: string;
  code: string;
  name: string;
}

/** Custom roles with distinctive names: the TNT-A role gives the test principal full rights, the TNT-B role must never show. */
export const ROLE_FIXTURES: Readonly<Record<TenantName, RoleFixture>> = {
  'TNT-A': { id: '00000000-0000-4000-a003-000000000001', code: 'ALPHA_ISOLATION_FULL', name: 'Vai trò Toàn quyền Alpha' },
  'TNT-B': { id: '00000000-0000-4000-b003-000000000001', code: 'BETA_SECRET_ROLE', name: 'Vai trò Bí mật Beta' },
};

/** The grant of the fixture role to the test membership in each tenant. */
export const GRANT_FIXTURES: Readonly<Record<TenantName, { id: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a004-000000000001' },
  'TNT-B': { id: '00000000-0000-4000-b004-000000000001' },
};

/** A second person with a membership in each tenant, with distinctive personal data that must never cross the boundary. */
export const MEMBERSHIP_FIXTURES: Readonly<Record<TenantName, { id: string; userId: string; displayName: string; email: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a007-000000000001', userId: '00000000-0000-4000-a008-000000000001', displayName: 'Nguyễn Alpha Công khai', email: 'alpha.member@example.test' },
  'TNT-B': { id: '00000000-0000-4000-b007-000000000001', userId: '00000000-0000-4000-b008-000000000001', displayName: 'Trần Beta Bí mật', email: 'beta.secret@example.test' },
};

/** The notification of the test membership in each tenant (an in-app notification about a project, with its workflow). */
export const NOTIFICATION_FIXTURES: Readonly<Record<TenantName, { id: string; workflowId: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a005-000000000001', workflowId: '00000000-0000-4000-a006-000000000001' },
  'TNT-B': { id: '00000000-0000-4000-b005-000000000001', workflowId: '00000000-0000-4000-b006-000000000001' },
};

/** An Active tenant-wide legal hold of each tenant (tenant administration data; the authority reference is confidential). */
export const LEGAL_HOLD_FIXTURES: Readonly<Record<TenantName, { id: string; authorityReference: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a009-000000000001', authorityReference: 'ALPHA-HOLD-REF-0001' },
  'TNT-B': { id: '00000000-0000-4000-b009-000000000001', authorityReference: 'BETA-SECRET-HOLD-REF-0001' },
};

/** A master record in force, its version and an open (draft) change request of each tenant; the business key and the label are distinctive. */
export const MASTER_FIXTURES: Readonly<Record<TenantName, { recordId: string; versionId: string; changeId: string; businessKey: string; label: string }>> = {
  'TNT-A': { recordId: '00000000-0000-4000-a010-000000000001', versionId: '00000000-0000-4000-a010-000000000002', changeId: '00000000-0000-4000-a010-000000000003', businessKey: 'ALPHA-SECTOR-0001', label: 'Alpha sector label' },
  'TNT-B': { recordId: '00000000-0000-4000-b010-000000000001', versionId: '00000000-0000-4000-b010-000000000002', changeId: '00000000-0000-4000-b010-000000000003', businessKey: 'BETA-SECTOR-0001', label: 'Beta sector label' },
};

/** A bulk import batch of each tenant, waiting for its review (the file hash and the object key are distinctive). */
export const MASTER_IMPORT_FIXTURES: Readonly<Record<TenantName, { id: string; fileSha256: string; fileObjectKey: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a011-000000000001', fileSha256: 'a3'.repeat(32), fileObjectKey: 'tenants/00000000-0000-4000-8000-00000000000a/import/alpha-catalogue-0001' },
  'TNT-B': { id: '00000000-0000-4000-b011-000000000001', fileSha256: 'b4'.repeat(32), fileObjectKey: 'tenants/00000000-0000-4000-8000-00000000000b/import/beta-catalogue-0001' },
};

/** An Active signing certificate of each tenant (its fingerprint and serial are distinctive; tenant administration data). */
export const CERTIFICATE_FIXTURES: Readonly<Record<TenantName, { id: string; fingerprint: string; serial: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a00e-000000000001', fingerprint: 'a1'.repeat(32), serial: 'ALPHA0C0E71F' },
  'TNT-B': { id: '00000000-0000-4000-b00e-000000000001', fingerprint: 'b2'.repeat(32), serial: 'BETA00C0E71F' },
};

/** A security policy draft of each tenant (the allowlist address is distinctive). */
export const POLICY_FIXTURES: Readonly<Record<TenantName, { id: string; address: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a00f-000000000001', address: '198.51.100.11' },
  'TNT-B': { id: '00000000-0000-4000-b00f-000000000001', address: '203.0.113.222' },
};

/** A number register and a stored document version of each tenant (the register code and the object key are distinctive). */
export const DOCUMENT_FIXTURES: Readonly<
  Record<TenantName, { registerId: string; registerCode: string; documentId: string; versionId: string; objectKey: string; layoutProfileId: string; outgoingId: string; sessionId: string }>
> = {
  'TNT-A': {
    registerId: '00000000-0000-4000-a00b-000000000001',
    registerCode: 'ALPHA-REGISTER-0001',
    documentId: '00000000-0000-4000-a00c-000000000001',
    versionId: '00000000-0000-4000-a00d-000000000001',
    objectKey: 'tenants/00000000-0000-4000-8000-00000000000a/documents/alpha-isolation-fixture.pdf',
    layoutProfileId: '00000000-0000-4000-a011-000000000001',
    outgoingId: '00000000-0000-4000-a012-000000000001',
    sessionId: '00000000-0000-4000-a013-000000000001',
  },
  'TNT-B': {
    registerId: '00000000-0000-4000-b00b-000000000001',
    registerCode: 'BETA-SECRET-REGISTER-0001',
    documentId: '00000000-0000-4000-b00c-000000000001',
    versionId: '00000000-0000-4000-b00d-000000000001',
    objectKey: 'tenants/00000000-0000-4000-8000-00000000000b/documents/beta-secret-isolation-fixture.pdf',
    layoutProfileId: '00000000-0000-4000-b011-000000000001',
    outgoingId: '00000000-0000-4000-b012-000000000001',
    sessionId: '00000000-0000-4000-b013-000000000001',
  },
};

/** An audit event of each tenant (planted by the seed; the trail itself is append-only). */
export const AUDIT_EVENT_FIXTURES: Readonly<Record<TenantName, { id: string; action: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a00a-000000000001', action: 'isolation.alpha.fixture' },
  'TNT-B': { id: '00000000-0000-4000-b00a-000000000001', action: 'isolation.beta.secret.fixture' },
};

/** The outcome of one request of a TNT-A user against a TNT-B object, of any operation and method. */
export interface ForeignAttempt {
  operation: string;
  status: number;
  body: string;
  /** The statuses that count as a safe answer: 404 unless the tenant plane has no business there at all (a control-plane operation: 403, or 404 where it is not registered). */
  expectedStatuses?: readonly number[];
  /** The answer must be an empty page (200 with an empty `items` list): an attempt that is refused and yields nothing. */
  mustBeEmpty?: boolean;
}

/**
 * One way of reading another tenant's data (API, database, later search, file, export, sync).
 * `readAs` makes the user of tenant `user` request the first organization unit of tenant `target`.
 * `listAs`, when present, lists every organization unit the user can see.
 */
export interface IsolationChannel {
  name: string;
  /**
   * What a safe answer to the foreign read looks like: `not-found` (the default) is 404; `empty` is for channels with no
   * single object to be missing (search, export): 200 with an empty `items` list, which must not differ in any way that
   * shows the hidden match.
   */
  foreignReadOutcome?: 'not-found' | 'empty';
  seed(tenant: TenantName): Promise<void>;
  readAs(user: 'TNT-A', target: 'TNT-B'): Promise<{ status: number; body: string }>;
  listAs?(user: 'TNT-A'): Promise<{ status: number; body: string }>;
  /**
   * Every id-bearing operation beyond the unit read (reads of other resources and all commands) aimed by `user`
   * at a TNT-B object it can name. Each must answer 404 and leave TNT-B untouched.
   */
  foreignAttempts?(user: 'TNT-A'): Promise<ForeignAttempt[]>;
}

export interface IsolationSuiteInput {
  channels: readonly IsolationChannel[];
  /** Implemented operations with a path parameter (see enumerateIdBearingOperations). */
  idBearingOperations: readonly string[];
  /** Operations that have a registered foreign-id case. */
  foreignIdCases: ReadonlySet<string>;
  /** A fingerprint of everything the suite seeded for a tenant; foreign attempts must not change TNT-B's. */
  snapshot?: (tenant: TenantName) => Promise<string>;
}

export interface IsolationReport {
  ok: boolean;
  /** Human-readable violations; they name the channel and the kind of data, never the data. */
  leaks: string[];
  /** Implemented id-bearing operations without a registered foreign-id case. */
  uncoveredOperations: string[];
}

/** Everything that identifies a tenant's data in a response body, grouped by kind. */
function markersOf(tenant: TenantName): Array<{ kind: string; value: string }> {
  const markers = [
    { kind: 'tenant id', value: TENANT_IDS[tenant] },
    { kind: 'role id', value: ROLE_FIXTURES[tenant].id },
    { kind: 'role code', value: ROLE_FIXTURES[tenant].code },
    { kind: 'role name', value: ROLE_FIXTURES[tenant].name },
    { kind: 'grant id', value: GRANT_FIXTURES[tenant].id },
    { kind: 'notification id', value: NOTIFICATION_FIXTURES[tenant].id },
    { kind: 'legal hold id', value: LEGAL_HOLD_FIXTURES[tenant].id },
    { kind: 'certificate id', value: CERTIFICATE_FIXTURES[tenant].id },
    { kind: 'certificate fingerprint', value: CERTIFICATE_FIXTURES[tenant].fingerprint },
    { kind: 'certificate serial', value: CERTIFICATE_FIXTURES[tenant].serial },
    { kind: 'security policy id', value: POLICY_FIXTURES[tenant].id },
    { kind: 'master record id', value: MASTER_FIXTURES[tenant].recordId },
    { kind: 'master version id', value: MASTER_FIXTURES[tenant].versionId },
    { kind: 'master change request id', value: MASTER_FIXTURES[tenant].changeId },
    { kind: 'master business key', value: MASTER_FIXTURES[tenant].businessKey },
    { kind: 'master label', value: MASTER_FIXTURES[tenant].label },
    { kind: 'master import id', value: MASTER_IMPORT_FIXTURES[tenant].id },
    { kind: 'master import file hash', value: MASTER_IMPORT_FIXTURES[tenant].fileSha256 },
    { kind: 'master import object key', value: MASTER_IMPORT_FIXTURES[tenant].fileObjectKey },
    { kind: 'security policy address', value: POLICY_FIXTURES[tenant].address },
    { kind: 'register id', value: DOCUMENT_FIXTURES[tenant].registerId },
    { kind: 'register code', value: DOCUMENT_FIXTURES[tenant].registerCode },
    { kind: 'document version id', value: DOCUMENT_FIXTURES[tenant].versionId },
    { kind: 'document object key', value: DOCUMENT_FIXTURES[tenant].objectKey },
    { kind: 'outgoing document id', value: DOCUMENT_FIXTURES[tenant].outgoingId },
    { kind: 'signing session id', value: DOCUMENT_FIXTURES[tenant].sessionId },
    { kind: 'audit event id', value: AUDIT_EVENT_FIXTURES[tenant].id },
    { kind: 'audit event action', value: AUDIT_EVENT_FIXTURES[tenant].action },
    { kind: 'legal hold authority reference', value: LEGAL_HOLD_FIXTURES[tenant].authorityReference },
    { kind: 'membership id', value: MEMBERSHIP_FIXTURES[tenant].id },
    { kind: 'member name', value: MEMBERSHIP_FIXTURES[tenant].displayName },
    { kind: 'member email', value: MEMBERSHIP_FIXTURES[tenant].email },
  ];
  for (const unit of UNIT_FIXTURES[tenant]) {
    markers.push({ kind: 'unit id', value: unit.id }, { kind: 'unit code', value: unit.code }, { kind: 'unit name', value: unit.name });
  }
  return markers;
}

function exposedKinds(body: string, tenant: TenantName): string[] {
  const haystack = body.toLowerCase();
  const kinds = markersOf(tenant)
    .filter((marker) => haystack.includes(marker.value.toLowerCase()))
    .map((marker) => marker.kind);
  return [...new Set(kinds)];
}

function isEmptyPage(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { items?: unknown };
    return Array.isArray(parsed.items) && parsed.items.length === 0;
  } catch {
    return false;
  }
}

function foreignReadLeaks(channel: IsolationChannel, result: { status: number; body: string }): string[] {
  const leaks: string[] = [];
  if (channel.foreignReadOutcome === 'empty') {
    if (result.status !== 200) leaks.push(`${channel.name}: foreign read answered ${result.status} instead of 200`);
    else if (!isEmptyPage(result.body)) leaks.push(`${channel.name}: foreign read did not come back empty`);
  } else if (result.status !== 404) {
    leaks.push(`${channel.name}: foreign id read answered ${result.status} instead of 404`);
  }
  for (const kind of exposedKinds(result.body, 'TNT-B')) leaks.push(`${channel.name}: foreign id read exposes a TNT-B ${kind}`);
  return leaks;
}

function foreignAttemptLeaks(channel: IsolationChannel, attempt: ForeignAttempt): string[] {
  const leaks: string[] = [];
  const accepted = attempt.expectedStatuses ?? [404];
  if (!accepted.includes(attempt.status)) leaks.push(`${channel.name}: foreign id ${attempt.operation} answered ${attempt.status} instead of ${accepted.join(' or ')}`);
  if (attempt.mustBeEmpty === true && !isEmptyPage(attempt.body)) leaks.push(`${channel.name}: foreign id ${attempt.operation} did not come back empty`);
  for (const kind of exposedKinds(attempt.body, 'TNT-B')) leaks.push(`${channel.name}: foreign id ${attempt.operation} exposes a TNT-B ${kind}`);
  return leaks;
}

function listLeaks(channel: IsolationChannel, result: { status: number; body: string }): string[] {
  const leaks: string[] = [];
  if (result.status !== 200) leaks.push(`${channel.name}: list answered ${result.status} instead of 200`);
  for (const kind of exposedKinds(result.body, 'TNT-B')) leaks.push(`${channel.name}: list exposes a TNT-B ${kind}`);
  for (const unit of UNIT_FIXTURES['TNT-A']) {
    if (!result.body.includes(unit.name)) leaks.push(`${channel.name}: list misses own unit ${unit.code}`);
  }
  return leaks;
}

/**
 * Runs the isolation conformance checks (ST-KERNEL-026) over every channel: a TNT-A user asking for a
 * TNT-B object by id must get 404 with a body free of TNT-B data, and a list must hold TNT-A rows only.
 * Commands and further reads must answer 404 too and leave the TNT-B snapshot unchanged.
 * It also requires a registered foreign-id case for every implemented id-bearing operation.
 * Violations are reported, never thrown, so a negative control can assert on them.
 */
export async function runIsolationSuite(input: IsolationSuiteInput): Promise<IsolationReport> {
  const leaks: string[] = [];
  for (const channel of input.channels) {
    for (const tenant of TENANT_NAMES) await channel.seed(tenant);
    leaks.push(...foreignReadLeaks(channel, await channel.readAs('TNT-A', 'TNT-B')));
    if (channel.listAs !== undefined) leaks.push(...listLeaks(channel, await channel.listAs('TNT-A')));
    if (channel.foreignAttempts !== undefined) {
      const before = await input.snapshot?.('TNT-B');
      for (const attempt of await channel.foreignAttempts('TNT-A')) leaks.push(...foreignAttemptLeaks(channel, attempt));
      if ((await input.snapshot?.('TNT-B')) !== before) leaks.push(`${channel.name}: foreign id attempts changed TNT-B data`);
    }
  }
  const uncoveredOperations = input.idBearingOperations.filter((operation) => !input.foreignIdCases.has(operation));
  return { ok: leaks.length === 0 && uncoveredOperations.length === 0, leaks, uncoveredOperations };
}
