import { describe, expect, it } from 'vitest';
import { camel, defectsOf, figureOf, momentField, momentOf, profileBody, toAbsences, toCoverage, toDigest, toEscalations, toHealth, toPolicy, toProfile } from './model';
import { absenceRow, coverRow, coverageDto, digestDto, escalationRow, healthDto, policyParams, profileDto, rule } from './test-support';

describe('camel', () => {
  it('turns a code of the server into the last segment of a key', () => {
    expect(camel('NOT_CLAIMED')).toBe('notClaimed');
    expect(camel('EXPLANATION_CONCLUDE')).toBe('explanationConclude');
    expect(camel('OK')).toBe('ok');
  });
});

describe('figureOf', () => {
  it('never turns "no figure" into a zero', () => {
    expect(figureOf(null, 'HOURS')).toBeNull();
    expect(figureOf(0, 'HOURS')).toEqual({ number: '0', unit: 'HOURS' });
    expect(figureOf(12.345, 'PERCENT')?.number).toBe('12,35');
  });
});

describe('toHealth', () => {
  it('parses the fourteen indicators, the tables and the rule', () => {
    const health = toHealth(healthDto());
    expect(health?.kpis).toHaveLength(14);
    expect(health?.rule.version).toBe('builtin');
    expect(health?.stale).toBe(false);
  });

  it('refuses what is not the page: no indicators, no rule, not an object', () => {
    expect(toHealth(undefined)).toBeUndefined();
    expect(toHealth('x')).toBeUndefined();
    expect(toHealth({ ...healthDto(), kpis: [] })).toBeUndefined();
    expect(toHealth({ ...healthDto(), rule: null })).toBeUndefined();
  });

  it('keeps an indicator with no data as null and reads an unknown status as no data, never as fine', () => {
    const dto = healthDto() as { kpis: Array<Record<string, unknown>> };
    dto.kpis[0] = { ...dto.kpis[0], value: null, status: 'NO_DATA', note: 'NO_ESCALATIONS' };
    dto.kpis[1] = { ...dto.kpis[1], status: 'MYSTERY' };
    const health = toHealth(dto);
    expect(health?.kpis[0]).toMatchObject({ value: null, status: 'NO_DATA', note: 'NO_ESCALATIONS' });
    expect(health?.kpis[1]?.status).toBe('NO_DATA');
    expect(health?.kpis).toHaveLength(14);
  });
});

describe('toEscalations and toPolicy', () => {
  it('parses a page of levels and the policy from the rule', () => {
    const page = toEscalations({ items: [escalationRow('00000000-0000-4000-8000-00000000e001')], rule: rule({ params: policyParams() }), as_of: '2027-10-15T03:00:00.000Z' });
    expect(page?.items).toHaveLength(1);
    expect(page?.items[0]).toMatchObject({ kind: 'HIERARCHICAL', status: 'OPEN' });
    expect(page?.policy?.watchPromotion).toEqual({ enabled: true, afterWorkingDays: 20 });
  });

  it('drops a row of an unknown kind and has no policy when the rule has no numbers', () => {
    const page = toEscalations({ items: [escalationRow('00000000-0000-4000-8000-00000000e001', { kind: 'SIDEWAYS' })], rule: rule({ params: {} }), as_of: 'x' });
    expect(page?.items).toHaveLength(0);
    expect(page?.policy).toBeNull();
    expect(toPolicy({})).toBeNull();
  });

  it('refuses what is not a page', () => {
    expect(toEscalations(null)).toBeUndefined();
    expect(toEscalations({ items: 'x' })).toBeUndefined();
  });
});

describe('toProfile and profileBody', () => {
  it('parses what is own and what is the policy', () => {
    const view = toProfile(profileDto({ version: 3 }));
    expect(view?.version).toBe(3);
    expect(view?.profile.channels).toBeNull();
    expect(view?.effective.quiet).toEqual({ from: '21:00', to: '06:30', weekends: true, timeZone: 'Asia/Ho_Chi_Minh' });
    expect(view?.effective.own.channels).toBe(false);
  });

  it('refuses a profile without the effective values or without the rule', () => {
    expect(toProfile({ ...profileDto(), effective: null })).toBeUndefined();
    expect(toProfile({ ...profileDto(), rule: null })).toBeUndefined();
  });

  it('sends what was left on the policy as null and the quiet hours in the shape of the contract', () => {
    expect(profileBody({ channels: null, quiet: null, digestEnabled: true, digestAt: null, pushMinSeverity: null, pushCapPerDay: null, groupSameRoot: null })).toEqual({
      channels: null,
      quiet: null,
      digest_enabled: true,
      digest_at: null,
      push_min_severity: null,
      push_cap_per_day: null,
      group_same_root: null,
    });
    expect(profileBody({ channels: null, quiet: { from: '22:00', to: '06:00', weekends: false, timeZone: 'Asia/Ho_Chi_Minh' }, digestEnabled: false, digestAt: '08:00', pushMinSeverity: 'URGENT', pushCapPerDay: 2, groupSameRoot: false }).quiet).toEqual({
      from: '22:00',
      to: '06:00',
      weekends: false,
      time_zone: 'Asia/Ho_Chi_Minh',
    });
  });
});

describe('toDigest', () => {
  it('parses sections, lines with their consequence and where to act, and the stood-in person', () => {
    const digest = toDigest(digestDto());
    expect(digest?.sections.map((section) => section.code)).toEqual(['OVERDUE', 'DUE_SOON', 'NEW', 'ON_BEHALF']);
    expect(digest?.sections[0]?.lines[0]).toMatchObject({ consequence: 'The package cannot open the bidding.', action: { screen: 'BID-02', id: 'pkg-5' } });
    expect(digest?.sections[3]?.lines[0]?.onBehalfOf).toBe('Le Thi Other');
  });

  it('drops a section it does not know and refuses what has no sections', () => {
    const dto = digestDto() as { sections: unknown[] };
    expect(toDigest({ ...dto, sections: [...dto.sections, { code: 'MYSTERY', count: 1, lines: [] }] })?.sections).toHaveLength(4);
    expect(toDigest({})).toBeUndefined();
  });
});

describe('defectsOf', () => {
  it('lists the fields of a refusal and ignores what has no field', () => {
    expect(defectsOf({ defects: [{ field: 'quiet.to', code: 'SAME_TIME' }, { code: 'X' }, 'y'] })).toEqual([{ field: 'quiet.to', code: 'SAME_TIME' }]);
    expect(defectsOf({})).toEqual([]);
  });
});

describe('toAbsences and toCoverage', () => {
  it('parses absences with their covers and the covers waiting for a decision', () => {
    const page = toAbsences({ items: [absenceRow({ covers: [coverRow({ status: 'APPROVED', in_force: true })] })], pending_covers: [coverRow()], rule: rule({ params: {} }), as_of: '2027-10-15T03:00:00.000Z' });
    expect(page?.items[0]?.covers[0]).toMatchObject({ status: 'APPROVED', inForce: true, deputy: { name: 'Pham Deputy' } });
    expect(page?.pendingCovers).toHaveLength(1);
  });

  it('drops a cover of an unknown status, and refuses what is not a page', () => {
    const page = toAbsences({ items: [absenceRow({ covers: [coverRow({ status: 'MYSTERY' })] })], pending_covers: [], rule: rule({ params: {} }), as_of: 'x' });
    expect(page?.items[0]?.covers).toHaveLength(0);
    expect(toAbsences(null)).toBeUndefined();
  });

  it('parses the coverage report, with a percentage that may be missing', () => {
    expect(toCoverage(coverageDto())?.summary).toEqual({ backedUp: 0, total: 2, percent: 0 });
    expect(toCoverage(coverageDto({ summary: { backed_up: 0, total: 0, percent: null } }))?.summary.percent).toBeNull();
    expect(toCoverage(undefined)).toBeUndefined();
  });
});

describe('momentOf and momentField', () => {
  it('reads a local time as Vietnam time and writes it back the same', () => {
    expect(momentOf('2027-10-20T08:00')).toBe('2027-10-20T01:00:00.000Z');
    expect(momentField('2027-10-20T01:00:00.000Z')).toBe('2027-10-20T08:00');
  });

  it('refuses what is not a date and time', () => {
    expect(momentOf('')).toBeUndefined();
    expect(momentOf('2027-10-20')).toBeUndefined();
    expect(momentOf('2027-13-45T99:00')).toBeUndefined();
    expect(momentField('nope')).toBe('');
  });
});
