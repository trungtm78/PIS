import { describe, expect, it } from 'vitest';
import { holdsOnWholeTenant, toGrantAuthority } from './national-code-import-model';

const PERMISSION = 'project.national_code.manage';
const grant = (overrides: Record<string, unknown> = {}) => ({ scope_kind: 'TENANT', state: 'ACTIVE', permissions: [PERMISSION], ...overrides });

describe('toGrantAuthority: the grants of the caller, read defensively', () => {
  it('keeps the scope, the state and the permissions of each grant, and leaves out what is not text', () => {
    expect(toGrantAuthority({ grants: [grant(), grant({ scope_kind: 'UNIT_SUBTREE', state: 'FUTURE', permissions: ['project.*', 7] }), 'junk', null] })).toEqual([
      { scopeKind: 'TENANT', state: 'ACTIVE', permissions: [PERMISSION] },
      { scopeKind: 'UNIT_SUBTREE', state: 'FUTURE', permissions: ['project.*'] },
      { scopeKind: '', state: '', permissions: [] },
      { scopeKind: '', state: '', permissions: [] },
    ]);
    expect(toGrantAuthority(undefined)).toEqual([]);
    expect(toGrantAuthority({ grants: 'none' })).toEqual([]);
  });
});

describe('holdsOnWholeTenant: whether a grant in force on the whole tenant carries the permission', () => {
  const authority = (...grants: Array<Record<string, unknown>>) => toGrantAuthority({ grants });

  it('accepts the exact name and a prefix pattern, on the whole tenant, in force', () => {
    expect(holdsOnWholeTenant(authority(grant()), PERMISSION)).toBe(true);
    expect(holdsOnWholeTenant(authority(grant({ permissions: ['project.*'] })), PERMISSION)).toBe(true);
  });

  it('refuses a grant on a unit, on a project, one that is not in force, one that lacks the permission, and patterns that match nothing', () => {
    expect(holdsOnWholeTenant(authority(grant({ scope_kind: 'UNIT_SUBTREE' })), PERMISSION)).toBe(false);
    expect(holdsOnWholeTenant(authority(grant({ scope_kind: 'PROJECT' })), PERMISSION)).toBe(false);
    expect(holdsOnWholeTenant(authority(grant({ state: 'EXPIRED' })), PERMISSION)).toBe(false);
    expect(holdsOnWholeTenant(authority(grant({ state: 'FUTURE' })), PERMISSION)).toBe(false);
    expect(holdsOnWholeTenant(authority(grant({ permissions: ['project.read'] })), PERMISSION)).toBe(false);
    expect(holdsOnWholeTenant(authority(grant({ permissions: ['*', '', 'project.national_code.*x', 'projects.*'] })), PERMISSION)).toBe(false);
    expect(holdsOnWholeTenant([], PERMISSION)).toBe(false);
  });
});
