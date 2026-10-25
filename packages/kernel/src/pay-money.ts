import { DomainError } from './errors.ts';
import type { RoundingMode } from './decimal.ts';

/**
 * The money of a payment request (ST-PAY-002, PAY 5, BR-PAY-03..07): gross from the lines of an acceptance, the advance to recover, the retention to hold, and the net, all in whole dong and all
 * computed by the server from the acceptance and the ledger, never taken from the client. Everything here is a pure function of its input over BigInt, so the golden cases of the chief accountant
 * run without a database and the same input gives the same lines on every run.
 */

const ZERO = 0n;
/** The percentages carry four decimals (numeric(7,4)); the thresholds and the retention are read at that scale. */
const PCT_SCALE = 10_000n;
const AMOUNT = /^(0|[1-9][0-9]{0,23})$/;
const SIGNED_AMOUNT = /^-?(0|[1-9][0-9]{0,23})$/;
const PERCENT = /^(0|[1-9][0-9]{0,2})(\.[0-9]{1,4})?$/;

const invalid = (field: string, reason: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, { extensions: { reason } });

/** A non-negative amount of whole dong as a BigInt. */
export function wholeVnd(value: string, field: string): bigint {
  if (!AMOUNT.test(value)) throw invalid(field, 'NOT_A_WHOLE_AMOUNT');
  return BigInt(value);
}

/** A signed amount of whole dong as a BigInt (the tax adjustment). */
export function signedDong(value: string, field: string): bigint {
  if (!SIGNED_AMOUNT.test(value)) throw invalid(field, 'NOT_A_WHOLE_AMOUNT');
  return BigInt(value);
}

/** A percentage with up to four decimals as an integer count of ten-thousandths of a percent. */
export function percentScaled(value: string, field: string): bigint {
  if (!PERCENT.test(value)) throw invalid(field, 'NOT_A_PERCENT');
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * PCT_SCALE + BigInt(fraction.padEnd(4, '0'));
}

/** `numerator / denominator` rounded to a whole number by the rule of the line of the BOQ (both non-negative, the denominator above zero). */
export function roundedDivision(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator <= ZERO || numerator < ZERO) throw new RangeError('roundedDivision takes a non-negative numerator and a positive denominator');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === ZERO) return quotient;
  switch (mode) {
    case 'DOWN':
      return quotient;
    case 'UP':
      return quotient + 1n;
    case 'HALF_UP':
      return remainder * 2n >= denominator ? quotient + 1n : quotient;
    case 'HALF_EVEN': {
      const twice = remainder * 2n;
      if (twice === denominator) return quotient % 2n === ZERO ? quotient : quotient + 1n;
      return twice > denominator ? quotient + 1n : quotient;
    }
  }
}

/** BR-PAY-05: the retention of a line, `round(gross x pct / 100)` by the rounding rule of the line. */
export function retentionOf(grossVnd: string, retentionPct: string, rounding: RoundingMode): string {
  return roundedDivision(wholeVnd(grossVnd, 'gross_vnd') * percentScaled(retentionPct, 'retention_pct'), 100n * PCT_SCALE, rounding).toString();
}

/**
 * BR-PAY-04: how much of an advance should have been recovered when the gross requested to date is `grossToDate`: `floor(A x min(1, G / (theta x V)))`, all of it from the threshold on. A
 * party whose work is worth nothing (or a threshold of nothing) recovers the whole advance at once.
 */
export function targetRecovered(paidVnd: string, workValueVnd: string, thresholdPct: string, grossToDateVnd: string): string {
  const paid = wholeVnd(paidVnd, 'paid_vnd');
  const value = wholeVnd(workValueVnd, 'work_value_vnd');
  const threshold = percentScaled(thresholdPct, 'recovery_threshold_pct');
  const gross = wholeVnd(grossToDateVnd, 'gross_to_date_vnd');
  const thresholdValue = value * threshold; // theta x V, in ten-thousandths of a percent of a dong
  if (thresholdValue === ZERO) return paid.toString();
  // G >= theta x V  <=>  G x 100 x PCT_SCALE >= V x threshold
  const full = gross * 100n * PCT_SCALE >= thresholdValue;
  if (full) return paid.toString();
  return ((paid * gross * 100n * PCT_SCALE) / thresholdValue).toString();
}

export interface AdvanceTranche {
  id: string;
  paidVnd: string;
  recoveredVnd: string;
  thresholdPct: string;
}

/** What one party (the contractor, or a member of a joint venture) holds of the advance, and how much it has asked to be paid before. */
export interface PartyAdvance {
  partyId: string;
  workValueVnd: string;
  /** Gross requested by earlier payment requests of this party (the ledger's `requested_vnd`). */
  previousGrossVnd: string;
  tranches: readonly AdvanceTranche[];
}

/**
 * The advance this request recovers from one party: for each tranche the target for the gross to date less what was recovered, not below zero and not above what is still outstanding on the
 * tranche. Also what is left to recover once this request has taken its share (the room for an extra recovery).
 */
export function partyRecovery(party: PartyAdvance, grossThisRequestVnd: string): { recoveryVnd: string; roomLeftVnd: string } {
  const grossToDate = wholeVnd(party.previousGrossVnd, 'previous_gross_vnd') + wholeVnd(grossThisRequestVnd, 'gross_vnd');
  let recovery = ZERO;
  let room = ZERO;
  for (const tranche of party.tranches) {
    const paid = wholeVnd(tranche.paidVnd, 'paid_vnd');
    const recovered = wholeVnd(tranche.recoveredVnd, 'recovered_vnd');
    const outstanding = paid > recovered ? paid - recovered : ZERO;
    const target = BigInt(targetRecovered(tranche.paidVnd, party.workValueVnd, tranche.thresholdPct, grossToDate.toString()));
    const now = target > recovered ? target - recovered : ZERO;
    const taken = now < outstanding ? now : outstanding;
    recovery += taken;
    room += outstanding - taken;
  }
  return { recoveryVnd: recovery.toString(), roomLeftVnd: room.toString() };
}

/**
 * BR-PAY-07: shares `total` over the weights by the method of the largest remainder: every line gets the floor of its proportional share, the remainder goes one dong at a time to the lines
 * with the largest fractional part, ties to the smallest key (the identifier of the BOQ item, ascending). No line gets more than its capacity; what a full line cannot take is shared among
 * the others the same way, so the shares add up to `total` exactly when the capacities allow it (and to the sum of the capacities when they do not).
 */
export function allocateLargestRemainder(total: bigint, slots: ReadonlyArray<{ key: string; weight: bigint; capacity: bigint }>): bigint[] {
  const result = slots.map(() => ZERO);
  let left = total;
  let open = slots.map((_, index) => index).filter((index) => slots[index]!.capacity > ZERO && slots[index]!.weight > ZERO);
  while (left > ZERO && open.length > 0) {
    const weight = open.reduce((sum, index) => sum + slots[index]!.weight, ZERO);
    const shares = open.map((index) => {
      const slot = slots[index]!;
      const exact = left * slot.weight;
      return { index, floor: exact / weight, fraction: exact % weight };
    });
    // A share above the room of its line is capped, and the capped lines leave the pool: the rest is shared again among the others.
    const capped = shares.filter((share) => result[share.index]! + share.floor > slots[share.index]!.capacity);
    if (capped.length > 0) {
      for (const share of capped) {
        const slot = slots[share.index]!;
        left -= slot.capacity - result[share.index]!;
        result[share.index] = slot.capacity;
      }
      open = open.filter((index) => !capped.some((share) => share.index === index));
      continue;
    }
    for (const share of shares) {
      result[share.index] = result[share.index]! + share.floor;
      left -= share.floor;
    }
    const byRemainder = [...shares].sort((a, b) => (a.fraction === b.fraction ? (slots[a.index]!.key < slots[b.index]!.key ? -1 : slots[a.index]!.key > slots[b.index]!.key ? 1 : 0) : a.fraction > b.fraction ? -1 : 1));
    for (const share of byRemainder) {
      if (left === ZERO) break;
      if (result[share.index]! < slots[share.index]!.capacity) {
        result[share.index] = result[share.index]! + 1n;
        left -= 1n;
      }
    }
    // What a line at its capacity could not take is shared again among the lines that still have room.
    open = open.filter((index) => result[index]! < slots[index]!.capacity);
  }
  return result;
}

export interface MoneyLine {
  /** The line of the acceptance this line of the request is made from. */
  acceptanceLineId: string;
  boqItemId: string;
  partyId: string | null;
  grossVnd: string;
  retentionPct: string;
  rounding: RoundingMode;
}

export interface DraftMoneyInput {
  lines: readonly MoneyLine[];
  parties: readonly PartyAdvance[];
  /** Signed, whole dong; the basis is kept with the request. */
  taxAdjustmentVnd: string;
  /** Recovery asked for on top of the formula, over the room the tranches have left (not below zero). */
  extraRecoveryVnd: string;
}

export interface DraftLine {
  acceptanceLineId: string;
  boqItemId: string;
  partyId: string | null;
  grossVnd: string;
  advanceRecoveryVnd: string;
  retentionVnd: string;
  netVnd: string;
}

export interface DraftMoney {
  grossVnd: string;
  advanceRecoveryVnd: string;
  retentionVnd: string;
  taxAdjustmentVnd: string;
  netVnd: string;
  lines: DraftLine[];
  /** What the formula alone would have recovered, before the cap that keeps recovery and retention within the gross. */
  formulaRecoveryVnd: string;
}

const sortKey = (a: { key: string }, b: { key: string }): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * BR-PAY-03..07: the draft of a payment request from the lines of an approved acceptance. Gross is the sum of the lines; the retention of a line is its gross times its retention percentage; the
 * advance to recover is the formula for each party (and the extra asked for, within the room that is left), kept within what the lines can carry (recovery plus retention never above the
 * gross of the line, so the net of a line is never negative) and shared over the lines of the party by the largest remainder; net = gross - recovery - retention + tax.
 * 422 `VALIDATION_FAILED` for an extra recovery above the room the advances have left, or a line whose party holds no share of the contract.
 */
export function computeDraftMoney(input: DraftMoneyInput): DraftMoney {
  const tax = signedDong(input.taxAdjustmentVnd, 'tax_adjustment_vnd');
  const extra = wholeVnd(input.extraRecoveryVnd, 'advance_recovery_extra_vnd');
  const lines = input.lines.map((line) => {
    const gross = wholeVnd(line.grossVnd, 'gross_vnd');
    const retention = BigInt(retentionOf(line.grossVnd, line.retentionPct, line.rounding));
    return { line, gross, retention, room: gross > retention ? gross - retention : ZERO };
  });
  const partyOf = (partyId: string | null): string => partyId ?? '';
  const partyIds = [...new Set(lines.map((entry) => partyOf(entry.line.partyId)))].sort();
  const grossByParty = new Map(partyIds.map((id) => [id, lines.filter((entry) => partyOf(entry.line.partyId) === id).reduce((sum, entry) => sum + entry.gross, ZERO)]));
  const roomByParty = new Map(partyIds.map((id) => [id, lines.filter((entry) => partyOf(entry.line.partyId) === id).reduce((sum, entry) => sum + entry.room, ZERO)]));

  // The formula, party by party; a party without an advance recovers nothing.
  const formula = new Map<string, bigint>();
  const roomLeft = new Map<string, bigint>();
  for (const id of partyIds) {
    const party = input.parties.find((candidate) => candidate.partyId === id);
    if (party === undefined) {
      formula.set(id, ZERO);
      roomLeft.set(id, ZERO);
      continue;
    }
    const taken = partyRecovery(party, grossByParty.get(id)!.toString());
    formula.set(id, BigInt(taken.recoveryVnd));
    roomLeft.set(id, BigInt(taken.roomLeftVnd));
  }
  const formulaTotal = [...formula.values()].reduce((sum, value) => sum + value, ZERO);

  // The extra recovery goes where the advances have room left, by the largest remainder on that room.
  const roomTotal = [...roomLeft.values()].reduce((sum, value) => sum + value, ZERO);
  if (extra > roomTotal) throw invalid('advance_recovery_extra_vnd', 'EXTRA_EXCEEDS_OUTSTANDING');
  const extraShares = allocateLargestRemainder(
    extra,
    partyIds.map((id) => ({ key: id, weight: roomLeft.get(id)!, capacity: roomLeft.get(id)! })),
  );
  const extraByParty = new Map(partyIds.map((id, index) => [id, extraShares[index]!]));

  // Within each party the recovery is shared over its lines by gross, never above what a line can carry.
  const recoveryByLine = new Map<string, bigint>();
  for (const id of partyIds) {
    const own = lines.filter((entry) => partyOf(entry.line.partyId) === id);
    const want = formula.get(id)! + extraByParty.get(id)!;
    const carry = roomByParty.get(id)!;
    const target = want < carry ? want : carry;
    const shares = allocateLargestRemainder(
      target,
      own.map((entry) => ({ key: entry.line.boqItemId, weight: entry.gross, capacity: entry.room })),
    );
    own.forEach((entry, index) => recoveryByLine.set(entry.line.acceptanceLineId, shares[index]!));
  }

  const drafted: DraftLine[] = lines.map((entry) => {
    const recovery = recoveryByLine.get(entry.line.acceptanceLineId) ?? ZERO;
    return {
      acceptanceLineId: entry.line.acceptanceLineId,
      boqItemId: entry.line.boqItemId,
      partyId: entry.line.partyId,
      grossVnd: entry.gross.toString(),
      advanceRecoveryVnd: recovery.toString(),
      retentionVnd: entry.retention.toString(),
      netVnd: (entry.gross - recovery - entry.retention).toString(),
    };
  });
  const sum = (pick: (line: DraftLine) => string): bigint => drafted.reduce((total, line) => total + BigInt(pick(line)), ZERO);
  const gross = sum((line) => line.grossVnd);
  const recovery = sum((line) => line.advanceRecoveryVnd);
  const retention = sum((line) => line.retentionVnd);
  return {
    grossVnd: gross.toString(),
    advanceRecoveryVnd: recovery.toString(),
    retentionVnd: retention.toString(),
    taxAdjustmentVnd: tax.toString(),
    netVnd: (gross - recovery - retention + tax).toString(),
    lines: [...drafted].sort((a, b) => sortKey({ key: a.boqItemId + a.acceptanceLineId }, { key: b.boqItemId + b.acceptanceLineId })),
    formulaRecoveryVnd: formulaTotal.toString(),
  };
}

/** Whether the lines of a request add up to its header: gross, recovery and retention are the sums of the lines, and the net is that less the tax adjustment. */
export function linesMatchHeader(
  header: { grossVnd: string; advanceRecoveryVnd: string; retentionVnd: string; taxAdjustmentVnd: string; netVnd: string },
  lines: ReadonlyArray<{ grossVnd: string; advanceRecoveryVnd: string; retentionVnd: string; netVnd: string }>,
): boolean {
  const total = (pick: (line: (typeof lines)[number]) => string): bigint => lines.reduce((sum, line) => sum + BigInt(pick(line)), ZERO);
  const gross = total((line) => line.grossVnd);
  const recovery = total((line) => line.advanceRecoveryVnd);
  const retention = total((line) => line.retentionVnd);
  const net = total((line) => line.netVnd);
  return (
    gross === BigInt(header.grossVnd) &&
    recovery === BigInt(header.advanceRecoveryVnd) &&
    retention === BigInt(header.retentionVnd) &&
    net + BigInt(header.taxAdjustmentVnd) === BigInt(header.netVnd) &&
    BigInt(header.netVnd) === gross - recovery - retention + BigInt(header.taxAdjustmentVnd)
  );
}

/** One group of lines of a request that falls on one balance of the ledger: the same item and the same party. */
export interface ClaimGroup {
  boqItemId: string;
  partyId: string | null;
  grossVnd: string;
  advanceRecoveryVnd: string;
  retentionVnd: string;
}

/**
 * The lines of a request grouped by the balance of the ledger they fall on (item and party), in the order the ledger is locked and written: by the identifier of the item, then of the party (none
 * first). The gross, the recovery and the retention of a group are the sums of its lines.
 */
export function groupForLedger(lines: ReadonlyArray<{ boqItemId: string; partyId: string | null; grossVnd: string; advanceRecoveryVnd: string; retentionVnd: string }>): ClaimGroup[] {
  const groups = new Map<string, { boqItemId: string; partyId: string | null; gross: bigint; recovery: bigint; retention: bigint }>();
  for (const line of lines) {
    const key = `${line.boqItemId}|${line.partyId ?? ''}`;
    const group = groups.get(key) ?? { boqItemId: line.boqItemId, partyId: line.partyId, gross: ZERO, recovery: ZERO, retention: ZERO };
    group.gross += wholeVnd(line.grossVnd, 'gross_vnd');
    group.recovery += wholeVnd(line.advanceRecoveryVnd, 'advance_recovery_vnd');
    group.retention += wholeVnd(line.retentionVnd, 'retention_vnd');
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => (a.boqItemId < b.boqItemId ? -1 : a.boqItemId > b.boqItemId ? 1 : (a.partyId ?? '') < (b.partyId ?? '') ? -1 : (a.partyId ?? '') > (b.partyId ?? '') ? 1 : 0))
    .map((group) => ({ boqItemId: group.boqItemId, partyId: group.partyId, grossVnd: group.gross.toString(), advanceRecoveryVnd: group.recovery.toString(), retentionVnd: group.retention.toString() }));
}

/**
 * Takes `amount` of recovery out of the tranches of an advance, the earliest first, each up to what is still outstanding on it. Gives what each tranche gives (in the order of the tranches) and what
 * could not be placed: more than the advances hold outstanding is not a recovery that can be made (422 `ADVANCE_RECOVERY_EXCEEDED` in the command that asks).
 */
export function recoverFromTranches(outstanding: readonly string[], amountVnd: string): { taken: string[]; left: string } {
  let left = wholeVnd(amountVnd, 'advance_recovery_vnd');
  const taken = outstanding.map((room) => {
    const available = wholeVnd(room, 'outstanding_vnd');
    const part = left < available ? left : available;
    left -= part;
    return part.toString();
  });
  return { taken, left: left.toString() };
}
