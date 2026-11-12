import { describe, expect, it } from 'vitest';
import { holds } from './holds';

describe('holds', () => {
  it('holds a permission that the session lists', () => {
    expect(holds(['a.read', 'a.manage'], 'a.manage')).toBe(true);
  });

  it('does not hold a permission that the session does not list', () => {
    expect(holds(['a.read'], 'a.manage')).toBe(false);
    expect(holds([], 'a.manage')).toBe(false);
  });

  it('leaves the decision to the server when the session lists no permissions', () => {
    expect(holds(undefined, 'a.manage')).toBe(true);
  });
});
