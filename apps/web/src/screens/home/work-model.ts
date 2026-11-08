type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

export const WORK_KINDS = [
  'APPROVAL',
  'EXPLANATION',
  'REPORT_RETURNED',
  'REPORT_DRAFT_OVERDUE',
  'EXPLANATION_REVIEW',
  'MNE_OBLIGATION',
  // The sources of the alert centre (packages/kernel/src/home-work.ts).
  'EARLY_WARNING',
  'ADVANCE_OVERDUE',
  'PERMIT_EXPIRY',
  'AUDIT_RECOMMENDATION_OVERDUE',
  'ISSUE_SLA_BREACH',
  'SITE_DIARY_MISSING',
  'GUARANTEE_EXPIRING',
  // The money control (lane B2).
  'EAC_EXCEEDS_TMDT',
  'RESERVE_BELOW_RISK_EV',
  'ADVANCE_EXCEEDS_REMAINING',
  // The directives of the steering meetings (lane DIR-1).
  'DIRECTIVE_DUE',
  'DIRECTIVE_OVERDUE',
  // The native clocks of the alert centre (lane GOV-2).
  'CLOCK_DEADLINE',
  // The monitoring of the procurement workflow (lane PRC-1).
  'PRC_STEP_OVERDUE',
  'PRC_CHECKLIST_DUE',
  'PRC_PACKAGE_STALLED',
  'PRC_NO_OWNER',
  // The integrity of the money and of the duties (lane D) and the alert of the baseline to the auditors (lane B1): integration GOV-INT.
  'TREASURY_RECON_ITEM_OVERDUE',
  'CROSS_TOTAL_MISMATCH',
  'SOD_EXCEPTION_EXPIRING',
  'SOD_EXCEPTION_USED',
  'PAYMENT_INTEGRITY_BLOCKED',
  'PAYMENT_INTEGRITY_SIGNAL',
  'DISBURSEMENT_EXCEPTION_EXPIRING',
  'RESCHEDULE_COUNT',
  // The Treasury answer to a complete dossier is near its end, or past it (lane GOV-11a).
  'PAYMENT_CLOCK_NEAR',
  'PAYMENT_CLOCK_BREACHED',
  // The projection to a directive milestone is below its target (lane GOV-11a).
  'DIS_MILESTONE_AT_RISK',
  'CONTRACT_SETTLEMENT_NEAR',
  'CONTRACT_SETTLEMENT_OVERDUE',
  'CONTRACT_BASELINE_REVIEW',
  'LOOK_AHEAD_NOT_READY',
  'LOOK_AHEAD_MISSING',
  'LESSONS_LEARNED_MISSING',
  // The connection to the national procurement network is older than its rule allows (lane EGP-1).
  'CONNECTOR_STALE',
  // The duties of posting to the national procurement network: one near its deadline, one past it (lane EGP-2).
  'EGP_POSTING_DUE',
  'EGP_POSTING_OVERDUE',
  'VENDOR_RESTRICTED_EXPOSURE',
  'VENDOR_REPUTATION_POST',
  'VENDOR_DEBARMENT_DECISION',
  'VENDOR_PAYEE_ACCOUNT',
  'VENDOR_QUALIFICATION_EXPIRY',
  // The claim register and the early-warning register of a contract (lane GOV-8).
  'CLAIM_LIMITATION_APPROACHING',
  'CLAIM_LIMITATION_MISSED',
  'CLAIM_RESPONSE_DUE',
  'CLAIM_SETTLEMENT_OVERDUE',
  'EW_REGISTER_OVERDUE',
  'EW_MEETING_OVERDUE',
  'EW_ACTION_OVERDUE',
  // The governance of the alert system (lane GOV-9a): an item sent up to the person by the chain of escalation, and a gap in the coverage of the receivers of alerts.
  'ESCALATED_ITEM',
  'COVERAGE_GAP',
  // GOV-10: the clocks of a contract, a document review, a dataset that is not fresh, an anomaly, a red flag (auditors only) and a report that an alert was wrong.
  'CONTRACT_END_NEAR',
  'CONTRACT_PAYMENT_UNREQUESTED',
  'DOC_REVIEW_OVERDUE',
  'DATA_STALE',
  'ANOMALY_SIGNAL',
  'RED_FLAG_NEW',
  'ALERT_FEEDBACK_REVIEW',
  // The Integration Hub (lane HUB-1): a failing connector, many connectors stale at once.
  'CONNECTOR_FAILING',
  'CONNECTOR_HUB_STALE',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export const BUCKETS = ['OVERDUE', 'NEAR', 'LATER'] as const;
export type Bucket = (typeof BUCKETS)[number];

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined);

export interface WorkItem {
  id: string;
  kind: WorkKind;
  title: string;
  subtitle: string | null;
  status: string;
  dueOn: string | null;
  originalDueOn: string | null;
  bucket: Bucket;
  daysLate: number;
  target: { screen: string; id: string };
}

export interface WorkPage {
  items: WorkItem[];
  nextCursor: string | undefined;
  /** The counts of the whole list, whatever page was read. */
  counts: Record<string, number>;
  /** A source had more than it gives: the list and the counts are a part of the work, not all of it. */
  truncated: boolean;
}

function toItem(raw: unknown): WorkItem | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = oneOf(raw.kind, WORK_KINDS);
  const bucket = oneOf(raw.bucket, BUCKETS);
  if (kind === undefined || bucket === undefined || text(raw.id) === '' || !isRecord(raw.target) || text(raw.target.screen) === '') return undefined;
  return {
    id: text(raw.id),
    kind,
    title: text(raw.title),
    subtitle: nullableText(raw.subtitle),
    status: text(raw.status),
    dueOn: nullableText(raw.due_on),
    originalDueOn: nullableText(raw.original_due_on),
    bucket,
    daysLate: count(raw.days_late),
    target: { screen: text(raw.target.screen), id: text(raw.target.id) },
  };
}

export function toWorkPage(raw: unknown): WorkPage {
  const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items.flatMap((item) => toItem(item) ?? []) : [];
  const counts: Record<string, number> = {};
  if (isRecord(raw) && isRecord(raw.counts)) for (const [key, value] of Object.entries(raw.counts)) counts[key] = count(value);
  return { items, nextCursor: isRecord(raw) && typeof raw.next_cursor === 'string' ? raw.next_cursor : undefined, counts, truncated: isRecord(raw) && raw.truncated === true };
}

/** Where a task is opened from: the screens that take the id in the address do; the ones that do not are opened on their own list. A task whose screen is not known here is shown without a link. */
export function pathOf(item: Pick<WorkItem, 'target'>): string | undefined {
  switch (item.target.screen) {
    case 'PRJ-19':
      return '/prj/prj-19';
    case 'DIS-03':
      return `/dis/dis-03?report=${item.target.id}`;
    case 'MNE-03':
      return `/mne/mne-03?report=${item.target.id}`;
    // The money control (lane B2): the item names the project (CAP-22, PRJ-22) or the contract (PAY-18).
    case 'CAP-22':
      return `/cap/cap-22?project=${item.target.id}`;
    case 'PRJ-22':
      return `/prj/prj-22?project=${item.target.id}`;
    case 'PAY-18':
      return `/pay/pay-18?contract=${item.target.id}`;
    // The directives of the steering meetings (lane DIR-1): the item names the directive.
    case 'DIR-04':
      return `/dir/dir-04?directive=${item.target.id}`;
    // The integrity of the money (lane D): a payment request is opened by its id, a snapshot by its id; the registers (PAY-20, PAY-21, ADM-24, AUD-13) are opened on their own page.
    case 'PAY-03':
      return `/pay/pay-03?request=${item.target.id}`;
    case 'DIS-26':
      return `/dis/dis-26?snapshot=${item.target.id}`;
    // The claim register and the early-warning register of a contract (lane GOV-8): a claim by its id, the register of a contract by the id of the contract, a warning by its id.
    case 'CTR-33':
      return `/ctr/ctr-33?claim=${item.target.id}`;
    case 'CTR-35':
      return `/ctr/ctr-35?contract=${item.target.id}`;
    case 'CTR-36':
      return `/ctr/ctr-36?warning=${item.target.id}`;
    // The alert of the baseline (lane B1): the item names the project.
    case 'PRJ-26':
      return `/prj/prj-26?project=${item.target.id}`;
    // The management of contractors (lane VND-1): the item names the contractor (profile, accounts, certificates), the debarment case or the event of bid conduct.
    case 'VND-02':
    case 'VND-04':
    case 'VND-05':
      return `/vnd/${item.target.screen.toLowerCase()}?contractor=${item.target.id}`;
    case 'VND-03':
      return `/vnd/vnd-03?case=${item.target.id}`;
    case 'VND-06':
      return `/vnd/vnd-06?event=${item.target.id}`;
    // GOV-10: the red flag of procurement (auditors), the report that an alert was wrong, and the sources that name the contract, the document, the dataset, the advance or the adjustment.
    case 'AUD-15':
      return `/aud/aud-15?finding=${item.target.id}`;
    case 'HOME-30':
      return `/home/home-30?report=${item.target.id}`;
    case 'CTR-03':
      return `/ctr/ctr-03?contract=${item.target.id}`;
    case 'DOC-02':
      return `/doc/doc-02?document=${item.target.id}`;
    case 'DGV-04':
      return `/dgv/dgv-04?dataset=${item.target.id}`;
    case 'PAY-12':
      return `/pay/pay-12?advance=${item.target.id}`;
    case 'CAP-07':
      return `/cap/cap-07?proposal=${item.target.id}`;
    default:
      return undefined;
  }
}

/** The items of a column, in the order the server gave them. */
export const inBucket = (items: readonly WorkItem[], bucket: Bucket): WorkItem[] => items.filter((item) => item.bucket === bucket);
