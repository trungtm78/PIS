import { signedAmountText } from '../../ctr/change/model';

export { signedAmountText };

/** The permission of the read (x-permission in openapi.json); the server judges it again, with the scope, and never gives the ledger to a contractor. */
export const LEDGER_PERMISSION = 'ledger.read';

export const LEDGER_PATH = '/pay/pay-10';

/** The cumulative ledger of a contract (PAY-10), optionally narrowed to one BOQ item and one acceptance. */
export function ledgerLink(contractId: string, filter: { itemId?: string | undefined; acceptanceId?: string | undefined } = {}): string {
  const query = new URLSearchParams({ contract: contractId });
  if (filter.itemId !== undefined) query.set('item', filter.itemId);
  if (filter.acceptanceId !== undefined) query.set('acceptance', filter.acceptanceId);
  return `${LEDGER_PATH}?${query.toString()}`;
}

export const ENTRY_KINDS = [
  'RECOGNIZE_ACCEPTANCE',
  'REVOKE_ACCEPTANCE',
  'CLAIM',
  'CLAIM_RELEASE',
  'PAYMENT',
  'PAYMENT_REVERSAL',
  'ADVANCE_RECOVERY',
  'ADVANCE_RECOVERY_REVERSAL',
  'RETENTION_HOLD',
  'RETENTION_RELEASE',
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

// ---- what the server answers ---------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const SIGNED = /^-?[0-9]+$/;
/** An amount in whole dong, as the exact text the server sent. */
const amount = (value: unknown): string | undefined => (typeof value === 'string' && SIGNED.test(value) ? value : undefined);

/** What a balance (or the sum of balances) holds, in whole dong as exact decimal texts. */
export interface Balance {
  acceptedVnd: string;
  requestedVnd: string;
  paidVnd: string;
  advanceRecoveredVnd: string;
  retentionHeldVnd: string;
}

export interface LedgerEntry {
  id: string;
  kind: EntryKind;
  acceptedDeltaVnd: string;
  requestedDeltaVnd: string;
  paidDeltaVnd: string;
  advanceRecoveryDeltaVnd: string;
  retentionDeltaVnd: string;
  advanceOutstandingAfterVnd: string;
  reversalOfId: string | null;
  /** The payment request an entry belongs to, when it belongs to one. */
  paymentRequestId: string | null;
  reason: string | null;
  postedAt: string;
}

export interface LedgerLine extends Balance {
  id: string;
  boqItemId: string;
  boqItemKey: string;
  description: string;
  unitCode: string;
  acceptanceId: string;
  acceptanceNo: string | null;
  partyId: string | null;
  entries: LedgerEntry[];
}

export interface LedgerContract {
  id: string;
  code: string;
  contractValueVnd: string;
  acceptedTotalVnd: string;
  requestedTotalVnd: string;
  paidTotalVnd: string;
  advanceOutstandingVnd: string;
  retentionHeldVnd: string;
  retentionReleasedVnd: string;
}

export interface Ledger {
  contract: LedgerContract;
  items: LedgerLine[];
  total: Balance;
  reconciled: boolean;
  nextCursor: string | null;
  asOf: string;
}

function toBalance(row: Raw | undefined): Balance | undefined {
  const acceptedVnd = amount(row?.accepted_vnd);
  const requestedVnd = amount(row?.requested_vnd);
  const paidVnd = amount(row?.paid_vnd);
  const advanceRecoveredVnd = amount(row?.advance_recovered_vnd);
  const retentionHeldVnd = amount(row?.retention_held_vnd);
  if (acceptedVnd === undefined || requestedVnd === undefined || paidVnd === undefined || advanceRecoveredVnd === undefined || retentionHeldVnd === undefined) return undefined;
  return { acceptedVnd, requestedVnd, paidVnd, advanceRecoveredVnd, retentionHeldVnd };
}

function toEntry(raw: unknown): LedgerEntry | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const kind = ENTRY_KINDS.find((candidate) => candidate === row?.kind);
  const acceptedDeltaVnd = amount(row?.accepted_delta_vnd);
  const requestedDeltaVnd = amount(row?.requested_delta_vnd);
  const paidDeltaVnd = amount(row?.paid_delta_vnd);
  const advanceRecoveryDeltaVnd = amount(row?.advance_recovery_delta_vnd);
  const retentionDeltaVnd = amount(row?.retention_delta_vnd);
  const advanceOutstandingAfterVnd = amount(row?.advance_outstanding_after_vnd);
  const postedAt = text(row?.posted_at);
  if (
    row === undefined ||
    id === undefined ||
    kind === undefined ||
    acceptedDeltaVnd === undefined ||
    requestedDeltaVnd === undefined ||
    paidDeltaVnd === undefined ||
    advanceRecoveryDeltaVnd === undefined ||
    retentionDeltaVnd === undefined ||
    advanceOutstandingAfterVnd === undefined ||
    postedAt === undefined
  ) {
    return undefined;
  }
  return { id, kind, acceptedDeltaVnd, requestedDeltaVnd, paidDeltaVnd, advanceRecoveryDeltaVnd, retentionDeltaVnd, advanceOutstandingAfterVnd, reversalOfId: nullableText(row.reversal_of_id), paymentRequestId: nullableText(row.payment_request_id), reason: nullableText(row.reason), postedAt };
}

function toLine(raw: unknown): LedgerLine | undefined {
  const row = asRecord(raw);
  const balance = toBalance(row);
  const id = text(row?.id);
  const boqItemId = text(row?.boq_item_id);
  const acceptanceId = text(row?.acceptance_id);
  if (row === undefined || balance === undefined || id === undefined || boqItemId === undefined || acceptanceId === undefined) return undefined;
  return {
    ...balance,
    id,
    boqItemId,
    boqItemKey: text(row.boq_item_key) ?? '',
    description: text(row.description) ?? '',
    unitCode: text(row.unit_code) ?? '',
    acceptanceId,
    acceptanceNo: nullableText(row.acceptance_no),
    partyId: nullableText(row.party_id),
    entries: (Array.isArray(row.entries) ? row.entries : []).flatMap((entry) => toEntry(entry) ?? []),
  };
}

/** The page of the ledger the server answers; undefined when it is not one (a page that cannot be read is not shown half). */
export function toLedger(value: unknown): Ledger | undefined {
  const row = asRecord(value);
  const contract = asRecord(row?.contract);
  const total = toBalance(asRecord(row?.total));
  const id = text(contract?.id);
  const code = text(contract?.code);
  const contractValueVnd = amount(contract?.contract_value_vnd);
  const acceptedTotalVnd = amount(contract?.accepted_total_vnd);
  const requestedTotalVnd = amount(contract?.requested_total_vnd);
  const paidTotalVnd = amount(contract?.paid_total_vnd);
  const advanceOutstandingVnd = amount(contract?.advance_outstanding_vnd);
  const retentionHeldVnd = amount(contract?.retention_held_vnd);
  const retentionReleasedVnd = amount(contract?.retention_released_vnd);
  if (
    row === undefined ||
    total === undefined ||
    id === undefined ||
    code === undefined ||
    contractValueVnd === undefined ||
    acceptedTotalVnd === undefined ||
    requestedTotalVnd === undefined ||
    paidTotalVnd === undefined ||
    advanceOutstandingVnd === undefined ||
    retentionHeldVnd === undefined ||
    retentionReleasedVnd === undefined ||
    !Array.isArray(row.items)
  ) {
    return undefined;
  }
  return {
    contract: { id, code, contractValueVnd, acceptedTotalVnd, requestedTotalVnd, paidTotalVnd, advanceOutstandingVnd, retentionHeldVnd, retentionReleasedVnd },
    items: row.items.flatMap((item) => toLine(item) ?? []),
    total,
    reconciled: row.reconciled === true,
    nextCursor: nullableText(row.next_cursor),
    asOf: text(row.as_of) ?? '',
  };
}

/** The pages read so far as one ledger: the contract and the totals of the first, the lines of all in order. */
export function joinPages(pages: readonly Ledger[]): Ledger | undefined {
  const first = pages[0];
  const last = pages[pages.length - 1];
  if (first === undefined || last === undefined) return undefined;
  return { ...first, items: pages.flatMap((page) => page.items), nextCursor: last.nextCursor };
}

// ---- what the screen shows -------------------------------------------------------------------------------------------------

/** What of the accepted value is still free to be requested for payment on a line (never below zero). */
export function availableVnd(line: Balance): string {
  const free = BigInt(line.acceptedVnd) - BigInt(line.requestedVnd);
  return (free < 0n ? 0n : free).toString();
}

export const isReversal = (entry: Pick<LedgerEntry, 'reversalOfId'>): boolean => entry.reversalOfId !== null;

/** The distinct items and acceptances of the lines, for the filters, in the order they first appear. */
export function filterOptions(lines: readonly LedgerLine[]): { items: Array<{ id: string; label: string }>; acceptances: Array<{ id: string; label: string }> } {
  const items = new Map<string, string>();
  const acceptances = new Map<string, string>();
  for (const line of lines) {
    if (!items.has(line.boqItemId)) items.set(line.boqItemId, line.boqItemKey);
    if (!acceptances.has(line.acceptanceId)) acceptances.set(line.acceptanceId, line.acceptanceNo ?? line.acceptanceId);
  }
  return { items: [...items].map(([id, label]) => ({ id, label })), acceptances: [...acceptances].map(([id, label]) => ({ id, label })) };
}

/** The moment of an entry in the time of Vietnam, in the language of the screen. */
export function dateTimeText(iso: string, locale: string): string {
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(moment);
}
