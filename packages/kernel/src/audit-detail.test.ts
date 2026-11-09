import {
  AUDIT_DETAIL_DEFAULT_BYTES,
  PERSONAL_VALUE,
  REDACTED_VALUE,
  TRUNCATED_VALUE,
  auditDetailChangedPaths,
  auditDetailMatches,
  auditDetailPolicyFindings,
  auditDetailRef,
  prepareAuditDetail,
} from './audit-detail.ts';
import type { AuditDetailPolicy } from './audit-detail.ts';

const policy = (overrides: Partial<AuditDetailPolicy> = {}): AuditDetailPolicy => ({ enabled: true, maxBytes: AUDIT_DETAIL_DEFAULT_BYTES, sensitiveKeys: [], ...overrides });

describe('prepareAuditDetail', () => {
  it('keeps the full before and after of a business object', () => {
    const before = { period: '2026-10', figures: [{ project: 'P1', planned: '1000000', actual: '250000' }], status: 'OPEN' };
    const after = { period: '2026-10', figures: [{ project: 'P1', planned: '1000000', actual: '300000' }], status: 'CLOSED' };
    const out = prepareAuditDetail({ before, after }, policy());
    expect(out.before).toEqual(before);
    expect(out.after).toEqual(after);
    expect(out.redactedPaths).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it('redacts secrets by key at every depth and by the shape of the value', () => {
    const out = prepareAuditDetail(
      { before: null, after: { api_key: 'k', nested: { list: [{ Password: 'p', note: 'ok' }], header: 'Bearer abcdefghijkl' }, jwt: 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl' } },
      policy(),
    );
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/abcdefghijkl|c2lnbmF0dXJl/);
    expect(out.redactedPaths).toEqual(['after.api_key', 'after.jwt', 'after.nested.header', 'after.nested.list[0].Password']);
    expect((out.after as { nested: { list: Array<{ note: string }> } }).nested.list[0]?.note).toBe('ok');
  });

  it('redacts the keys the tenant adds, whatever the case', () => {
    const out = prepareAuditDetail({ after: { Bank_PIN: '1234', amount: '5' } }, policy({ sensitiveKeys: ['bank_pin'] }));
    expect(out.after).toEqual({ Bank_PIN: REDACTED_VALUE, amount: '5' });
  });

  it('replaces the personal facts and keeps empty ones empty', () => {
    const out = prepareAuditDetail({ after: { phone: '0900000000', cccd: null, name: 'Project office' } }, policy());
    expect(out.after).toEqual({ phone: PERSONAL_VALUE, cccd: null, name: 'Project office' });
    expect(out.redactedPaths).toEqual(['after.phone']);
  });

  it('holds the byte cap by dropping the largest subtrees first and says which', () => {
    const big = 'x'.repeat(3000);
    const out = prepareAuditDetail({ before: { small: 'a', big }, after: { small: 'b', other: 'y'.repeat(2000) } }, policy({ maxBytes: 1024 }));
    expect(out.bytes).toBeLessThanOrEqual(1024);
    expect(out.truncated).toBe(true);
    expect(out.droppedPaths).toEqual(['after.other', 'before.big']);
    expect(out.before).toEqual({ small: 'a', big: TRUNCATED_VALUE });
  });

  it('falls back to markers when many small members do not fit', () => {
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`k${index}`, index]));
    const out = prepareAuditDetail({ before: many, after: many }, policy({ maxBytes: 1024 }));
    expect(out.bytes).toBeLessThanOrEqual(1024);
    expect(out.truncated).toBe(true);
  });

  it('is deterministic: key order does not change the hash', () => {
    const a = prepareAuditDetail({ after: { b: 1, a: { d: 2, c: 3 } } }, policy());
    const b = prepareAuditDetail({ after: { a: { c: 3, d: 2 }, b: 1 } }, policy());
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent: preparing a prepared detail changes nothing', () => {
    const once = prepareAuditDetail({ before: { token: 't' }, after: { phone: '1' } }, policy());
    const twice = prepareAuditDetail({ before: once.before, after: once.after }, policy());
    expect(twice.sha256).toBe(once.sha256);
  });

  it('never leaves a sensitive key unredacted (property over generated shapes)', () => {
    const keys = ['token', 'Secret', 'x_password', 'ApiKey', 'private-key', 'authorization'];
    for (let seed = 1; seed <= 60; seed += 1) {
      const key = keys[seed % keys.length] as string;
      const value = { a: { [key]: `v${seed}`, list: [{ [key]: seed }, 1] }, [key]: { deep: seed } };
      const out = prepareAuditDetail({ after: value }, policy());
      expect(JSON.stringify(out.after)).not.toContain(`v${seed}`);
      expect(JSON.stringify(out.after)).not.toContain('deep');
    }
  });

  it('the hash in the ref matches the stored detail and fails when the detail changes', () => {
    const out = prepareAuditDetail({ before: { n: 1 }, after: { n: 2 } }, policy());
    const ref = auditDetailRef(out);
    expect(auditDetailMatches({ before: out.before, after: out.after }, ref)).toBe(true);
    expect(auditDetailMatches({ before: out.before, after: { n: 3 } }, ref)).toBe(false);
    expect(ref.bytes).toBe(out.bytes);
  });
});

describe('auditDetailChangedPaths', () => {
  it('lists the paths whose value differs, including added and removed members', () => {
    expect(auditDetailChangedPaths({ a: 1, b: { c: 2, d: 3 }, list: [1, 2] }, { a: 1, b: { c: 9 }, e: 4, list: [1, 2, 3] })).toEqual(['b.c', 'b.d', 'e', 'list[2]']);
    expect(auditDetailChangedPaths(null, { a: 1 })).toEqual(['(value)']);
  });
});

describe('auditDetailPolicyFindings', () => {
  const valid = { resourceType: 'period_snapshot', maxBytes: 16384, sensitiveKeys: ['pin'], reason: 'Required by HT.06' };
  it('accepts a valid policy', () => expect(auditDetailPolicyFindings(valid)).toEqual([]));
  it('names every broken field', () => {
    const found = auditDetailPolicyFindings({ resourceType: 'Bad Type', maxBytes: 10, sensitiveKeys: ['a b'], reason: 'no' });
    expect(found.map((f) => f.code).sort()).toEqual(['MAX_BYTES_RANGE', 'REASON_REQUIRED', 'RESOURCE_TYPE_FORMAT', 'SENSITIVE_KEY_FORMAT']);
  });
});
