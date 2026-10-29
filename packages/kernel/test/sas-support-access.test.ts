import { describe, expect, it } from '@jest/globals';
import { approvalPatch, assertRevocable, isSupportGrantLive, reachesResource, supportPermissions, supportRequestDefects, supportStatusAt } from '../src/index.ts';
import type { SupportGrantFacts, SupportOperation } from '../src/index.ts';

const NOW = new Date('2026-10-30T03:00:00Z');
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const ALICE = '22222222-2222-4222-8222-222222222222';
const BOB = '33333333-3333-4333-8333-333333333333';
const minutes = (n: number): Date => new Date(NOW.getTime() + n * 60_000);

const requested = (overrides: Partial<SupportGrantFacts> = {}): SupportGrantFacts => ({
  status: 'Requested',
  accessMode: 'READ_ONLY',
  operatorId: OPERATOR,
  ownerApprovedBy: null,
  secondApproverId: null,
  durationMinutes: 60,
  requestedAt: NOW,
  startsAt: null,
  expiresAt: minutes(60),
  revokedAt: null,
  ...overrides,
});

describe('the request for support access (ST-SAS-015)', () => {
  const good = { ticketReference: 'SUP-2026-000123', modules: ['CTR', 'DOC'], resourceIds: [], accessMode: 'READ_ONLY', durationMinutes: 60, reason: 'The customer cannot open a contract' };

  it('accepts a ticket, modules, a mode, 15 to 480 minutes and a reason of ten characters', () => {
    expect(supportRequestDefects(good)).toEqual([]);
    expect(supportRequestDefects({ ...good, durationMinutes: 15 })).toEqual([]);
    expect(supportRequestDefects({ ...good, durationMinutes: 480 })).toEqual([]);
  });

  it('refuses 600 minutes, fewer than 15, a fraction, no module, a repeated module, a mode that does not exist, a short reason and a ticket that is not one', () => {
    for (const [bad, field] of [
      [{ durationMinutes: 600 }, 'duration_minutes'],
      [{ durationMinutes: 14 }, 'duration_minutes'],
      [{ durationMinutes: 30.5 }, 'duration_minutes'],
      [{ modules: [] }, 'scope.modules'],
      [{ modules: ['CTR', 'ctr'] }, 'scope.modules'],
      [{ modules: ['not a module'] }, 'scope.modules'],
      [{ accessMode: 'WRITE' }, 'access_mode'],
      [{ reason: ' too short ' }, 'reason'],
      [{ ticketReference: '  ' }, 'ticket_reference'],
      [{ resourceIds: ['not-a-uuid'] }, 'scope.resource_ids'],
    ] as const) {
      expect(supportRequestDefects({ ...good, ...bad })).toEqual([field]);
    }
  });
});

describe('the approval of a grant', () => {
  it('lets one person of the tenant approve a read: it is Active at once, for what was asked and no more', () => {
    const patch = approvalPatch(requested(), ALICE, NOW);
    expect(patch).toEqual({ status: 'Active', ownerApprovedBy: ALICE, secondApproverId: null, startsAt: NOW, expiresAt: minutes(60) });
  });

  it('starts the access when the approver says, at most a week ahead, and never in the past', () => {
    expect(approvalPatch(requested(), ALICE, NOW, minutes(30))).toMatchObject({ status: 'Approved', startsAt: minutes(30), expiresAt: minutes(90) });
    expect(approvalPatch(requested(), ALICE, NOW, minutes(-30))).toMatchObject({ status: 'Active', startsAt: NOW });
    expect(() => approvalPatch(requested(), ALICE, NOW, new Date(NOW.getTime() + 8 * 86_400_000))).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }));
  });

  it('holds a write until a second person, other than the first, approves; only then is it in force', () => {
    const first = approvalPatch(requested({ accessMode: 'READ_WRITE' }), ALICE, NOW);
    expect(first).toEqual({ status: 'Requested', ownerApprovedBy: ALICE, secondApproverId: null, startsAt: null, expiresAt: null });
    const oneApproval = requested({ accessMode: 'READ_WRITE', ownerApprovedBy: ALICE });
    expect(isSupportGrantLive(oneApproval, NOW)).toBe(false);
    expect(() => approvalPatch(oneApproval, ALICE, NOW)).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED', status: 403 }));
    expect(approvalPatch(oneApproval, BOB, NOW)).toEqual({ status: 'Active', ownerApprovedBy: ALICE, secondApproverId: BOB, startsAt: NOW, expiresAt: minutes(60) });
  });

  it('is refused to the operator themselves and to a grant that is not waiting for it', () => {
    expect(() => approvalPatch(requested(), OPERATOR, NOW)).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED', status: 403 }));
    for (const status of ['Approved', 'Active', 'Expired', 'Revoked', 'Rejected'] as const) {
      expect(() => approvalPatch(requested({ status }), ALICE, NOW)).toThrow(expect.objectContaining({ code: 'SUPPORT_GRANT_INVALID', status: 409 }));
    }
  });

  it('lapses a request nobody decided on within a week, and caps a window at eight hours', () => {
    const old = requested({ requestedAt: new Date(NOW.getTime() - 8 * 86_400_000) });
    expect(supportStatusAt(old, NOW)).toBe('Expired');
    expect(() => approvalPatch(old, ALICE, NOW)).toThrow(expect.objectContaining({ code: 'SUPPORT_GRANT_INVALID' }));
    expect(approvalPatch(requested({ durationMinutes: 9999 }), ALICE, NOW).expiresAt).toEqual(new Date(NOW.getTime() + 8 * 3_600_000));
  });
});

describe('a grant in force', () => {
  const active = (overrides: Partial<SupportGrantFacts> = {}): SupportGrantFacts => requested({ status: 'Active', ownerApprovedBy: ALICE, startsAt: NOW, expiresAt: minutes(60), ...overrides });

  it('lets the operator in from its start until its end, not at the end', () => {
    expect(isSupportGrantLive(active(), NOW)).toBe(true);
    expect(isSupportGrantLive(active(), minutes(59))).toBe(true);
    expect(isSupportGrantLive(active(), minutes(60))).toBe(false);
    expect(isSupportGrantLive(active({ status: 'Approved', startsAt: minutes(10) }), NOW)).toBe(false);
  });

  it('does not let anyone in once it is revoked, or when a write has one approval only', () => {
    expect(isSupportGrantLive(active({ revokedAt: NOW }), NOW)).toBe(false);
    expect(isSupportGrantLive(active({ accessMode: 'READ_WRITE' }), NOW)).toBe(false);
    expect(isSupportGrantLive(active({ accessMode: 'READ_WRITE', secondApproverId: ALICE }), NOW)).toBe(false);
    expect(isSupportGrantLive(active({ accessMode: 'READ_WRITE', secondApproverId: BOB }), NOW)).toBe(true);
  });

  it('is shown Expired once its end has come, and revoked only while it is open', () => {
    expect(supportStatusAt(active(), minutes(61))).toBe('Expired');
    expect(supportStatusAt(active({ status: 'Approved', startsAt: minutes(10) }), minutes(11))).toBe('Active');
    for (const status of ['Requested', 'Approved', 'Active'] as const) expect(() => assertRevocable({ status })).not.toThrow();
    for (const status of ['Expired', 'Revoked', 'Rejected'] as const) expect(() => assertRevocable({ status })).toThrow(expect.objectContaining({ code: 'SUPPORT_GRANT_INVALID', status: 409 }));
  });
});

describe('what a grant gives', () => {
  const op = (id: string, permission: string, module: string | undefined, method: string, extra: Partial<SupportOperation> = {}): SupportOperation => ({ id, permission, module, method, plane: 'tenant', stepUp: false, ...extra });
  const operations = [
    op('getContract', 'contract.read', 'CTR', 'GET'),
    op('approveContract', 'contract.approve', 'CTR', 'POST'),
    op('getDocument', 'doc.read', 'DOC', 'GET'),
    op('listBids', 'bid.read', 'BID', 'GET'),
    op('approveSupport', 'tenant.support.approve', 'SAS', 'POST'),
    op('exportAuditLog', 'audit.export', 'ADM', 'POST'),
    op('searchGlobal', 'search.use', 'ADM', 'GET'),
    op('exportTenant', 'tenant.export', 'ADM', 'POST'),
    op('getHome', 'home.read', 'ADM', 'GET'),
    op('pullSync', 'sync.pull', 'ADM', 'GET'),
    op('listAuditEvents', 'audit.read', 'ADM', 'GET'),
    op('getAuditEvent', 'audit_event.read', 'ADM', 'GET'),
    op('suspendTenant', 'system.tenant.manage', 'SAS', 'POST', { plane: 'control' }),
    op('grantRole', 'iam.role.grant', 'ADM', 'POST', { stepUp: true }),
    op('untagged', 'misc.read', undefined, 'GET'),
  ];

  it('is the reads of the modules named for a read-only grant', () => {
    expect(supportPermissions(operations, ['CTR', 'DOC'], 'READ_ONLY')).toEqual(['contract.read', 'doc.read']);
  });

  it('adds the writes of those modules for a read-write grant, and never what the tenant approves for itself, the control plane or a step-up', () => {
    // The audit trail of the tenant, its reads and its export, is not given by any grant.
    expect(supportPermissions(operations, ['ctr', 'SAS', 'ADM'], 'READ_WRITE')).toEqual(['contract.approve', 'contract.read']);
    expect(supportPermissions(operations, ['ADM'], 'READ_ONLY')).toEqual([]);
  });

  it('reaches a request by the resource it names when the grant names resources, and anything of the module when it names none', () => {
    const id = '44444444-4444-4444-8444-444444444444';
    expect(reachesResource(`/contracts/${id}?expand=lines`, [id])).toBe(true);
    expect(reachesResource('/contracts', [id])).toBe(false);
    expect(reachesResource('/contracts/55555555-5555-4555-8555-555555555555', [id])).toBe(false);
    expect(reachesResource('/contracts', [])).toBe(true);
  });
});
