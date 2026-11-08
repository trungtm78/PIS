import { DomainError } from './errors.ts';

/**
 * Independence and conflict of interest between the bidders of a package, the panel that evaluates them, the project staff and the owner organisation (VND-2, research V5; docs/vendor-controls.md section 2).
 * The law asks a bidder to be independent in law and in finance from the investor and from the other bidders, and a person who evaluates not to be, or to be related to, a bidder (Article 6 and 16 Procurement Law 22/2023;
 * the limits of cross ownership, 30 and 20 percent, are rule data flagged unverified). The detection here is pure: the facts are keys (hashes of the normal forms of an address, a telephone number, a name),
 * never the personal values, so that two records of one party are found by equality; **a signal is not a verdict**: a finding goes to a person who clears, recuses or blocks, and a name alone is never an identity.
 */

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const VENDOR_INDEPENDENCE_RULE_TYPE = 'VENDOR_INDEPENDENCE';

/** The rule `VENDOR_INDEPENDENCE`. */
export interface IndependencePolicy {
  /** Percent of a bidder held by the owner organisation (or of the owner organisation held by a bidder) above which the two are not independent in finance (the research reads 30 percent). */
  cross_ownership_investor_pct: number;
  /** Percent held between two bidders (the research reads 20 percent for limited bidding and for a consultant of the same package). */
  cross_ownership_bidders_pct: number;
  /** Months after leaving the owner organisation during which a former member of staff may not evaluate a bidder they now work for (the research reads 12 months). */
  former_official_months: number;
  /** Whether a finding of strength STRONG that no person decided stops the award of the package. */
  undecided_strong_blocks_award: boolean;
}

export const INDEPENDENCE_POLICY_DEFAULTS: IndependencePolicy = { cross_ownership_investor_pct: 30, cross_ownership_bidders_pct: 20, former_official_months: 12, undecided_strong_blocks_award: true };

export function independencePolicyOf(params: unknown): IndependencePolicy {
  if (!isRecord(params)) throw invalid('params');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
    return value;
  };
  const flag = params.undecided_strong_blocks_award;
  if (typeof flag !== 'boolean') throw invalid('undecided_strong_blocks_award');
  return {
    cross_ownership_investor_pct: whole('cross_ownership_investor_pct', 1, 100),
    cross_ownership_bidders_pct: whole('cross_ownership_bidders_pct', 1, 100),
    former_official_months: whole('former_official_months', 0, 120),
    undecided_strong_blocks_award: flag,
  };
}

// -- Facts ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One owner of a party: a person or an organisation; `taxHead` is set when the owner is an organisation known by its tax code (the head part, a branch counted with its head office). */
export interface OwnerKeys {
  nameKey: string;
  identityKey: string | null;
  taxHead: string | null;
  /** Percent held (0 to 100, two decimals) or null when the owner controls without a share. */
  sharePct: number | null;
}

/** A contractor as the detection sees it: the keys of VND-1, never the values. */
export interface PartyFacts {
  contractorId: string;
  taxHead: string | null;
  addressKey: string | null;
  phoneKey: string | null;
  emailKey: string | null;
  legalRepKey: string | null;
  owners: readonly OwnerKeys[];
  bankAccountKeys: readonly string[];
}

/** The owner organisation of the package (the investor) as a party: its tax head and its own owners (a person who owns both the investor and a bidder is a link). */
export interface OwnerOrganisationFacts {
  taxHead: string | null;
  ownerKeys: readonly OwnerKeys[];
}

export const INTEREST_KINDS = ['RELATIVE', 'SHAREHOLDING', 'FORMER_EMPLOYMENT', 'ADVISORY'] as const;
export type InterestKind = (typeof INTEREST_KINDS)[number];

/** What a person declared about themselves; a relative is named by key (and by the key of the identity document when given). */
export interface InterestFacts {
  id: string;
  kind: InterestKind;
  relatedNameKey: string | null;
  relatedIdentityKey: string | null;
  /** The contractor the interest is about, when it is a registered one. */
  contractorId: string | null;
  taxHead: string | null;
  sharePct: number | null;
  /** The day the relation or the employment ended; null when it holds. */
  endedOn: string | null;
}

export const PERSON_ROLES = ['EVALUATOR', 'PROJECT_STAFF'] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export interface IndependencePerson {
  membershipId: string;
  role: PersonRole;
  nameKey: string;
  identityKey: string | null;
  interests: readonly InterestFacts[];
}

// -- Findings ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const FINDING_KINDS = [
  'BIDDERS_SHARE_TAX_HEAD',
  'BIDDERS_SHARE_ADDRESS',
  'BIDDERS_SHARE_PHONE',
  'BIDDERS_SHARE_EMAIL',
  'BIDDERS_SHARE_REPRESENTATIVE',
  'BIDDERS_SHARE_OWNER',
  'BIDDERS_SHARE_BANK_ACCOUNT',
  'BIDDERS_CROSS_OWNERSHIP',
  'BIDDER_IS_OWNER_ORGANISATION',
  'BIDDER_CROSS_OWNERSHIP_WITH_OWNER',
  'BIDDER_SHARES_OWNER_WITH_OWNER',
  'PERSON_REPRESENTS_BIDDER',
  'PERSON_OWNS_BIDDER',
  'RELATIVE_REPRESENTS_BIDDER',
  'RELATIVE_OWNS_BIDDER',
  'PERSON_HOLDS_SHARES_IN_BIDDER',
  'FORMER_OFFICIAL_OF_BIDDER',
  'ADVISER_OF_BIDDER',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const FINDING_STRENGTHS = ['STRONG', 'MEDIUM'] as const;
export type FindingStrength = (typeof FINDING_STRENGTHS)[number];

export const FINDING_DECISIONS = ['CLEARED', 'RECUSED', 'BLOCKED'] as const;
export type FindingDecision = (typeof FINDING_DECISIONS)[number];

export interface PartyRef {
  kind: 'CONTRACTOR' | 'PERSON' | 'OWNER_ORGANISATION';
  /** A contractor id, a membership id, or the literal `owner`. */
  id: string;
}

export interface IndependenceFinding {
  kind: FindingKind;
  strength: FindingStrength;
  /** The two sides, in a fixed order, so that one link found twice is one finding. */
  parties: [PartyRef, PartyRef];
  /** What was compared, as codes and numbers (never a personal value): the "i" of the screen shows it. */
  evidence: Readonly<Record<string, string | number | boolean | null>>;
  /** Stable text of the link: a finding found again on a later run has the same fingerprint, so a decision is not asked twice. */
  fingerprint: string;
}

const refText = (ref: PartyRef): string => `${ref.kind}:${ref.id}`;
const ordered = (a: PartyRef, b: PartyRef): [PartyRef, PartyRef] => (refText(a) <= refText(b) ? [a, b] : [b, a]);

function finding(kind: FindingKind, strength: FindingStrength, a: PartyRef, b: PartyRef, evidence: Record<string, string | number | boolean | null> = {}): IndependenceFinding {
  const parties = ordered(a, b);
  return { kind, strength, parties, evidence, fingerprint: `${kind}|${refText(parties[0])}|${refText(parties[1])}` };
}

const contractor = (facts: PartyFacts): PartyRef => ({ kind: 'CONTRACTOR', id: facts.contractorId });
const person = (facts: IndependencePerson): PartyRef => ({ kind: 'PERSON', id: facts.membershipId });
const OWNER_REF: PartyRef = { kind: 'OWNER_ORGANISATION', id: 'owner' };

const same = (a: string | null, b: string | null): boolean => a !== null && b !== null && a === b;
const holds = (owner: OwnerKeys): number => owner.sharePct ?? 0;

/**
 * The links among the bidders of one package: the same tax head (two registrations of one entity), an account, an owner or the same representative are STRONG; an address, a telephone number or an e-mail address alone
 * is MEDIUM (a shared office is a hint to look at, not proof); one bidder owning another above the limit of bidders is STRONG.
 */
export function detectBidderLinks(bidders: readonly PartyFacts[], policy: IndependencePolicy): IndependenceFinding[] {
  const out: IndependenceFinding[] = [];
  for (let i = 0; i < bidders.length; i += 1) {
    for (let j = i + 1; j < bidders.length; j += 1) {
      const a = bidders[i] as PartyFacts;
      const b = bidders[j] as PartyFacts;
      if (a.contractorId === b.contractorId) continue;
      if (same(a.taxHead, b.taxHead)) out.push(finding('BIDDERS_SHARE_TAX_HEAD', 'STRONG', contractor(a), contractor(b)));
      if (same(a.addressKey, b.addressKey)) out.push(finding('BIDDERS_SHARE_ADDRESS', 'MEDIUM', contractor(a), contractor(b)));
      if (same(a.phoneKey, b.phoneKey)) out.push(finding('BIDDERS_SHARE_PHONE', 'MEDIUM', contractor(a), contractor(b)));
      if (same(a.emailKey, b.emailKey)) out.push(finding('BIDDERS_SHARE_EMAIL', 'MEDIUM', contractor(a), contractor(b)));
      if (same(a.legalRepKey, b.legalRepKey)) out.push(finding('BIDDERS_SHARE_REPRESENTATIVE', 'STRONG', contractor(a), contractor(b)));
      if (a.bankAccountKeys.some((key) => b.bankAccountKeys.includes(key))) out.push(finding('BIDDERS_SHARE_BANK_ACCOUNT', 'STRONG', contractor(a), contractor(b)));
      const sharedOwner = a.owners.find((x) => b.owners.some((y) => (x.identityKey !== null && x.identityKey === y.identityKey) || (x.taxHead !== null && x.taxHead === y.taxHead)));
      if (sharedOwner !== undefined) out.push(finding('BIDDERS_SHARE_OWNER', 'STRONG', contractor(a), contractor(b), { share_pct_a: sharedOwner.sharePct }));
      // One bidder owns another: the owner of A is an organisation with the tax head of B (and the other way round).
      for (const [holder, held] of [[a, b], [b, a]] as const) {
        const stake = held.owners.filter((owner) => same(owner.taxHead, holder.taxHead)).reduce((sum, owner) => Math.max(sum, holds(owner)), 0);
        if (holder.taxHead !== null && stake > policy.cross_ownership_bidders_pct) out.push(finding('BIDDERS_CROSS_OWNERSHIP', 'STRONG', contractor(a), contractor(b), { share_pct: stake, limit_pct: policy.cross_ownership_bidders_pct, holder: holder.contractorId }));
      }
    }
  }
  return out;
}

/**
 * The links between a bidder and the owner organisation of the package: the bidder is the owner organisation (the same tax head), one holds the other above the limit of the investor (30 percent in the research),
 * or a person owns both (a shared owner, MEDIUM until a person looks).
 */
export function detectOwnerLinks(owner: OwnerOrganisationFacts, bidders: readonly PartyFacts[], policy: IndependencePolicy): IndependenceFinding[] {
  const out: IndependenceFinding[] = [];
  for (const bidder of bidders) {
    if (same(owner.taxHead, bidder.taxHead)) out.push(finding('BIDDER_IS_OWNER_ORGANISATION', 'STRONG', contractor(bidder), OWNER_REF));
    const heldByOwner = bidder.owners.filter((one) => same(one.taxHead, owner.taxHead)).reduce((sum, one) => Math.max(sum, holds(one)), 0);
    const heldInOwner = owner.ownerKeys.filter((one) => same(one.taxHead, bidder.taxHead)).reduce((sum, one) => Math.max(sum, holds(one)), 0);
    const stake = Math.max(heldByOwner, heldInOwner);
    if (stake > policy.cross_ownership_investor_pct) out.push(finding('BIDDER_CROSS_OWNERSHIP_WITH_OWNER', 'STRONG', contractor(bidder), OWNER_REF, { share_pct: stake, limit_pct: policy.cross_ownership_investor_pct }));
    const shared = bidder.owners.some((one) => owner.ownerKeys.some((other) => one.identityKey !== null && one.identityKey === other.identityKey));
    if (shared) out.push(finding('BIDDER_SHARES_OWNER_WITH_OWNER', 'MEDIUM', contractor(bidder), OWNER_REF));
  }
  return out;
}

const DAY_MS = 86_400_000;
const monthsBetween = (from: string, to: string): number => {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  return end.getUTCDate() < start.getUTCDate() ? months - 1 : months;
};

/** An interest that has not ended on `today` (one that ends on a later day still holds today). */
const ongoing = (interest: InterestFacts, today: string): boolean => interest.endedOn === null || interest.endedOn > today;

/**
 * The links between the people who evaluate (or staff the project) and the bidders: the person is a representative or an owner of a bidder (the name key alone is MEDIUM, with the identity key STRONG), a relative they
 * declared is one (MEDIUM by name, STRONG by identity), they hold shares, they left the bidder less than `former_official_months` before `today` (a former official), or they advise it. An interest that ended is not
 * a link, except the employment inside its months.
 */
export function detectPersonLinks(people: readonly IndependencePerson[], bidders: readonly PartyFacts[], policy: IndependencePolicy, today: string): IndependenceFinding[] {
  const out: IndependenceFinding[] = [];
  for (const one of people) {
    for (const bidder of bidders) {
      const ownerMatch = bidder.owners.find((owner) => (one.identityKey !== null && owner.identityKey === one.identityKey) || owner.nameKey === one.nameKey);
      if (one.nameKey === bidder.legalRepKey) out.push(finding('PERSON_REPRESENTS_BIDDER', 'MEDIUM', person(one), contractor(bidder), { by: 'NAME' }));
      if (ownerMatch !== undefined) {
        const byIdentity = one.identityKey !== null && ownerMatch.identityKey === one.identityKey;
        out.push(finding('PERSON_OWNS_BIDDER', byIdentity ? 'STRONG' : 'MEDIUM', person(one), contractor(bidder), { by: byIdentity ? 'IDENTITY' : 'NAME', share_pct: ownerMatch.sharePct }));
      }
      for (const interest of one.interests) {
        const aboutBidder = (interest.contractorId !== null && interest.contractorId === bidder.contractorId) || same(interest.taxHead, bidder.taxHead);
        if (interest.kind === 'RELATIVE') {
          const identityRep = interest.relatedIdentityKey !== null && bidder.owners.some((owner) => owner.identityKey === interest.relatedIdentityKey);
          const nameRep = interest.relatedNameKey !== null && interest.relatedNameKey === bidder.legalRepKey;
          const nameOwner = interest.relatedNameKey !== null && bidder.owners.some((owner) => owner.nameKey === interest.relatedNameKey);
          if (nameRep) out.push(finding('RELATIVE_REPRESENTS_BIDDER', 'MEDIUM', person(one), contractor(bidder), { interest: interest.id, by: 'NAME' }));
          if (identityRep || nameOwner) out.push(finding('RELATIVE_OWNS_BIDDER', identityRep ? 'STRONG' : 'MEDIUM', person(one), contractor(bidder), { interest: interest.id, by: identityRep ? 'IDENTITY' : 'NAME' }));
          if (aboutBidder && ongoing(interest, today)) out.push(finding('RELATIVE_OWNS_BIDDER', 'STRONG', person(one), contractor(bidder), { interest: interest.id, by: 'DECLARED_CONTRACTOR' }));
        } else if (interest.kind === 'SHAREHOLDING' && aboutBidder && ongoing(interest, today) && (interest.sharePct ?? 0) > 0) {
          out.push(finding('PERSON_HOLDS_SHARES_IN_BIDDER', 'STRONG', person(one), contractor(bidder), { interest: interest.id, share_pct: interest.sharePct }));
        } else if (interest.kind === 'FORMER_EMPLOYMENT' && aboutBidder) {
          const within = interest.endedOn === null || interest.endedOn > today || monthsBetween(interest.endedOn, today) < policy.former_official_months;
          if (within) out.push(finding('FORMER_OFFICIAL_OF_BIDDER', 'STRONG', person(one), contractor(bidder), { interest: interest.id, months_limit: policy.former_official_months }));
        } else if (interest.kind === 'ADVISORY' && aboutBidder && ongoing(interest, today)) {
          out.push(finding('ADVISER_OF_BIDDER', 'STRONG', person(one), contractor(bidder), { interest: interest.id }));
        }
      }
    }
  }
  return out;
}

/** The three detections together, without a repeated fingerprint (the strongest wins), in a fixed order so that two runs over the same facts give the same list. */
export function detectIndependence(input: { bidders: readonly PartyFacts[]; people: readonly IndependencePerson[]; owner: OwnerOrganisationFacts | null; today: string }, policy: IndependencePolicy): IndependenceFinding[] {
  const all = [...detectBidderLinks(input.bidders, policy), ...(input.owner === null ? [] : detectOwnerLinks(input.owner, input.bidders, policy)), ...detectPersonLinks(input.people, input.bidders, policy, input.today)];
  const best = new Map<string, IndependenceFinding>();
  for (const one of all) {
    const known = best.get(one.fingerprint);
    if (known === undefined || (known.strength === 'MEDIUM' && one.strength === 'STRONG')) best.set(one.fingerprint, one);
  }
  return [...best.values()].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
}

// -- Decisions -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const MIN_FINDING_REASON = 20;

/** A finding is decided once, by a person other than the one who ran the check, with a reason (REASON_REQUIRED); the decision of a finding of a person (recused) takes that person out of the panel, one of a bidder (blocked) stops the bidder. */
export function assertFindingDecision(input: { decision: string; reason: string; decidedBy: string; ranBy: string; alreadyDecided: boolean }): FindingDecision {
  if (!(FINDING_DECISIONS as readonly string[]).includes(input.decision)) throw invalid('decision');
  if (input.alreadyDecided) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
  if (input.reason.trim().length < MIN_FINDING_REASON) throw new DomainError('REASON_REQUIRED', 422, 'reason');
  if (input.decidedBy === input.ranBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  return input.decision as FindingDecision;
}

/** A decision that fits the finding: a finding between two bidders or with the owner can only be CLEARED or BLOCKED (a bidder is not recused from its own bid); one about a person can only be CLEARED or RECUSED. */
export function decisionFitsFinding(kind: FindingKind, decision: FindingDecision): boolean {
  const aboutPerson = kind.startsWith('PERSON_') || kind.startsWith('RELATIVE_') || kind === 'FORMER_OFFICIAL_OF_BIDDER' || kind === 'ADVISER_OF_BIDDER';
  return aboutPerson ? decision !== 'BLOCKED' : decision !== 'RECUSED';
}

export interface FindingStanding {
  strength: FindingStrength;
  decision: FindingDecision | null;
}

export interface IndependenceGate {
  /** The award may go on: no BLOCKED finding, and (by the rule) no STRONG finding left undecided. */
  open: boolean;
  blocked: number;
  undecidedStrong: number;
  undecided: number;
  cleared: number;
  recused: number;
}

export function independenceGate(findings: readonly FindingStanding[], policy: IndependencePolicy): IndependenceGate {
  const blocked = findings.filter((one) => one.decision === 'BLOCKED').length;
  const undecided = findings.filter((one) => one.decision === null);
  const undecidedStrong = undecided.filter((one) => one.strength === 'STRONG').length;
  return {
    open: blocked === 0 && !(policy.undecided_strong_blocks_award && undecidedStrong > 0),
    blocked,
    undecidedStrong,
    undecided: undecided.length,
    cleared: findings.filter((one) => one.decision === 'CLEARED').length,
    recused: findings.filter((one) => one.decision === 'RECUSED').length,
  };
}

/** Whole days between two days (used by the alert for the age of an undecided finding). */
export const independenceAgeDays = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
