import { DomainError } from './errors.ts';
import { egpNameSimilarity } from './egp.ts';
import { foldForMatch } from './vendor-profile.ts';

/**
 * Continuous screening of the contractor registry against the lists of parties that may not be dealt with (VND-3, research V14; docs/vendor-investigation.md section 4). The list of the national procurement network comes in
 * through the file import path that already exists (`egp_record` of kind RESTRICTION); the lists of the multilateral banks and of politically exposed persons come in through a bulk import of entries with the source, the
 * as-of day and the reference. Matching is deterministic and explained: the tax code is decisive (the head of the code, so that a branch is found by its head office), a name alike is supporting and alone never above
 * "possible". A hit above the hold line puts a hold on the contractor: no new bid, result, contract or payment until a person decides (the gate refuses with 422 CONTRACTOR_SCREENING_HOLD). A person decides: confirm (which opens the
 * debarment case of VND-1 for a national record, so a ban is still decided by the authority on a decision paper) or dismiss with a reason. The screening never bans by itself and never merges.
 */

export const SCREENING_SOURCES = ['NATIONAL_DEBARMENT', 'WORLD_BANK', 'ADB', 'PEP', 'OTHER_LIST'] as const;
export type ScreeningSource = (typeof SCREENING_SOURCES)[number];
export const SCREENING_TRIGGERS = ['NIGHTLY', 'PROFILE_CHANGE', 'LIST_IMPORT', 'MANUAL'] as const;
export type ScreeningTrigger = (typeof SCREENING_TRIGGERS)[number];
export const MATCH_BASES = ['TAX_CODE', 'TAX_HEAD', 'NAME'] as const;
export type MatchBasis = (typeof MATCH_BASES)[number];

export interface ScreenedContractor {
  id: string;
  taxIdentifier: string;
  legalName: string;
}

export interface ListEntry {
  source: ScreeningSource;
  /** A key of the entry inside its source (for the national list: the record id). */
  ref: string;
  name: string | null;
  taxCode: string | null;
  validFrom: string | null;
  validUntil: string | null;
  /** A fingerprint of the row: a change of the entry is a new question for a person who dismissed a hit on it. */
  rowHash: string;
}

export interface ScreeningPolicy {
  weight_tax_code: number;
  weight_tax_head: number;
  weight_name: number;
  name_similarity_from_pct: number;
  hit_from: number;
  hold_from: number;
  /** A dismissed hit is asked again after this many days, or when the entry changed. */
  dismiss_valid_days: number;
  /** Whether a hold is put on a hit that matches an entry that is not yet in force (default: no, the alert only). */
  hold_not_yet_in_force: boolean;
  /** Calendar days a person has to decide a hit (the time the contractor is on hold counts against it; the indicator of the register measures it). */
  decide_within_days: number;
}

export interface ScreeningMatch {
  score: number;
  basis: MatchBasis[];
  similarity: number | null;
  inForce: boolean;
  /** The score is at or over the hold line and the entry is in force (or the rule holds those not yet in force too). */
  hold: boolean;
}

export const SCREENING_PARAM_DEFAULTS = {
  weight_tax_code: 100,
  weight_tax_head: 90,
  weight_name: 60,
  name_similarity_from_pct: 80,
  hit_from: 45,
  hold_from: 90,
  dismiss_valid_days: 365,
  hold_not_yet_in_force: false,
  decide_within_days: 5,
} as const;

export function screeningPolicyOf(params: unknown): ScreeningPolicy {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw bad('params');
  const record = params as Record<string, unknown>;
  const whole = (field: string, min: number, max: number): number => {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  const policy: ScreeningPolicy = {
    weight_tax_code: whole('weight_tax_code', 0, 100),
    weight_tax_head: whole('weight_tax_head', 0, 100),
    weight_name: whole('weight_name', 0, 100),
    name_similarity_from_pct: whole('name_similarity_from_pct', 1, 100),
    hit_from: whole('hit_from', 1, 100),
    hold_from: whole('hold_from', 1, 100),
    dismiss_valid_days: whole('dismiss_valid_days', 1, 3650),
    hold_not_yet_in_force: record.hold_not_yet_in_force === true,
    decide_within_days: whole('decide_within_days', 1, 90),
  };
  if (typeof record.hold_not_yet_in_force !== 'boolean') throw bad('hold_not_yet_in_force');
  if (policy.hold_from < policy.hit_from) throw bad('hold_from');
  // A name alone must never put a hold: the weight of the name stays under the hold line.
  if (policy.weight_name >= policy.hold_from) throw bad('weight_name');
  return policy;
}

/** The ten digit head of a tax code (a branch `0123456789-001` has the head of its head office), or none. */
export function taxHeadOf(code: string | null): string | null {
  if (code === null) return null;
  const match = /^(\d{10})(?:-?\d{3})?$/.exec(code.replace(/\s+/g, ''));
  return match === null ? null : (match[1] as string);
}

/** The phrases and the words that a company form adds to a name and that say nothing about who it is. A phrase is taken out whole (`cong ty` is a form, but `cong` alone is a word of many names). */
const FORM_PHRASES = ['cong ty', 'co phan', 'trach nhiem huu han', 'mot thanh vien', 'doanh nghiep tu nhan', 'tu nhan', 'joint stock company', 'limited company', 'one member'];
const FORM_WORDS = new Set(['tnhh', 'mtv', 'cp', 'jsc', 'ltd', 'llc', 'inc', 'corp', 'company', 'limited']);

/** A name folded for comparison with the words of the company form taken out, so that "Cong ty TNHH ABC" and "ABC" are alike. */
export const matchNameOf = (name: string): string => {
  let folded = ` ${foldForMatch(name)} `;
  for (const phrase of FORM_PHRASES) folded = folded.split(` ${phrase} `).join(' ');
  return folded
    .split(' ')
    .filter((word) => word !== '' && !FORM_WORDS.has(word))
    .join(' ');
};

/** The match of a contractor against an entry of a list, on a day: the score and why. Never null; a score of 0 is no match. */
export function matchEntry(contractor: ScreenedContractor, entry: ListEntry, today: string, policy: ScreeningPolicy): ScreeningMatch {
  const basis: MatchBasis[] = [];
  let score = 0;
  const own = contractor.taxIdentifier.replace(/\s+/g, '');
  const theirs = entry.taxCode?.replace(/\s+/g, '') ?? null;
  if (theirs !== null && own === theirs) {
    basis.push('TAX_CODE');
    score = Math.max(score, policy.weight_tax_code);
  } else if (taxHeadOf(own) !== null && taxHeadOf(own) === taxHeadOf(theirs)) {
    basis.push('TAX_HEAD');
    score = Math.max(score, policy.weight_tax_head);
  }
  let similarity: number | null = null;
  if (entry.name !== null && matchNameOf(entry.name) !== '' && matchNameOf(contractor.legalName) !== '') {
    similarity = egpNameSimilarity(matchNameOf(contractor.legalName), matchNameOf(entry.name));
    if (similarity * 100 >= policy.name_similarity_from_pct) {
      basis.push('NAME');
      score = Math.max(score, basis.length === 1 ? Math.round(policy.weight_name * similarity) : score);
    }
  }
  const inForce = (entry.validFrom === null || entry.validFrom <= today) && (entry.validUntil === null || entry.validUntil >= today);
  // An entry that has ended never holds; one that has not started holds only when the rule says so.
  const notYetInForce = entry.validFrom !== null && entry.validFrom > today;
  return { score, basis, similarity, inForce, hold: score >= policy.hold_from && (inForce || (policy.hold_not_yet_in_force && notYetInForce)) };
}

/** Whether a match is a hit at all: at or over the line that is worth a person's time. */
export const isHit = (match: ScreeningMatch, policy: Pick<ScreeningPolicy, 'hit_from'>): boolean => match.score >= policy.hit_from;

/** The best match of a contractor over a list of entries that are hits, strongest first, one per entry. */
export function screenContractor(contractor: ScreenedContractor, entries: readonly ListEntry[], today: string, policy: ScreeningPolicy): Array<{ entry: ListEntry; match: ScreeningMatch }> {
  return entries
    .map((entry) => ({ entry, match: matchEntry(contractor, entry, today, policy) }))
    .filter((found) => isHit(found.match, policy))
    .sort((x, y) => y.match.score - x.match.score || (x.entry.source + x.entry.ref < y.entry.source + y.entry.ref ? -1 : 1));
}

// -- The hit ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const HIT_STATUSES = ['PENDING', 'CONFIRMED', 'DISMISSED', 'RESOLVED'] as const;
export type HitStatus = (typeof HIT_STATUSES)[number];
export const HIT_MOVES = ['CONFIRM', 'DISMISS', 'RESOLVE', 'REOPEN'] as const;
export type HitMove = (typeof HIT_MOVES)[number];

const HIT_STEPS: Readonly<Record<HitMove, { from: readonly HitStatus[]; to: HitStatus; reason: boolean }>> = {
  CONFIRM: { from: ['PENDING'], to: 'CONFIRMED', reason: false },
  DISMISS: { from: ['PENDING'], to: 'DISMISSED', reason: true },
  // The system resolves a confirmed hit when the case it opened has a decision, or a pending hit whose entry left the list.
  RESOLVE: { from: ['PENDING', 'CONFIRMED'], to: 'RESOLVED', reason: false },
  // The system asks again when the entry changed or the dismissal ran out.
  REOPEN: { from: ['DISMISSED', 'RESOLVED'], to: 'PENDING', reason: false },
};

/** The status after a move. Dismissing needs a reason of 20 characters (a hit on a tax code is not waved away with a word); 409 SCREENING_HIT_STATE_INVALID when the move does not start from the status. */
export function nextHitStatus(current: HitStatus, move: HitMove, reason?: string | null): HitStatus {
  const step = HIT_STEPS[move];
  if (!step.from.includes(current)) throw new DomainError('SCREENING_HIT_STATE_INVALID', 409, 'status');
  if (step.reason && (reason === undefined || reason === null || reason.trim().length < 20)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  return step.to;
}

/** Whether a dismissed hit is asked again: the entry changed (a new row hash), or the dismissal is older than the rule allows. */
export function dismissalExpired(dismissed: { rowHash: string; decidedOn: string }, entryRowHash: string, today: string, validDays: number): boolean {
  if (dismissed.rowHash !== entryRowHash) return true;
  return (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dismissed.decidedOn}T00:00:00Z`)) / 86_400_000 >= validDays;
}

/** Whether a pending or confirmed hit holds the contractor now: the hold is the hit's own, and it stops when the person decides (dismiss) or the case it opened is decided (resolve). */
export const holdsContractor = (hit: { status: HitStatus; hold: boolean }): boolean => hit.hold && (hit.status === 'PENDING' || hit.status === 'CONFIRMED');
