import { MODULES, OPERATIONS, PERMISSIONS } from '@machvon/contracts';
import { supportPermissions } from '@machvon/kernel';
import { SUPPORT_OPERATIONS } from '../src/support-gate';

/** The resources no grant reaches on purpose: the audit trail of the tenant, the devices of a person, the internals of the platform, the proposals of a plan and the record of the tenant itself. */
const KEPT_FROM_EVERY_GRANT = new Set(['proposal', 'device_registration', 'outbox_event', 'audit_event', 'tenant']);

describe('what a support access grant can reach (ST-SAS-015)', () => {
  it('places every resource read in a module, except the few that no grant may reach', () => {
    const unplaced = Object.keys(PERMISSIONS)
      .filter((id) => id.startsWith('get_resources_'))
      .filter((id) => (MODULES as Readonly<Record<string, string>>)[id] === undefined)
      .map((id) => (PERMISSIONS as Readonly<Record<string, string>>)[id]?.split('.')[0] ?? '');
    expect(new Set(unplaced)).toEqual(KEPT_FROM_EVERY_GRANT);
  });

  it('knows the method of every operation of the contract, so a read-only grant can tell a read from a write', () => {
    expect(SUPPORT_OPERATIONS.length).toBe(Object.keys(PERMISSIONS).length);
    expect(Object.keys(OPERATIONS).length).toBe(SUPPORT_OPERATIONS.length);
    const read = SUPPORT_OPERATIONS.find((operation) => operation.id === 'get_resources_project');
    expect(read).toMatchObject({ module: 'PRJ', method: 'get', plane: 'tenant', stepUp: false });
  });

  it('gives a read-only grant of a module nothing that writes, and never what the tenant approves for itself, the control plane or a second factor', () => {
    const readOnly = supportPermissions(SUPPORT_OPERATIONS, ['SAS'], 'READ_ONLY');
    const readWrite = supportPermissions(SUPPORT_OPERATIONS, ['SAS', 'ADM'], 'READ_WRITE');
    expect(readOnly).toContain('support_access_grant.read');
    const writes = new Set(SUPPORT_OPERATIONS.filter((operation) => operation.method !== 'get').map((operation) => operation.permission));
    // A permission that a read shares with a write (one permission for both) can be in the list; a permission only a write needs cannot.
    const reads = new Set(SUPPORT_OPERATIONS.filter((operation) => operation.method === 'get').map((operation) => operation.permission));
    expect(readOnly.every((permission) => reads.has(permission))).toBe(true);
    expect(writes.size).toBeGreaterThan(0);
    for (const permissions of [readOnly, readWrite]) {
      expect(permissions.some((permission) => permission.startsWith('tenant.support.') || permission.startsWith('system.'))).toBe(false);
    }
    const stepUp = new Set(SUPPORT_OPERATIONS.filter((operation) => operation.stepUp).map((operation) => operation.permission));
    expect(readWrite.filter((permission) => stepUp.has(permission) && !SUPPORT_OPERATIONS.some((operation) => operation.permission === permission && !operation.stepUp && operation.module !== undefined && ['SAS', 'ADM'].includes(operation.module)))).toEqual([]);
  });
});
