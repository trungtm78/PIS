import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import {
  actionStatusLabel,
  planStatusLabel,
  portalErrorText,
  profileFactLabel,
  ownershipLabel,
  ratingLabel,
  reconfirmStateLabel,
  requestClockLabel,
  requestKindLabel,
  requestStatusLabel,
  subjectTypeLabel,
  triggerKindLabel,
} from './portal-labels';
import {
  ACTION_STATUSES,
  PLAN_STATUSES,
  PORTAL_DESTINATIONS,
  PROFILE_FACTS,
  RATINGS,
  RECONFIRM_STATES,
  REQUEST_CLOCKS,
  REQUEST_KINDS,
  REQUEST_STATUSES,
  SUBJECT_TYPES,
  TRIGGER_KINDS,
  actionsOwed,
  answeredLate,
  canRespond,
  isPortalCaller,
  planClosed,
  profileFacts,
  reconfirmAsked,
  requestClockOpen,
  responseRequestOf,
} from './portal-model';

describe('isPortalCaller', () => {
  it('is a contractor account when it holds the portal right and none of the staff rights of the register', () => {
    expect(isPortalCaller(['vnd.portal.read', 'vnd.portal.respond'])).toBe(true);
    expect(isPortalCaller(['vnd.portal.read', 'vnd.read'])).toBe(false);
    expect(isPortalCaller(['vnd.portal.read', 'vnd.portal.manage'])).toBe(false);
    expect(isPortalCaller(['contract.read'])).toBe(false);
    expect(isPortalCaller(undefined)).toBe(false);
  });
});

// The whitelist of the kernel (PORTAL_PROFILE_FIELDS) and the names it forbids (PORTAL_FORBIDDEN_FIELDS), written out because the web never imports the kernel.
const PORTAL_PROFILE_FIELDS: readonly string[] = ['id', 'legal_name', 'tax_identifier', 'verification_status', 'legal_rep_name', 'legal_rep_position', 'registered_address', 'phone', 'email', 'business_registration_no', 'ownership_declaration', 'next_review_due', 'profile_reviewed_at', 'version'];
const PORTAL_FORBIDDEN_FIELDS: readonly string[] = ['red_flag', 'red_flags', 'lead', 'leads', 'screening', 'screening_hit', 'screening_hits', 'risk_tier', 'risk_grade', 'party_link', 'party_links', 'link_cluster', 'investigation', 'duplicate_suggestions', 'internal_note', 'reviewer', 'other_contractors'];

describe('the whitelist of the profile', () => {
  it('draws only fields the kernel whitelist names, and none of the forbidden ones', () => {
    for (const fact of PROFILE_FACTS) expect(PORTAL_PROFILE_FIELDS).toContain(fact);
    for (const field of PORTAL_FORBIDDEN_FIELDS) expect(PROFILE_FACTS as readonly string[]).not.toContain(field);
  });

  it('keeps the facts in order, empty ones as none, and drops whatever else the payload carries', () => {
    const source = { id: 'x', legal_name: 'ABC', tax_identifier: '0101234561', phone: '', red_flag: 'SECRET', risk_tier: 'HIGH', version: 1 } as never;
    const facts = profileFacts(source);
    expect(facts.map((entry) => entry.fact)).toEqual([...PROFILE_FACTS]);
    expect(facts.find((entry) => entry.fact === 'legal_name')?.value).toBe('ABC');
    expect(facts.find((entry) => entry.fact === 'phone')?.value).toBeNull();
    expect(JSON.stringify(facts)).not.toContain('SECRET');
    expect(JSON.stringify(facts)).not.toContain('HIGH');
  });
});

describe('the rules of a request', () => {
  it('a request is answered while open (a returned one is open again) and a late answer is late', () => {
    expect(canRespond({ status: 'OPEN' })).toBe(true);
    expect(canRespond({ status: 'RESPONDED' })).toBe(false);
    expect(answeredLate({ response_late: true, clock: 'ANSWERED_LATE' })).toBe(true);
    expect(answeredLate({ response_late: false, clock: 'ANSWERED' })).toBe(false);
    expect(requestClockOpen('OVERDUE')).toBe(true);
    expect(requestClockOpen('ANSWERED_LATE')).toBe(false);
  });

  it('finds the open request that asks for the answer to an evaluation', () => {
    const open = [{ id: 'r1', status: 'OPEN' }, { id: 'r2', status: 'RESPONDED' }] as never[];
    expect(responseRequestOf({ open_request_id: 'r1' }, open)?.id).toBe('r1');
    expect(responseRequestOf({ open_request_id: 'r2' }, open)).toBeUndefined();
    expect(responseRequestOf({ open_request_id: null }, open)).toBeUndefined();
  });

  it('asks for a confirmation in every state but the current one; counts the actions a plan still owes', () => {
    expect(reconfirmAsked('CURRENT')).toBe(false);
    for (const state of RECONFIRM_STATES.filter((value) => value !== 'CURRENT')) expect(reconfirmAsked(state)).toBe(true);
    expect(actionsOwed({ actions: [{ status: 'OPEN' }, { status: 'DONE' }, { status: 'OPEN' }] } as never)).toBe(2);
    expect(planClosed('FAILED')).toBe(true);
    expect(planClosed('IN_PROGRESS')).toBe(false);
  });

  it('the navigation of the portal lists five destinations and nothing of the staff shell', () => {
    expect(PORTAL_DESTINATIONS.map((entry) => entry.id)).toEqual(['VND-16', 'VND-17', 'VND-18', 'VND-19', 'VND-24']);
  });
});

describe('the words of the closed lists', () => {
  const lists: Array<[string, readonly string[], (t: typeof translator.t, code: string) => string]> = [
    ['request kinds', REQUEST_KINDS, requestKindLabel],
    ['request statuses', REQUEST_STATUSES, requestStatusLabel],
    ['request clocks', REQUEST_CLOCKS, requestClockLabel],
    ['reconfirmation states', RECONFIRM_STATES, reconfirmStateLabel],
    ['plan statuses', PLAN_STATUSES, planStatusLabel],
    ['action statuses', ACTION_STATUSES, actionStatusLabel],
    ['ratings', RATINGS, ratingLabel],
    ['subject types', SUBJECT_TYPES, subjectTypeLabel],
    ['trigger kinds', TRIGGER_KINDS, triggerKindLabel],
    ['profile facts', PROFILE_FACTS, profileFactLabel],
    ['ownership declarations', ['OWNERS_LISTED', 'NO_OWNER_ABOVE_THRESHOLD'], ownershipLabel],
  ];
  for (const [name, codes, label] of lists) {
    it(`has words in both languages for every one of the ${name}`, () => {
      for (const code of codes) {
        translator.setLocale('vi');
        const vietnamese = label(translator.t, code);
        translator.setLocale('en');
        const english = label(translator.t, code);
        translator.setLocale('vi');
        expect(vietnamese).not.toMatch(/^vnp\./);
        expect(english).not.toMatch(/^vnp\./);
        expect(vietnamese.length).toBeGreaterThan(0);
        expect(english.length).toBeGreaterThan(0);
      }
    });
  }

  it('keeps the same keys in both catalogues for the portal', () => {
    const keys = (catalogue: Record<string, string>): string[] => Object.keys(catalogue).filter((key) => key.startsWith('vnp.')).sort();
    expect(keys(en)).toEqual(keys(vi));
    expect(keys(vi).length).toBeGreaterThan(250);
  });
});

describe('portalErrorText', () => {
  const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
  it('says the portal codes in the words of the portal and the rest in the common words', () => {
    translator.setLocale('vi');
    expect(portalErrorText(translator.t, problem(409, 'RECONFIRMATION_DECLARATION_STALE'))).toBe(vi['vnp.error.declarationStale.text']);
    expect(portalErrorText(translator.t, problem(403, 'PORTAL_CONTRACTOR_REQUIRED'))).toBe(vi['vnp.error.contractorRequired.text']);
    expect(portalErrorText(translator.t, problem(409, 'PORTAL_REQUEST_STATE_INVALID'))).toBe(vi['vnp.error.requestState.text']);
    expect(portalErrorText(translator.t, problem(409, 'REMEDIATION_STATE_INVALID'))).toBe(vi['vnp.error.planState.text']);
    expect(portalErrorText(translator.t, problem(409, 'VERSION_CONFLICT'))).toBe(vi['vnd.error.conflict.text']);
  });
});
