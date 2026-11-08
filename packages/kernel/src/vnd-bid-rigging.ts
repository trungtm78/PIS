import { DomainError } from './errors.ts';

/**
 * Screening signals of bid rigging (VND-3, research V6; docs/vendor-investigation.md section 3). The patterns are general knowledge of the competition authorities (rotating winners, cover bids, price patterns, the
 * same file author, the same origin of submission, a bidder that withdraws for the same winner), not a text the research could open (the OECD guidelines of 2025 did not open): every number is a rule flagged unverified, and
 * a signal is a lead for the auditors, never a conclusion, never shown to the people who took part in the package and never to a contractor. Pure and deterministic: the facts come in, the signals go out, with the packages
 * and the contractors that each signal is about and the numbers it rests on. A fact that is not recorded (the origin of a submission, the author of a file) gives no signal and is counted in `traceCoverage`, so that
 * the screen can say "not recorded" instead of "clear".
 */

export const RIGGING_SIGNAL_CODES = ['ROTATING_WINNERS', 'COVER_BID', 'PRICE_PATTERN', 'FILE_METADATA', 'SHARED_ORIGIN', 'WITHDRAWAL_FOR_WINNER'] as const;
export type RiggingSignalCode = (typeof RIGGING_SIGNAL_CODES)[number];

export interface RiggingBid {
  contractorId: string;
  /** Whole dong as text; none for a bid whose price is not known. */
  priceVnd: string | null;
  withdrawn: boolean;
  submittedAt: string | null;
  originKey: string | null;
  deviceKey: string | null;
  /** The fingerprints of the files of the proposal (author, producer and creation stamp, folded into keys when the trace is recorded). */
  fileKeys: readonly string[];
}

export interface RiggingPackage {
  packageId: string;
  code: string;
  /** The buyer the rotation is looked for within: the unit or the investor that runs the packages. */
  buyerKey: string;
  closedOn: string | null;
  winnerId: string | null;
  bids: readonly RiggingBid[];
}

export interface RiggingPolicy {
  weights: Readonly<Record<RiggingSignalCode, number>>;
  rotation_min_packages: number;
  rotation_max_outsider_pct: number;
  rotation_max_share_pct: number;
  cover_close_gap_bp: number;
  cover_far_gap_bp: number;
  cover_min_bidders: number;
  pattern_min_bids: number;
  pattern_step_tolerance_bp: number;
  withdrawal_min_count: number;
  origin_window_minutes: number;
  lead_from: number;
}

export interface RiggingSignal {
  code: RiggingSignalCode;
  /** 0 to 100: the weight of the signal, raised by how extreme the pattern is. */
  score: number;
  packageIds: string[];
  contractorIds: string[];
  evidence: Record<string, string | number | string[]>;
}

const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const RIGGING_PARAM_DEFAULTS: Readonly<Record<string, number>> = {
  weight_rotating_winners: 75,
  weight_cover_bid: 55,
  weight_price_pattern: 55,
  weight_file_metadata: 70,
  weight_shared_origin: 60,
  weight_withdrawal_for_winner: 60,
  rotation_min_packages: 4,
  rotation_max_outsider_pct: 25,
  rotation_max_share_pct: 70,
  cover_close_gap_bp: 50,
  cover_far_gap_bp: 1000,
  cover_min_bidders: 3,
  pattern_min_bids: 3,
  pattern_step_tolerance_bp: 10,
  withdrawal_min_count: 2,
  origin_window_minutes: 60,
  lead_from: 50,
};

export function riggingPolicyOf(params: unknown): RiggingPolicy {
  if (!isRecord(params)) throw bad('params');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  const weights = {} as Record<RiggingSignalCode, number>;
  for (const code of RIGGING_SIGNAL_CODES) weights[code] = whole(`weight_${code.toLowerCase()}`, 0, 100);
  const policy: RiggingPolicy = {
    weights,
    rotation_min_packages: whole('rotation_min_packages', 2, 100),
    rotation_max_outsider_pct: whole('rotation_max_outsider_pct', 0, 100),
    rotation_max_share_pct: whole('rotation_max_share_pct', 1, 100),
    cover_close_gap_bp: whole('cover_close_gap_bp', 0, 10_000),
    cover_far_gap_bp: whole('cover_far_gap_bp', 1, 100_000),
    cover_min_bidders: whole('cover_min_bidders', 3, 50),
    pattern_min_bids: whole('pattern_min_bids', 3, 50),
    pattern_step_tolerance_bp: whole('pattern_step_tolerance_bp', 0, 1000),
    withdrawal_min_count: whole('withdrawal_min_count', 2, 100),
    origin_window_minutes: whole('origin_window_minutes', 1, 10_080),
    lead_from: whole('lead_from', 1, 100),
  };
  if (policy.cover_far_gap_bp <= policy.cover_close_gap_bp) throw bad('cover_far_gap_bp');
  return policy;
}

const priced = (bid: RiggingBid): boolean => !bid.withdrawn && bid.priceVnd !== null && /^\d+$/.test(bid.priceVnd) && BigInt(bid.priceVnd) > 0n;
const price = (bid: RiggingBid): bigint => BigInt(bid.priceVnd as string);
const bp = (part: bigint, whole: bigint): number => Number((part * 10_000n) / whole);
const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));
const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort();

/** Two bids close in time or with an unknown time: the origin is shared "at the same sitting". */
function withinWindow(a: RiggingBid, b: RiggingBid, minutes: number): boolean {
  if (a.submittedAt === null || b.submittedAt === null) return true;
  return Math.abs(Date.parse(a.submittedAt) - Date.parse(b.submittedAt)) <= minutes * 60_000;
}

/** How much of what the screening of origin and files needs was recorded: bids with an origin or a device, bids with a file key, over the bids that were handed in. */
export function traceCoverage(packages: readonly RiggingPackage[]): { bids: number; withOrigin: number; withFiles: number } {
  let bids = 0;
  let withOrigin = 0;
  let withFiles = 0;
  for (const pkg of packages) {
    for (const bid of pkg.bids) {
      bids += 1;
      if (bid.originKey !== null || bid.deviceKey !== null) withOrigin += 1;
      if (bid.fileKeys.length > 0) withFiles += 1;
    }
  }
  return { bids, withOrigin, withFiles };
}

/** Cover bid: two bids very close at the bottom and every other bid far above them (the others are there to make the competition look real). */
function coverBid(pkg: RiggingPackage, policy: RiggingPolicy): RiggingSignal | null {
  const bids = pkg.bids.filter(priced).sort((x, y) => (price(x) < price(y) ? -1 : price(x) > price(y) ? 1 : 0));
  if (bids.length < policy.cover_min_bidders) return null;
  const [low, second, ...rest] = bids as [RiggingBid, RiggingBid, ...RiggingBid[]];
  const closeGap = bp(price(second) - price(low), price(low));
  if (closeGap > policy.cover_close_gap_bp) return null;
  const farGaps = rest.map((bid) => bp(price(bid) - price(second), price(second)));
  if (farGaps.length === 0 || farGaps.some((gap) => gap < policy.cover_far_gap_bp)) return null;
  const minFar = Math.min(...farGaps);
  return {
    code: 'COVER_BID',
    score: clamp(policy.weights.COVER_BID + Math.min(20, (minFar - policy.cover_far_gap_bp) / 100)),
    packageIds: [pkg.packageId],
    contractorIds: uniqueSorted(bids.map((bid) => bid.contractorId)),
    evidence: { close_gap_bp: closeGap, nearest_far_gap_bp: minFar, bidders: bids.length },
  };
}

/** Price pattern: identical prices from different bidders, or bids that rise in equal steps. */
function pricePattern(pkg: RiggingPackage, policy: RiggingPolicy): RiggingSignal | null {
  const bids = pkg.bids.filter(priced);
  if (bids.length < 2) return null;
  const byPrice = new Map<string, string[]>();
  for (const bid of bids) byPrice.set(bid.priceVnd as string, [...(byPrice.get(bid.priceVnd as string) ?? []), bid.contractorId]);
  const identical = [...byPrice.values()].find((ids) => new Set(ids).size > 1);
  if (identical !== undefined) {
    return { code: 'PRICE_PATTERN', score: clamp(policy.weights.PRICE_PATTERN + 20), packageIds: [pkg.packageId], contractorIds: uniqueSorted(identical), evidence: { pattern: 'IDENTICAL_PRICE', bidders: identical.length } };
  }
  const sorted = [...bids].sort((x, y) => (price(x) < price(y) ? -1 : price(x) > price(y) ? 1 : 0));
  if (sorted.length < policy.pattern_min_bids) return null;
  const steps = sorted.slice(1).map((bid, index) => price(bid) - price(sorted[index] as RiggingBid));
  const first = steps[0] as bigint;
  const tolerance = (price(sorted[0] as RiggingBid) * BigInt(policy.pattern_step_tolerance_bp)) / 10_000n;
  if (first > 0n && steps.every((step) => (step > first ? step - first : first - step) <= tolerance)) {
    return { code: 'PRICE_PATTERN', score: clamp(policy.weights.PRICE_PATTERN + (sorted.length - policy.pattern_min_bids) * 5), packageIds: [pkg.packageId], contractorIds: uniqueSorted(sorted.map((bid) => bid.contractorId)), evidence: { pattern: 'EQUAL_STEPS', bidders: sorted.length, step_vnd: first.toString() } };
  }
  return null;
}

/** The same file fingerprint in the proposals of different bidders of one package. */
function fileMetadata(pkg: RiggingPackage, policy: RiggingPolicy): RiggingSignal | null {
  const holders = new Map<string, Set<string>>();
  for (const bid of pkg.bids) for (const key of bid.fileKeys) holders.set(key, (holders.get(key) ?? new Set<string>()).add(bid.contractorId));
  const shared = [...holders.entries()].filter(([, ids]) => ids.size > 1);
  if (shared.length === 0) return null;
  const ids = uniqueSorted(shared.flatMap(([, set]) => [...set]));
  return { code: 'FILE_METADATA', score: clamp(policy.weights.FILE_METADATA + (shared.length - 1) * 5), packageIds: [pkg.packageId], contractorIds: ids, evidence: { shared_files: shared.length, fingerprints: shared.map(([key]) => key.slice(0, 8)).sort() } };
}

/** The same origin or device in the submissions of different bidders, within the window. */
function sharedOrigin(pkg: RiggingPackage, policy: RiggingPolicy): RiggingSignal | null {
  const found = new Map<string, RiggingBid[]>();
  for (const bid of pkg.bids) {
    for (const key of [bid.originKey, bid.deviceKey]) if (key !== null) found.set(key, [...(found.get(key) ?? []), bid]);
  }
  const groups = [...found.entries()].map(([key, bids]) => ({ key, bids: bids.filter((bid, index) => bids.some((other, at) => at !== index && other.contractorId !== bid.contractorId && withinWindow(bid, other, policy.origin_window_minutes))) })).filter((group) => new Set(group.bids.map((bid) => bid.contractorId)).size > 1);
  if (groups.length === 0) return null;
  const ids = uniqueSorted(groups.flatMap((group) => group.bids.map((bid) => bid.contractorId)));
  return { code: 'SHARED_ORIGIN', score: clamp(policy.weights.SHARED_ORIGIN + (groups.length - 1) * 10), packageIds: [pkg.packageId], contractorIds: ids, evidence: { shared_keys: groups.length, fingerprints: groups.map((group) => group.key.slice(0, 8)).sort() } };
}

/** The signals that one package gives by itself. */
export function screenPackage(pkg: RiggingPackage, policy: RiggingPolicy): RiggingSignal[] {
  const found = [coverBid(pkg, policy), pricePattern(pkg, policy), fileMetadata(pkg, policy), sharedOrigin(pkg, policy)];
  return found.filter((signal): signal is RiggingSignal => signal !== null && policy.weights[signal.code] > 0);
}

/**
 * The signals of the history of one buyer. Rotation: the contractors that bid in at least `rotation_min_packages` of the packages (the regulars) and win in turns, with few outsiders and no single winner above the share
 * the rule allows. Withdrawal: a bidder that withdrew in at least `withdrawal_min_count` packages that the same other bidder won.
 */
export function screenBuyer(packages: readonly RiggingPackage[], policy: RiggingPolicy): RiggingSignal[] {
  const out: RiggingSignal[] = [];
  const closed = packages.filter((pkg) => pkg.winnerId !== null && pkg.bids.filter((bid) => !bid.withdrawn).length >= 2).sort((x, y) => `${x.closedOn ?? ''}${x.packageId}`.localeCompare(`${y.closedOn ?? ''}${y.packageId}`));
  if (policy.weights.ROTATING_WINNERS > 0) {
    const appearances = new Map<string, number>();
    for (const pkg of closed) for (const id of new Set(pkg.bids.map((bid) => bid.contractorId))) appearances.set(id, (appearances.get(id) ?? 0) + 1);
    const regulars = new Set([...appearances.entries()].filter(([, count]) => count >= policy.rotation_min_packages).map(([id]) => id));
    if (regulars.size >= 2) {
      const together = closed.filter((pkg) => new Set(pkg.bids.filter((bid) => regulars.has(bid.contractorId)).map((bid) => bid.contractorId)).size >= 2);
      const wins = new Map<string, number>();
      let outsiders = 0;
      for (const pkg of together) {
        if (pkg.winnerId !== null && regulars.has(pkg.winnerId)) wins.set(pkg.winnerId, (wins.get(pkg.winnerId) ?? 0) + 1);
        else outsiders += 1;
      }
      const count = together.length;
      const top = Math.max(0, ...wins.values());
      if (count >= policy.rotation_min_packages && wins.size >= 2 && (outsiders * 100) / count <= policy.rotation_max_outsider_pct && (top * 100) / (count - outsiders || 1) <= policy.rotation_max_share_pct) {
        out.push({
          code: 'ROTATING_WINNERS',
          score: clamp(policy.weights.ROTATING_WINNERS + Math.min(20, (count - policy.rotation_min_packages) * 5)),
          packageIds: together.map((pkg) => pkg.packageId),
          contractorIds: uniqueSorted([...wins.keys()]),
          evidence: { packages: count, winners: wins.size, outsider_wins: outsiders, sequence: together.map((pkg) => (pkg.winnerId ?? '').slice(0, 8)) },
        });
      }
    }
  }
  if (policy.weights.WITHDRAWAL_FOR_WINNER > 0) {
    const pairs = new Map<string, { withdrawer: string; winner: string; packages: string[] }>();
    for (const pkg of packages) {
      if (pkg.winnerId === null) continue;
      for (const bid of pkg.bids) {
        if (!bid.withdrawn || bid.contractorId === pkg.winnerId) continue;
        const key = `${bid.contractorId}|${pkg.winnerId}`;
        const entry = pairs.get(key) ?? { withdrawer: bid.contractorId, winner: pkg.winnerId, packages: [] };
        entry.packages.push(pkg.packageId);
        pairs.set(key, entry);
      }
    }
    for (const entry of [...pairs.values()].sort((x, y) => (x.withdrawer + x.winner < y.withdrawer + y.winner ? -1 : 1))) {
      if (entry.packages.length < policy.withdrawal_min_count) continue;
      out.push({ code: 'WITHDRAWAL_FOR_WINNER', score: clamp(policy.weights.WITHDRAWAL_FOR_WINNER + (entry.packages.length - policy.withdrawal_min_count) * 10), packageIds: entry.packages.sort(), contractorIds: uniqueSorted([entry.withdrawer, entry.winner]), evidence: { withdrawals: entry.packages.length } });
    }
  }
  return out;
}

/** All the signals of a set of packages (each buyer on its own), strongest first, only those at or over the line that makes a lead. */
export function screenAll(packages: readonly RiggingPackage[], policy: RiggingPolicy): RiggingSignal[] {
  const byBuyer = new Map<string, RiggingPackage[]>();
  for (const pkg of packages) byBuyer.set(pkg.buyerKey, [...(byBuyer.get(pkg.buyerKey) ?? []), pkg]);
  const signals = [...packages.flatMap((pkg) => screenPackage(pkg, policy)), ...[...byBuyer.keys()].sort().flatMap((buyer) => screenBuyer(byBuyer.get(buyer) as RiggingPackage[], policy))];
  return signals.filter((signal) => signal.score >= policy.lead_from).sort((x, y) => y.score - x.score || (leadKeyOf(x) < leadKeyOf(y) ? -1 : 1));
}

/** The stable key of a lead: one signal about one set of packages and contractors is one lead whichever scan found it. */
export const leadKeyOf = (signal: Pick<RiggingSignal, 'code' | 'packageIds' | 'contractorIds'>): string => `${signal.code}:${[...signal.packageIds].sort().join(',')}:${[...signal.contractorIds].sort().join(',')}`;

/** The rank of a lead for the auditors: the score of its strongest signal, plus five points for each further kind of signal on the same contractors (signals pile up where the trouble is), capped at 100. */
export function leadRank(scores: readonly number[], distinctKinds: number): number {
  if (scores.length === 0) return 0;
  return clamp(Math.max(...scores) + Math.max(0, distinctKinds - 1) * 5);
}
