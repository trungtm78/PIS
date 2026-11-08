import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { diffEgpRecords, egpObligationClock } from '../src/egp.ts';
import type { EgpClock } from '../src/egp.ts';
import {
  EGP_OBLIGATION_FACTS,
  EGP_POSTING_RECEIPT_EVIDENCE,
  EGP_RECONCILE_RULE_CODE,
  EGP_RECONCILE_RULE_TYPE,
  EGP_SEVERITY_RULE_CODE,
  EGP_SEVERITY_RULE_TYPE,
  egpDifferenceFingerprint,
  egpNoticeMilestones,
  egpOnTime,
  egpPostingFacet,
  egpReconcileParamsOf,
  egpResultMilestones,
  egpSeverityParamsOf,
  egpTriggerInstant,
} from '../src/egp-posting.ts';
import { evidenceKindOf } from '../src/bid-workflow.ts';
import { defaultGovernanceRule, registerIntegrationRules } from '../src/governance-rules.ts';

const failure = (run: () => unknown): { code?: unknown; detail?: unknown } => {
  try {
    run();
  } catch (error) {
    return error as { code?: unknown; detail?: unknown };
  }
  return {};
};

const HOUR = 3_600_000;
const clock = (status: EgpClock['status'], msToDue: number | null = null): EgpClock => ({ status, dueAt: '2026-11-20T10:00:00.000Z', msToDue });

describe('severity by the time that is left (rule EGP_POSTING_SEVERITY)', () => {
  it('reads urgent_within_hours and refuses anything else with the name of the field', () => {
    expect(egpSeverityParamsOf({ urgent_within_hours: 24 })).toEqual({ urgent_within_hours: 24 });
    expect(egpSeverityParamsOf({ urgent_within_hours: 0 })).toEqual({ urgent_within_hours: 0 });
    for (const bad of [undefined, -1, 721, 1.5, '24', null]) {
      expect(failure(() => egpSeverityParamsOf({ urgent_within_hours: bad }))).toMatchObject({ code: 'GOVERNANCE_RULE_PARAMS_INVALID', detail: 'urgent_within_hours' });
    }
  });

  it('is registered with a default flagged UNVERIFIED, a formula and a source', () => {
    registerIntegrationRules();
    const found = defaultGovernanceRule(EGP_SEVERITY_RULE_TYPE, EGP_SEVERITY_RULE_CODE);
    expect(found?.params).toEqual({ urgent_within_hours: 24 });
    expect(found?.unverified).toBe(true);
    expect(found?.provenance?.formula).toContain('urgent_within_hours');
  });

  it('is overdue past the deadline, urgent inside the line, to be acted on before it, and none when nothing is asked', () => {
    const params = { urgent_within_hours: 24 };
    expect(egpPostingFacet(clock('OVERDUE', -HOUR), params)).toBe('OVERDUE');
    expect(egpPostingFacet(clock('DUE_SOON', 24 * HOUR), params)).toBe('DUE_SOON_URGENT');
    expect(egpPostingFacet(clock('DUE_SOON', 24 * HOUR + 1), params)).toBe('DUE_SOON');
    expect(egpPostingFacet(clock('DUE_SOON', 2 * HOUR), { urgent_within_hours: 0 })).toBe('DUE_SOON');
    for (const status of ['ON_TIME', 'MET', 'MET_LATE', 'CANCELLED'] as const) expect(egpPostingFacet(clock(status), params)).toBeUndefined();
  });

  it('follows a real clock: the facet moves from DUE_SOON to the urgent one to OVERDUE as the day comes', () => {
    const obligation = { state: 'DUE' as const, dueAt: '2026-11-20T10:00:00.000Z', submittedAt: null, remindBeforeDays: 2 };
    const at = (iso: string): string | undefined => egpPostingFacet(egpObligationClock(obligation, new Date(iso)), { urgent_within_hours: 24 });
    expect(at('2026-11-10T00:00:00Z')).toBeUndefined();
    expect(at('2026-11-18T11:00:00Z')).toBe('DUE_SOON');
    expect(at('2026-11-19T11:00:00Z')).toBe('DUE_SOON_URGENT');
    expect(at('2026-11-20T10:00:01Z')).toBe('OVERDUE');
  });
});

describe('the figure "posted on time"', () => {
  it('counts MET over MET, MET_LATE and OVERDUE, rounds down, and says nothing when nothing was judged', () => {
    expect(egpOnTime([])).toEqual({ met: 0, metLate: 0, overdue: 0, rateBp: null });
    expect(egpOnTime([clock('ON_TIME'), clock('DUE_SOON'), clock('CANCELLED')]).rateBp).toBeNull();
    expect(egpOnTime([clock('MET'), clock('MET'), clock('MET_LATE'), clock('OVERDUE'), clock('ON_TIME')])).toEqual({ met: 2, metLate: 1, overdue: 1, rateBp: 5000 });
    expect(egpOnTime([clock('MET'), clock('MET'), clock('MET_LATE')]).rateBp).toBe(6666);
    expect(egpOnTime([clock('MET')]).rateBp).toBe(10_000);
  });
});

describe('the facts that open an obligation', () => {
  it('names one kind for each fact, once', () => {
    expect(EGP_OBLIGATION_FACTS.map((entry) => entry.kind)).toEqual(['PLAN', 'RESULT', 'CONTRACT_INFO', 'CONTRACTOR_PERFORMANCE', 'VIOLATION']);
    expect(new Set(EGP_OBLIGATION_FACTS.map((entry) => entry.fact)).size).toBe(EGP_OBLIGATION_FACTS.length);
  });

  it('opens by hand on a real day that is not in the future, as the first instant of that day in Vietnam', () => {
    const now = new Date('2026-11-08T05:00:00Z');
    expect(egpTriggerInstant('2026-11-05', now)).toBe('2026-11-04T17:00:00.000Z');
    expect(egpTriggerInstant('05/11/2026', now)).toBe('2026-11-04T17:00:00.000Z');
    for (const bad of ['2026-02-30', '2026-11-09', 'yesterday', '', '2026-11-05T10:00:00Z']) {
      expect(failure(() => egpTriggerInstant(bad, now))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'triggered_on' });
    }
  });

  it('registers the evidence kind of the receipt, taken from outside', () => {
    expect(evidenceKindOf(EGP_POSTING_RECEIPT_EVIDENCE)).toMatchObject({ source: 'EXTERNAL_RECEIPT', module: 'BID' });
  });
});

describe('the milestones that an imported notice and result state', () => {
  const notice = { noticeKind: 'INVITATION', publishedAt: '2026-03-01T01:00:00.000Z', bidClosingAt: '2026-03-20T03:00:00.000Z', bidOpeningAt: '2026-03-20T03:30:00.000Z' };

  it('gives the publication, the closing and the opening of an invitation, and nothing for a modification or a cancellation', () => {
    expect(egpNoticeMilestones(notice)).toEqual([
      { kind: 'INVITATION_PUBLISHED', at: notice.publishedAt },
      { kind: 'BID_CLOSING', at: notice.bidClosingAt },
      { kind: 'BID_OPENING', at: notice.bidOpeningAt },
    ]);
    expect(egpNoticeMilestones({ ...notice, bidClosingAt: null, bidOpeningAt: null })).toEqual([{ kind: 'INVITATION_PUBLISHED', at: notice.publishedAt }]);
    expect(egpNoticeMilestones({ ...notice, noticeKind: 'MODIFICATION' })).toEqual([]);
    expect(egpNoticeMilestones({ ...notice, noticeKind: 'CANCELLATION' })).toEqual([]);
  });

  it('gives the publication of a result and its approval day as the first instant of that day in Vietnam, and nothing for a cancelled one', () => {
    const result = { resultKind: 'AWARDED', publishedAt: '2026-04-02T02:00:00.000Z', approvedOn: '2026-04-01' };
    expect(egpResultMilestones(result)).toEqual([
      { kind: 'RESULT_PUBLISHED', at: result.publishedAt },
      { kind: 'RESULT_APPROVED', at: '2026-03-31T17:00:00.000Z' },
    ]);
    expect(egpResultMilestones({ ...result, approvedOn: null })).toEqual([{ kind: 'RESULT_PUBLISHED', at: result.publishedAt }]);
    expect(egpResultMilestones({ ...result, resultKind: 'NO_QUALIFIED_BID' })).toHaveLength(2);
    expect(egpResultMilestones({ ...result, resultKind: 'CANCELLED' })).toEqual([]);
  });
});

describe('the fingerprint of a difference', () => {
  const difference = diffEgpRecords('PACKAGE', { estimated_price: '1000', package_name: 'Road' }, { estimated_price: '1200', package_name: 'road' })[0] as ReturnType<typeof diffEgpRecords>[number];

  it('is the same for the same statement and moves with any figure, field, subject or kind', () => {
    const base = egpDifferenceFingerprint('PACKAGE', 'PK-1', difference);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(egpDifferenceFingerprint('PACKAGE', 'PK-1', { ...difference })).toBe(base);
    expect(egpDifferenceFingerprint('PACKAGE', 'PK-2', difference)).not.toBe(base);
    expect(egpDifferenceFingerprint('NOTICE', 'PK-1', difference)).not.toBe(base);
    expect(egpDifferenceFingerprint('PACKAGE', 'PK-1', { ...difference, theirs: '1300' })).not.toBe(base);
    expect(egpDifferenceFingerprint('PACKAGE', 'PK-1', { ...difference, ours: '999' })).not.toBe(base);
    expect(egpDifferenceFingerprint('PACKAGE', 'PK-1', { ...difference, field: 'package_name' })).not.toBe(base);
    expect(egpDifferenceFingerprint('PACKAGE', 'PK-1', { ...difference, kind: 'MISSING_OURS' })).not.toBe(base);
  });

  it('tells a missing value from an empty text', () => {
    const missing = egpDifferenceFingerprint('PACKAGE', 'PK-1', { field: 'f', kind: 'MISSING_OURS', ours: null, theirs: 'x' });
    expect(egpDifferenceFingerprint('PACKAGE', 'PK-1', { field: 'f', kind: 'MISSING_OURS', ours: '', theirs: 'x' })).not.toBe(missing);
  });
});

describe('the outbound module opens no connection', () => {
  it('reads no file, calls no fetch and imports nothing but sibling modules', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'egp-posting.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/from\s+'node:/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|require\s*\(|import\s*\(/);
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] as string);
    expect(imports.filter((specifier) => !specifier.startsWith('./'))).toEqual([]);
  });

  it('runs every function with the ways out of the machine replaced by ones that fail, and none is called', () => {
    const spies = [jest.spyOn(globalThis, 'fetch'), jest.spyOn(net, 'connect'), jest.spyOn(http, 'request'), jest.spyOn(https, 'request'), jest.spyOn(dns, 'lookup')];
    for (const spy of spies) spy.mockImplementation(() => {
      throw new Error('network call attempted');
    });
    try {
      const now = new Date('2026-11-08T05:00:00Z');
      egpTriggerInstant('2026-11-05', now);
      egpPostingFacet(clock('DUE_SOON', HOUR), { urgent_within_hours: 24 });
      egpOnTime([clock('MET')]);
      egpNoticeMilestones({ noticeKind: 'INVITATION', publishedAt: now.toISOString(), bidClosingAt: null, bidOpeningAt: null });
      egpResultMilestones({ resultKind: 'AWARDED', publishedAt: now.toISOString(), approvedOn: '2026-11-05' });
      egpDifferenceFingerprint('PACKAGE', 'k', { field: 'f', kind: 'VALUE_MISMATCH', ours: 'a', theirs: 'b' });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('the due time of a reconciliation item (rule EGP_RECONCILIATION_POLICY)', () => {
  it('reads due_in_working_days and refuses anything else with the name of the field', () => {
    expect(egpReconcileParamsOf({ due_in_working_days: 10 })).toEqual({ due_in_working_days: 10 });
    for (const bad of [undefined, 0, 366, 2.5, '10']) {
      expect(failure(() => egpReconcileParamsOf({ due_in_working_days: bad }))).toMatchObject({ code: 'GOVERNANCE_RULE_PARAMS_INVALID', detail: 'due_in_working_days' });
    }
  });

  it('is registered with a default flagged UNVERIFIED', () => {
    registerIntegrationRules();
    const found = defaultGovernanceRule(EGP_RECONCILE_RULE_TYPE, EGP_RECONCILE_RULE_CODE);
    expect(found?.params).toEqual({ due_in_working_days: 10 });
    expect(found?.unverified).toBe(true);
    expect(found?.provenance?.formula).toContain('due_in_working_days');
  });
});
