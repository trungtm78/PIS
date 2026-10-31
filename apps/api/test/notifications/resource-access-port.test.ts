import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import type { EffectiveAccess, GrantView, Scope } from '@machvon/kernel';

const NOW = new Date('2026-10-23T08:00:00Z');
const PROJECT_A = '00000000-0000-4000-8000-0000000000a1';
const PROJECT_B = '00000000-0000-4000-8000-0000000000b1';
const CONTRACT_A = '00000000-0000-4000-8000-0000000000a2';
const UNIT_1 = '00000000-0000-4000-8000-0000000000e1';
const UNIT_2 = '00000000-0000-4000-8000-0000000000e2';

function access(scope: Scope, permissions: readonly string[] = ['project.read']): EffectiveAccess {
  const grant: GrantView = {
    roleCode: 'ROLE',
    rank: 30,
    permissions,
    scope,
    status: 'Active',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveUntil: null,
  };
  return { membershipId: 'm', scopeVersion: 1, membershipActive: true, grants: [grant] };
}

const port = new PermissionResourceAccess();

describe('PermissionResourceAccess', () => {
  it('lets a tenant-wide grant read any resource of the type, with or without scope information', () => {
    const tenant = access({ kind: 'TENANT' });
    expect(port.canRead(tenant, { type: 'project', id: PROJECT_A }, NOW)).toBe(true);
    expect(port.canRead(tenant, { type: 'project', id: PROJECT_A, projectId: PROJECT_B }, NOW)).toBe(true);
    expect(port.canRead(tenant, { type: 'report', id: PROJECT_A }, NOW)).toBe(false);
  });

  it('reads a data product with the right to read the catalogue of data, and with no right named after the type', () => {
    const catalog = access({ kind: 'TENANT' }, ['data.catalog.read']);
    expect(port.canRead(catalog, { type: 'data_product', id: PROJECT_A }, NOW)).toBe(true);
    expect(port.canRead(access({ kind: 'TENANT' }, ['data_product.read']), { type: 'data_product', id: PROJECT_A }, NOW)).toBe(false);
    expect(port.canRead(access({ kind: 'TENANT' }, ['project.read']), { type: 'data_product', id: PROJECT_A }, NOW)).toBe(false);
  });

  it('keeps a project-scoped grant to its own project and never pools it for another project', () => {
    const forA = access({ kind: 'PROJECT', refIds: [PROJECT_A] });
    expect(port.canRead(forA, { type: 'project', id: PROJECT_A, projectId: PROJECT_A }, NOW)).toBe(true);
    expect(port.canRead(forA, { type: 'project', id: PROJECT_B, projectId: PROJECT_B }, NOW)).toBe(false);
    // A resource of another type that carries a project id but no owner unit: the project grant matches only that project.
    const stages = access({ kind: 'PROJECT', refIds: [PROJECT_A] }, ['stage.read']);
    expect(port.canRead(stages, { type: 'stage', id: 'stage-1', projectId: PROJECT_A }, NOW)).toBe(true);
    expect(port.canRead(stages, { type: 'stage', id: 'stage-2', projectId: PROJECT_B }, NOW)).toBe(false);
    // The resource of type project is the project itself.
    expect(port.canRead(forA, { type: 'project', id: PROJECT_A }, NOW)).toBe(true);
    expect(port.canRead(forA, { type: 'project', id: PROJECT_B }, NOW)).toBe(false);
  });

  it('keeps a contract-scoped grant to its own contract', () => {
    const forContract = access({ kind: 'CONTRACT', refIds: [CONTRACT_A] }, ['contract.read']);
    expect(port.canRead(forContract, { type: 'contract', id: CONTRACT_A }, NOW)).toBe(true);
    expect(port.canRead(forContract, { type: 'contract', id: PROJECT_B, contractId: PROJECT_B }, NOW)).toBe(false);
    expect(port.canRead(forContract, { type: 'contract', id: CONTRACT_A, contractId: CONTRACT_A }, NOW)).toBe(true);
  });

  it('denies a unit-scoped grant when the owner unit of the resource is not known', () => {
    const subtree = access({ kind: 'UNIT_SUBTREE', refIds: [UNIT_1], paths: ['/1/'] });
    expect(port.canRead(subtree, { type: 'project', id: PROJECT_A }, NOW)).toBe(false);
    expect(port.canRead(subtree, { type: 'project', id: PROJECT_A, projectId: PROJECT_A }, NOW)).toBe(false);
    expect(port.canRead(access({ kind: 'UNIT_ONLY', refIds: [UNIT_1], paths: ['/1/'] }), { type: 'project', id: PROJECT_A }, NOW)).toBe(false);
  });

  it('applies a unit-scoped grant by the owner unit path, on whole path segments', () => {
    const subtree = access({ kind: 'UNIT_SUBTREE', refIds: [UNIT_1], paths: ['/1/'] });
    expect(port.canRead(subtree, { type: 'project', id: PROJECT_A, ownerUnitId: UNIT_2, ownerUnitPath: '/1/2/' }, NOW)).toBe(true);
    expect(port.canRead(subtree, { type: 'project', id: PROJECT_A, ownerUnitId: UNIT_2, ownerUnitPath: '/3/2/' }, NOW)).toBe(false);
    expect(port.canRead(subtree, { type: 'project', id: PROJECT_A, ownerUnitId: UNIT_2, ownerUnitPath: '/12/2/' }, NOW)).toBe(false);
  });

  it('denies an owner unit that is named without its path (the unit could not be resolved)', () => {
    const subtree = access({ kind: 'UNIT_SUBTREE', refIds: [UNIT_1], paths: ['/1/'] });
    expect(port.canRead(subtree, { type: 'project', id: PROJECT_A, ownerUnitId: UNIT_2 }, NOW)).toBe(false);
  });

  it('denies an inactive membership and a grant outside its window', () => {
    expect(port.canRead({ ...access({ kind: 'TENANT' }), membershipActive: false }, { type: 'project', id: PROJECT_A }, NOW)).toBe(false);
    const open = access({ kind: 'TENANT' });
    const lapsed = { ...open, grants: open.grants.map((grant) => ({ ...grant, effectiveUntil: new Date('2026-02-01T00:00:00Z') })) };
    expect(port.canRead(lapsed, { type: 'project', id: PROJECT_A }, NOW)).toBe(false);
  });
});
