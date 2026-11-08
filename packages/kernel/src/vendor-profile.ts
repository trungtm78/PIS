import { createHash } from 'node:crypto';
import { hasControlChar } from './control-chars.ts';
import { DomainError } from './errors.ts';
import { egpNameSimilarity } from './egp.ts';

/**
 * The master profile of a contractor (VND-1, research V1; docs/vendor-management.md section 2). Pure rules: the form of the tax code and its check digit, the normal form of an address, a telephone number and an
 * e-mail address (so that two records of one party are found without the words of a person being compared by eye), how complete a profile is, and how likely two contractors are one party. A signal is a hint for a
 * person who decides in master data (MDM F5); nothing here merges, rejects or blocks by itself, and a name is never an identity.
 */

const TAX_CODE = /^(\d{10})(?:-?(\d{3}))?$/;
/** The weights of the usual check of a ten digit tax code (first nine digits, the tenth is the check digit). The algorithm is common knowledge, not in the legal sources read: its result is a signal, never a refusal. */
const TAX_CODE_WEIGHTS = [31, 29, 23, 21, 19, 17, 13, 7, 5, 3] as const;

export type TaxCodeFormat = 'VALID' | 'INVALID';
export type TaxCodeChecksum = 'MATCH' | 'MISMATCH' | 'NOT_CHECKED';

export interface TaxCodeCheck {
  format: TaxCodeFormat;
  /** The code as it is kept: ten digits, or ten digits, a hyphen and three digits for a branch; absent when the format is invalid. */
  normalised: string | null;
  /** The ten digit head of the code (the legal entity), absent when the format is invalid. */
  head: string | null;
  branch: string | null;
  checksum: TaxCodeChecksum;
  /** The check digit rule is not confirmed against an official text: every answer that rests on it says so. */
  checksumLegalStatus: 'UNVERIFIED';
}

/** The weighted sum rule: the check digit is `10 - (sum mod 11)` taken modulo 10 over the first nine digits and the weights `31 29 23 21 19 17 13 7 5`, compared with the tenth digit. */
export function taxCodeChecksumOf(head: string): TaxCodeChecksum {
  if (!/^\d{10}$/.test(head)) return 'NOT_CHECKED';
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number(head[index]) * (TAX_CODE_WEIGHTS[index] as number);
  const expected = (10 - (sum % 11)) % 10;
  return expected === Number(head[9]) ? 'MATCH' : 'MISMATCH';
}

/** Judges a tax code: its form (decisive for storing it) and its check digit (a signal for the person who verifies it). */
export function checkTaxCode(raw: string): TaxCodeCheck {
  const match = TAX_CODE.exec(raw.replace(/\s+/g, ''));
  if (match === null) return { format: 'INVALID', normalised: null, head: null, branch: null, checksum: 'NOT_CHECKED', checksumLegalStatus: 'UNVERIFIED' };
  const head = match[1] as string;
  const branch = match[2] ?? null;
  return { format: 'VALID', normalised: branch === null ? head : `${head}-${branch}`, head, branch, checksum: taxCodeChecksumOf(head), checksumLegalStatus: 'UNVERIFIED' };
}

/** A text folded for comparison: no diacritics, lower case, single spaces, only letters and digits. */
export function foldForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** An address in the form two records are compared in (folded); an address of fewer than 8 characters after folding says too little to compare and gives none. */
export function normaliseAddress(value: string): string | null {
  const folded = foldForMatch(value);
  return folded.length < 8 ? null : folded;
}

/** A telephone number as digits with the leading +84 written as 0; 9 to 11 digits, else none. */
export function normalisePhoneNumber(value: string): string | null {
  const compact = value.replace(/[\s.()-]/g, '');
  const local = compact.startsWith('+84') ? `0${compact.slice(3)}` : compact;
  return /^\d{9,11}$/.test(local) ? local : null;
}

const EMAIL = /^[a-z0-9._%+-]{1,64}@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

/** An e-mail address in lower case with its domain; none when it is not an address. */
export function normaliseEmail(value: string): { address: string; domain: string } | null {
  const address = value.trim().toLowerCase();
  const match = EMAIL.exec(address);
  return match === null ? null : { address, domain: match[1] as string };
}

/** The key of a normalised value in the table of matches: SHA-256 in hexadecimal. It is a key for equality and carries no secret; the personal fields themselves (the identity number, the account) use the blind index of the field cipher. */
export const matchKeyOf = (normalised: string): string => createHash('sha256').update(normalised, 'utf8').digest('hex');

// -- Completeness (V1: representative, address, owner before a bid) -------------------------------------------------------------------------------------------------------------------------------

export const PROFILE_FIELDS = ['LEGAL_REPRESENTATIVE', 'REGISTERED_ADDRESS', 'CONTACT', 'BUSINESS_REGISTRATION', 'OWNERSHIP'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export const OWNERSHIP_DECLARATIONS = ['OWNERS_LISTED', 'NO_OWNER_ABOVE_THRESHOLD'] as const;
export type OwnershipDeclaration = (typeof OWNERSHIP_DECLARATIONS)[number];

export interface ProfileFacts {
  legalRepName: string | null;
  registeredAddress: string | null;
  phone: string | null;
  email: string | null;
  businessRegistrationNo: string | null;
  ownerCount: number;
  ownershipDeclaration: OwnershipDeclaration | null;
}

export interface ProfileCoverage {
  present: ProfileField[];
  missing: ProfileField[];
  /** Whole percent of the fields the policy asks for that are present (100 when it asks for none). */
  coveragePct: number;
  /** Every field the policy asks for is present. */
  complete: boolean;
}

const filled = (value: string | null): boolean => value !== null && value.trim() !== '';

/** Whether each field is present: the representative and the address by name, the contact by a telephone number or an e-mail address, the ownership by at least one owner or a declaration that nobody holds more than the threshold. */
export function profileFieldState(facts: ProfileFacts): Readonly<Record<ProfileField, boolean>> {
  return {
    LEGAL_REPRESENTATIVE: filled(facts.legalRepName),
    REGISTERED_ADDRESS: filled(facts.registeredAddress),
    CONTACT: filled(facts.phone) || filled(facts.email),
    BUSINESS_REGISTRATION: filled(facts.businessRegistrationNo),
    OWNERSHIP: facts.ownerCount > 0 || facts.ownershipDeclaration === 'NO_OWNER_ABOVE_THRESHOLD',
  };
}

/** How complete a profile is against the fields a policy asks for (rule `VENDOR_PROFILE`, `required_before_bid`); the fields the policy does not ask for are shown as present or missing but do not count. */
export function profileCoverage(facts: ProfileFacts, required: readonly ProfileField[]): ProfileCoverage {
  const state = profileFieldState(facts);
  const present = PROFILE_FIELDS.filter((field) => state[field]);
  const missing = PROFILE_FIELDS.filter((field) => !state[field] && required.includes(field));
  const asked = required.length;
  const have = required.filter((field) => state[field]).length;
  return { present, missing, coveragePct: asked === 0 ? 100 : Math.round((have * 100) / asked), complete: missing.length === 0 };
}

// -- Owners -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const OWNER_KINDS = ['PERSON', 'ORGANISATION'] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number];
export const CONTROL_BASES = ['SHARE_CAPITAL', 'VOTING_RIGHTS', 'APPOINTS_MANAGEMENT', 'OTHER_CONTROL'] as const;
export type ControlBasis = (typeof CONTROL_BASES)[number];

export interface OwnerFacts {
  kind: OwnerKind;
  name: string;
  /** Percent held, 0 to 100 with two decimals, absent when the owner has control without a share. */
  sharePct: string | null;
  beneficialOwner: boolean;
  controlBasis: ControlBasis | null;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** Checks the owners as a set: a name each, no control character, a share between 0 and 100, a share held by a beneficial owner at or over the threshold or a basis for control, and the shares not adding up to more than a whole. */
export function assertOwnersCoherent(owners: readonly OwnerFacts[]): void {
  let total = 0;
  owners.forEach((owner, index) => {
    const at = `owners[${index}]`;
    if (!OWNER_KINDS.includes(owner.kind)) throw invalid(`${at}.kind`);
    const name = owner.name.trim();
    if (name === '' || name.length > 300 || hasControlChar(name)) throw invalid(`${at}.name`);
    if (owner.sharePct !== null) {
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(owner.sharePct) || Number(owner.sharePct) > 100) throw invalid(`${at}.share_pct`);
      total += Math.round(Number(owner.sharePct) * 100);
    }
    if (owner.sharePct === null && owner.controlBasis === null) throw invalid(`${at}.control_basis`);
    if (owner.controlBasis !== null && !CONTROL_BASES.includes(owner.controlBasis)) throw invalid(`${at}.control_basis`);
  });
  if (total > 10_000) throw invalid('owners.share_pct');
}

// -- Duplicates (V1: same tax code, address, telephone, representative ... give a suggestion for MDM) ----------------------------------------------------------------------------------------

export const DUPLICATE_SIGNALS = ['TAX_HEAD', 'ADDRESS', 'PHONE', 'EMAIL', 'LEGAL_REPRESENTATIVE', 'OWNER', 'BANK_ACCOUNT', 'NAME'] as const;
export type DuplicateSignal = (typeof DUPLICATE_SIGNALS)[number];

/** The weight of each signal in the score (whole points) and the score from which a pair is suggested for a merge (rule `VENDOR_DUPLICATE_SIGNALS`). */
export interface DuplicateWeights {
  weights: Readonly<Record<DuplicateSignal, number>>;
  suggest_from: number;
  name_similarity_from: number;
}

/** The keys of one contractor that are compared; every key is a hash or a normal form, never the personal value. */
export interface DuplicateFacts {
  taxHead: string | null;
  name: string;
  addressKey: string | null;
  phoneKey: string | null;
  emailKey: string | null;
  legalRepKey: string | null;
  ownerKeys: readonly string[];
  bankAccountKeys: readonly string[];
}

export interface DuplicateScore {
  score: number;
  signals: DuplicateSignal[];
  /** Whole points of the score at or over the line that suggests the merge. */
  suggested: boolean;
}

const shares = (a: readonly string[], b: readonly string[]): boolean => a.some((key) => b.includes(key));
const same = (a: string | null, b: string | null): boolean => a !== null && b !== null && a === b;

/** The signals two contractors share and their score. The tax code head is the strongest signal (two registrations of one legal entity, a branch against its head office); the score is the sum of the weights of the signals found. */
export function scoreDuplicate(a: DuplicateFacts, b: DuplicateFacts, params: DuplicateWeights): DuplicateScore {
  const found: DuplicateSignal[] = [];
  if (same(a.taxHead, b.taxHead)) found.push('TAX_HEAD');
  if (same(a.addressKey, b.addressKey)) found.push('ADDRESS');
  if (same(a.phoneKey, b.phoneKey)) found.push('PHONE');
  if (same(a.emailKey, b.emailKey)) found.push('EMAIL');
  if (same(a.legalRepKey, b.legalRepKey)) found.push('LEGAL_REPRESENTATIVE');
  if (shares(a.ownerKeys, b.ownerKeys)) found.push('OWNER');
  if (shares(a.bankAccountKeys, b.bankAccountKeys)) found.push('BANK_ACCOUNT');
  if (egpNameSimilarity(a.name, b.name) >= params.name_similarity_from) found.push('NAME');
  const score = found.reduce((sum, signal) => sum + params.weights[signal], 0);
  return { score, signals: found, suggested: found.length > 0 && score >= params.suggest_from };
}

/** The pair in a fixed order (smaller id first), so that one pair is one row whichever side was looked at first. */
export const duplicatePairOf = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

export const DUPLICATE_SUGGESTION_STATES = ['OPEN', 'DISMISSED', 'MERGE_REQUESTED'] as const;
export type DuplicateSuggestionState = (typeof DUPLICATE_SUGGESTION_STATES)[number];

/** A suggestion is decided once: a person dismisses it (it is not shown again unless the score rises past what was dismissed) or sends it to the merge of master data. */
export function duplicateSuggestionMove(from: DuplicateSuggestionState, to: Exclude<DuplicateSuggestionState, 'OPEN'>): void {
  if (from !== 'OPEN') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { status: from, to } });
  if (to !== 'DISMISSED' && to !== 'MERGE_REQUESTED') throw invalid('decision');
}
