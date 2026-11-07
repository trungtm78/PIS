/**
 * The checks of a payment request before money goes out (PAY-03 panel, PAY-21, AUD-12; G4-2, G4-5): what the server says is read once, here, into the shapes the screens use. Amounts stay whole-dong text
 * (never a float), a figure the server did not give is an empty text and never a zero, and an unknown code is shown as it came (a code a newer server adds is not hidden).
 */
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const int = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);

export const FINDING_CODES = ['DUPLICATE_CLAIM', 'UNIT_PRICE_OUTLIER', 'QUANTITY_VS_DIARY', 'EXCEEDS_CONTRACT', 'EXCEEDS_PLAN', 'EXCEEDS_ACCEPTED'] as const;
export type FindingCode = (typeof FINDING_CODES)[number];
export const isFindingCode = (value: string): value is FindingCode => (FINDING_CODES as readonly string[]).includes(value);
export type FindingKind = 'INVARIANT' | 'SIGNAL';
export type Outcome = 'PASSED' | 'SIGNALS' | 'BLOCKED' | 'PARTIAL';
export const EXCEPTION_CEILINGS = ['EXCEEDS_PLAN', 'EXCEEDS_CONTRACT'] as const;
export type ExceptionCeiling = (typeof EXCEPTION_CEILINGS)[number];
export type ExceptionStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'REVOKED' | 'USED' | 'EXPIRED';
export const EXCEPTION_STATUSES: readonly ExceptionStatus[] = ['REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED', 'USED', 'EXPIRED'];

/** A whole amount of dong as the reader of the locale writes it; text that is not a whole amount is shown as it came (never turned into zero). */
export function vnd(value: string | null | undefined, locale: string): string {
  if (value === null || value === undefined || value === '') return '';
  if (!/^-?\d{1,24}$/.test(value)) return value;
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'vi-VN').format(BigInt(value));
}

/** The day of an instant or a date, written dd/mm/yyyy; text that is neither is shown as it came. */
export function dayText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const matched = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return matched === null ? value : `${matched[3]}/${matched[2]}/${matched[1]}`;
}

export interface Finding {
  id: string;
  code: string;
  kind: FindingKind;
  excused: boolean;
  exceptionId: string | null;
  subject: Raw;
  params: Raw;
}

export interface Run {
  id: string;
  trigger: 'SUBMIT' | 'PREVIEW';
  outcome: Outcome;
  rule: { version: number; source: 'RULE' | 'DEFAULT'; unverified: boolean; params: Raw; formula: string; origin: string; asOf: string };
  asOf: string;
  invariantCount: number;
  signalCount: number;
  excusedCount: number;
  unavailable: string[];
  createdAt: string;
  findings: Finding[];
}

export interface Exception {
  id: string;
  paymentRequestId: string;
  requestNo: string | null;
  contractId: string;
  contractCode: string;
  ceiling: string;
  allowedAmountVnd: string;
  validTo: string;
  reason: string;
  status: ExceptionStatus;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decisionNote: string | null;
  daysLeft: number | null;
  version: number;
}

export interface Checks {
  paymentRequestId: string;
  requestStatus: string;
  run: Run | null;
  exceptions: Exception[];
  asOf: string;
}

const OUTCOMES: readonly string[] = ['PASSED', 'SIGNALS', 'BLOCKED', 'PARTIAL'];

export function toFinding(raw: Raw): Finding {
  return { id: str(raw.id), code: str(raw.code), kind: raw.kind === 'INVARIANT' ? 'INVARIANT' : 'SIGNAL', excused: raw.excused === true, exceptionId: strOrNull(raw.exception_id), subject: isRecord(raw.subject) ? raw.subject : {}, params: isRecord(raw.params) ? raw.params : {} };
}

export function toRun(raw: unknown): Run | null {
  if (!isRecord(raw) || str(raw.id) === '' || !OUTCOMES.includes(str(raw.outcome))) return null;
  const rule = isRecord(raw.rule) ? raw.rule : {};
  return {
    id: str(raw.id),
    trigger: raw.trigger === 'PREVIEW' ? 'PREVIEW' : 'SUBMIT',
    outcome: str(raw.outcome) as Outcome,
    rule: { version: int(rule.version), source: rule.source === 'RULE' ? 'RULE' : 'DEFAULT', unverified: rule.unverified !== false, params: isRecord(rule.params) ? rule.params : {}, formula: str(rule.formula), origin: str(rule.origin), asOf: str(rule.as_of) },
    asOf: str(raw.as_of),
    invariantCount: int(raw.invariant_count),
    signalCount: int(raw.signal_count),
    excusedCount: int(raw.excused_count),
    unavailable: Array.isArray(raw.unavailable) ? raw.unavailable.filter((one): one is string => typeof one === 'string') : [],
    createdAt: str(raw.created_at),
    findings: list(raw.findings).map(toFinding),
  };
}

export function toException(raw: Raw): Exception {
  const status = str(raw.status);
  return {
    id: str(raw.id),
    paymentRequestId: str(raw.payment_request_id),
    requestNo: strOrNull(raw.request_no),
    contractId: str(raw.contract_id),
    contractCode: str(raw.contract_code),
    ceiling: str(raw.ceiling),
    allowedAmountVnd: str(raw.allowed_amount_vnd),
    validTo: str(raw.valid_to),
    reason: str(raw.reason),
    status: (EXCEPTION_STATUSES as readonly string[]).includes(status) ? (status as ExceptionStatus) : 'REQUESTED',
    requestedBy: str(raw.requested_by),
    requestedAt: str(raw.requested_at),
    decidedBy: strOrNull(raw.decided_by),
    decisionNote: strOrNull(raw.decision_note),
    daysLeft: typeof raw.days_left === 'number' ? raw.days_left : null,
    version: int(raw.version),
  };
}

export function toChecks(raw: unknown): Checks | undefined {
  if (!isRecord(raw) || str(raw.payment_request_id) === '') return undefined;
  return { paymentRequestId: str(raw.payment_request_id), requestStatus: str(raw.request_status), run: toRun(raw.run), exceptions: list(raw.exceptions).map(toException), asOf: str(raw.as_of) };
}

export interface FindingLine extends Finding {
  runId: string;
  paymentRequestId: string;
  requestNo: string | null;
  contractId: string;
  contractCode: string;
  projectCode: string;
  trigger: 'SUBMIT' | 'PREVIEW';
  outcome: string;
  ruleVersion: number;
  createdAt: string;
}

export interface FindingPage {
  items: FindingLine[];
  nextCursor: string | null;
  asOf: string;
}

export function toFindingPage(raw: unknown): FindingPage {
  const page = isRecord(raw) ? raw : {};
  return {
    items: list(page.items).map((item) => ({
      ...toFinding(item),
      runId: str(item.run_id),
      paymentRequestId: str(item.payment_request_id),
      requestNo: strOrNull(item.request_no),
      contractId: str(item.contract_id),
      contractCode: str(item.contract_code),
      projectCode: str(item.project_code),
      trigger: item.trigger === 'PREVIEW' ? 'PREVIEW' : 'SUBMIT',
      outcome: str(item.outcome),
      ruleVersion: int(item.rule_version),
      createdAt: str(item.created_at),
    })),
    nextCursor: strOrNull(page.next_cursor),
    asOf: str(page.as_of),
  };
}

export interface ExceptionPage {
  items: Exception[];
  expiringWithinDays: number;
  asOf: string;
}

export function toExceptionPage(raw: unknown): ExceptionPage {
  const page = isRecord(raw) ? raw : {};
  return { items: list(page.items).map(toException), expiringWithinDays: int(page.expiring_within_days), asOf: str(page.as_of) };
}

/** The figures of a finding a reader can check, as label keys and values (amounts are formatted by the caller). */
export function figuresOf(finding: Pick<Finding, 'code' | 'params'>): Array<{ key: string; value: string; money: boolean }> {
  const p = finding.params;
  const out: Array<{ key: string; value: string; money: boolean }> = [];
  const money = (key: string, value: unknown): void => {
    if (typeof value === 'string' && value !== '') out.push({ key, value, money: true });
  };
  const plain = (key: string, value: unknown): void => {
    if (typeof value === 'string' && value !== '') out.push({ key, value, money: false });
    else if (typeof value === 'number') out.push({ key, value: String(value), money: false });
    else if (Array.isArray(value) && value.length > 0) out.push({ key, value: value.join(', '), money: false });
  };
  switch (finding.code) {
    case 'EXCEEDS_CONTRACT':
      money('priceVnd', p.price_vnd);
      money('projectedRequestedVnd', p.projected_requested_vnd);
      money('projectedCashOutVnd', p.projected_cash_out_vnd);
      money('overByVnd', p.over_by_vnd);
      plain('basis', p.basis);
      break;
    case 'EXCEEDS_PLAN':
      money('allocatedVnd', p.allocated_vnd);
      money('disbursedVnd', p.disbursed_vnd);
      money('inFlightVnd', p.in_flight_vnd);
      money('netVnd', p.net_vnd);
      money('availableVnd', p.available_vnd);
      money('overByVnd', p.over_by_vnd);
      break;
    case 'EXCEEDS_ACCEPTED':
      money('acceptedVnd', p.accepted_vnd);
      money('projectedClaimedVnd', p.projected_claimed_vnd);
      money('overByVnd', p.over_by_vnd);
      break;
    case 'DUPLICATE_CLAIM':
      plain('matched', p.matched);
      money('grossVnd', p.gross_vnd);
      money('otherGrossVnd', p.other_gross_vnd);
      break;
    case 'UNIT_PRICE_OUTLIER':
      plain('unitPrice', p.unit_price);
      plain('contractUnitPrice', p.contract_unit_price);
      plain('contractDeviationPct', p.contract_deviation_pct);
      plain('peerMedian', p.peer_median);
      plain('peerCount', p.peer_count);
      plain('reasons', p.reasons);
      break;
    case 'QUANTITY_VS_DIARY':
      plain('reason', p.reason);
      plain('workingDays', p.working_days);
      plain('daysWithDiary', p.days_with_diary);
      plain('measured', p.measured);
      plain('recorded', p.recorded);
      break;
    default:
      for (const [key, value] of Object.entries(p)) plain(key, value);
  }
  return out;
}

/** An exception can still be decided or taken back by whoever may; one past its day or used is only read. */
export function exceptionTone(status: ExceptionStatus): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  switch (status) {
    case 'APPROVED':
      return 'success';
    case 'REQUESTED':
      return 'warning';
    case 'REJECTED':
    case 'REVOKED':
      return 'danger';
    case 'USED':
      return 'info';
    default:
      return 'neutral';
  }
}

export function outcomeTone(outcome: Outcome): 'success' | 'warning' | 'danger' | 'neutral' {
  return outcome === 'PASSED' ? 'success' : outcome === 'BLOCKED' ? 'danger' : outcome === 'SIGNALS' ? 'warning' : 'neutral';
}

const WHOLE = /^[1-9]\d{0,23}$/;
export const isWholeAmount = (value: string): boolean => WHOLE.test(value);

/** The route of the payment request the checks belong to (PAY-03). */
export const requestLink = (id: string): string => `/pay/pay-03?request=${encodeURIComponent(id)}`;
