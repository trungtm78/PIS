import { CAPACITY_CLASSES, capacityAlert, capacityKindOf, evaluateCapacity, logCapFindings, planArchive } from './log-capacity.ts';
import type { LogCapPolicy, LogReading } from './log-capacity.ts';
import { TECHNICAL_CLASSES } from './retention.ts';

const policy = (overrides: Partial<LogCapPolicy> = {}): LogCapPolicy => ({ recordClass: 'outbox_event', maxRows: 1000, maxBytes: null, warnPct: 80, ...overrides });
const reading = (overrides: Partial<LogReading> = {}): LogReading => ({ recordClass: 'outbox_event', rows: 500, bytes: 500_000, bytesEstimated: false, eligibleRows: 500, protectedRows: 0, ...overrides });

describe('log classes', () => {
  it('has every technical class and the two monitor-only classes of the audit trail', () => {
    expect([...CAPACITY_CLASSES].sort()).toEqual([...TECHNICAL_CLASSES, 'audit_event', 'audit_event_detail'].sort());
    expect(capacityKindOf('audit_event')).toBe('MONITOR_ONLY');
    expect(capacityKindOf('outbox_event')).toBe('TECHNICAL');
    expect(capacityKindOf('project_dossier')).toBeUndefined();
  });
});

describe('evaluateCapacity', () => {
  it('is UNCAPPED without a limit', () => expect(evaluateCapacity({ maxRows: null, maxBytes: null, warnPct: 80 }, reading()).state).toBe('UNCAPPED'));
  it('is OK below the warning share, NEAR from it, OVER above the cap', () => {
    expect(evaluateCapacity(policy(), reading({ rows: 799 })).state).toBe('OK');
    expect(evaluateCapacity(policy(), reading({ rows: 800 })).state).toBe('NEAR');
    expect(evaluateCapacity(policy(), reading({ rows: 1000 })).state).toBe('NEAR');
    expect(evaluateCapacity(policy(), reading({ rows: 1001 })).state).toBe('OVER');
  });
  it('lets the larger share of rows and bytes decide', () => {
    const both = policy({ maxRows: 1000, maxBytes: 10_000_000 });
    const found = evaluateCapacity(both, reading({ rows: 100, bytes: 9_500_000 }));
    expect(found.binding).toBe('BYTES');
    expect(found.state).toBe('NEAR');
    expect(found.bytesPct).toBe(95);
  });
  it('counts the excess', () => {
    const found = evaluateCapacity(policy(), reading({ rows: 1250 }));
    expect(found.excessRows).toBe(250);
  });
});

describe('planArchive', () => {
  it('does nothing while a class is within its cap', () => expect(planArchive(policy(), reading({ rows: 1000 }))).toEqual({ action: 'NONE', rows: 0 }));

  it('archives down to the low-water mark of the cap', () => {
    expect(planArchive(policy(), reading({ rows: 1100, eligibleRows: 1100 }))).toEqual({ action: 'ARCHIVE_THEN_PURGE', rows: 200 });
  });

  it('never takes more than the eligible rows (nothing younger than the platform minimum period)', () => {
    expect(planArchive(policy(), reading({ rows: 1100, eligibleRows: 40 }))).toEqual({ action: 'ARCHIVE_THEN_PURGE', rows: 40 });
    expect(planArchive(policy(), reading({ rows: 1100, eligibleRows: 0 }))).toEqual({ action: 'NOTHING_ELIGIBLE', rows: 0 });
  });

  it('sizes by bytes at the average row size when the size cap decides', () => {
    const p = policy({ maxRows: null, maxBytes: 10_000_000 });
    const out = planArchive(p, reading({ rows: 2000, bytes: 12_000_000, eligibleRows: 2000 }));
    // target 9,000,000 bytes: remove 3,000,000 bytes at 6,000 bytes a row
    expect(out).toEqual({ action: 'ARCHIVE_THEN_PURGE', rows: 500 });
  });

  it('never purges a monitor-only class, however far over its cap', () => {
    for (const recordClass of ['audit_event', 'audit_event_detail']) {
      expect(planArchive(policy({ recordClass, maxRows: 10 }), reading({ recordClass, rows: 100_000, eligibleRows: 100_000 }))).toEqual({ action: 'MONITOR_ONLY', rows: 0 });
    }
  });

  it('never asks for more rows than exist (property over many readings)', () => {
    for (let rows = 0; rows <= 5000; rows += 137) {
      const out = planArchive(policy({ maxRows: 1000 }), reading({ rows, eligibleRows: rows }));
      expect(out.rows).toBeLessThanOrEqual(rows);
      if (rows > 1000) expect(rows - out.rows).toBe(900);
    }
  });
});

describe('capacityAlert', () => {
  it('raises NEAR from the warning share and EXCEEDED when the run could not bring the class back', () => {
    const near = evaluateCapacity(policy(), reading({ rows: 850 }));
    expect(capacityAlert(near, { action: 'NONE', rows: 0 })).toBe('LOG_CAPACITY_NEAR');
    const over = evaluateCapacity(policy(), reading({ rows: 1500 }));
    expect(capacityAlert(over, { action: 'NOTHING_ELIGIBLE', rows: 0 })).toBe('LOG_CAPACITY_EXCEEDED');
    expect(capacityAlert(over, { action: 'MONITOR_ONLY', rows: 0 })).toBe('LOG_CAPACITY_EXCEEDED');
    expect(capacityAlert(over, { action: 'ARCHIVE_THEN_PURGE', rows: 600 })).toBe('LOG_CAPACITY_NEAR');
    expect(capacityAlert(evaluateCapacity(policy(), reading({ rows: 10 })), { action: 'NONE', rows: 0 })).toBeUndefined();
  });
});

describe('logCapFindings', () => {
  it('accepts a valid cap', () => expect(logCapFindings(policy({ maxBytes: 5_000_000 }), 'Capacity plan 2026', 100)).toEqual([]));
  it('refuses a cap with no limit, an unknown class, a bad share and a missing reason', () => {
    const found = logCapFindings(policy({ recordClass: 'project_dossier', maxRows: null, maxBytes: null, warnPct: 20 }), '', 0);
    expect(found.map((f) => f.code).sort()).toEqual(['CLASS_UNKNOWN', 'NO_LIMIT', 'REASON_REQUIRED', 'WARN_RANGE']);
  });
  it('refuses a row cap below what the platform minimum period keeps, for a technical class only', () => {
    expect(logCapFindings(policy({ maxRows: 50 }), 'Capacity plan', 100).map((f) => f.code)).toEqual(['BELOW_PROTECTED_ROWS']);
    expect(logCapFindings(policy({ recordClass: 'audit_event', maxRows: 50 }), 'Capacity plan', 100)).toEqual([]);
  });
  it('refuses a size cap under one MiB', () => {
    expect(logCapFindings(policy({ maxRows: null, maxBytes: 1000 }), 'Capacity plan', 0).map((f) => f.code)).toEqual(['BYTES_RANGE']);
  });
});
