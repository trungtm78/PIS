/**
 * The proposals of a rating of the performance of a contractor (CA-3, CTR-37): the shapes the server answers with, read defensively (a body that is not what the contract says is an error of the read, never an empty
 * list), and the checks of the forms before they are sent. The server judges every command again: the person who proposed does not notify and does not adopt, the contractor has a window to answer.
 */

export const RATING_CRITERIA = ['quality', 'schedule', 'safety_env', 'cooperation', 'financial'] as const;
export type RatingCriterion = (typeof RATING_CRITERIA)[number];
export const RATING_KINDS = ['PERIODIC', 'COMPLETION', 'TERMINATION'] as const;
export const RESPONSE_KINDS = ['ACCEPT', 'DISPUTE', 'NO_COMMENT'] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];

export const RATING_READ_PERMISSION = 'contractor.performance.read';
export const RATING_PROPOSE_PERMISSION = 'contractor.performance.propose';

export interface CriterionView {
  score: number | null;
  reason: string | null;
  readings: Record<string, number | string>;
}

export interface ProposalView {
  id: string;
  contractId: string;
  contractCode: string;
  kind: string;
  periodLabel: string;
  asOfDate: string;
  state: string;
  rule: { version: number; source: string };
  criteria: Record<string, CriterionView>;
  covered: number;
  overallScore: string | null;
  rating: string | null;
  proposedNote: string | null;
  notifiedAt: string | null;
  responseDueAt: string | null;
  clock: { status: string; dueAt: string; basis: string } | null;
  response: { kind: string; text: string | null; receivedOn: string; at: string } | null;
  adopted: { at: string; evaluationId: string } | null;
  allowed: { notify: boolean; respond: boolean; adopt: boolean; withdraw: boolean };
  version: number;
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : undefined);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const int = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

function toCriteria(raw: unknown): Record<string, CriterionView> {
  const out: Record<string, CriterionView> = {};
  for (const [key, value] of Object.entries(rec(raw) ?? {})) {
    const row = rec(value);
    if (row === undefined) continue;
    const readings: Record<string, number | string> = {};
    for (const [name, reading] of Object.entries(rec(row.readings) ?? {})) if (typeof reading === 'number' || typeof reading === 'string') readings[name] = reading;
    out[key] = { score: int(row.score) ?? null, reason: strOrNull(row.reason), readings };
  }
  return out;
}

export function toProposal(raw: unknown): ProposalView | undefined {
  const row = rec(raw);
  const id = str(row?.id);
  const contractId = str(row?.contract_id);
  const state = str(row?.state);
  const version = int(row?.version);
  if (row === undefined || id === undefined || contractId === undefined || state === undefined || version === undefined) return undefined;
  const clock = rec(row.response_clock);
  const response = rec(row.response);
  const adopted = rec(row.adopted);
  const allowed = rec(row.allowed);
  const rule = rec(row.rule);
  return {
    id,
    contractId,
    contractCode: str(row.contract_code) ?? contractId,
    kind: str(row.evaluation_kind) ?? 'PERIODIC',
    periodLabel: str(row.period_label) ?? '',
    asOfDate: str(row.as_of_date) ?? '',
    state,
    rule: { version: int(rule?.version) ?? 0, source: str(rule?.source) ?? 'DEFAULT' },
    criteria: toCriteria(row.criteria),
    covered: int(row.covered) ?? 0,
    overallScore: strOrNull(row.overall_score),
    rating: strOrNull(row.rating),
    proposedNote: strOrNull(row.proposed_note),
    notifiedAt: strOrNull(rec(row.notified)?.at),
    responseDueAt: strOrNull(row.response_due_at),
    clock: clock === undefined ? null : { status: str(clock.status) ?? 'RUNNING', dueAt: str(clock.due_at) ?? '', basis: str(clock.basis) ?? '' },
    response: response === undefined ? null : { kind: str(response.kind) ?? '', text: strOrNull(response.text), receivedOn: str(response.received_on) ?? '', at: str(response.at) ?? '' },
    adopted: adopted === undefined ? null : { at: str(adopted.at) ?? '', evaluationId: str(adopted.evaluation_id) ?? '' },
    allowed: { notify: allowed?.notify === true, respond: allowed?.respond === true, adopt: allowed?.adopt === true, withdraw: allowed?.withdraw === true },
    version,
  };
}

export function toProposals(raw: unknown): ProposalView[] | undefined {
  const body = rec(raw);
  if (body === undefined || !Array.isArray(body.items)) return undefined;
  const items = body.items.map(toProposal);
  return items.some((item) => item === undefined) ? undefined : (items as ProposalView[]);
}

export const stateTone = (state: string): 'success' | 'warning' | 'danger' | 'neutral' => (state === 'ADOPTED' ? 'success' : state === 'RESPONDED' ? 'success' : state === 'NOTIFIED' ? 'warning' : state === 'WITHDRAWN' ? 'neutral' : 'neutral');
export const clockTone = (status: string): 'success' | 'warning' | 'danger' | 'neutral' => (status === 'LAPSED' || status === 'ANSWERED_LATE' ? 'danger' : status === 'NEAR' ? 'warning' : status === 'ANSWERED_IN_TIME' ? 'success' : 'neutral');

// ---- the forms --------------------------------------------------------------------------------------------------------------------------------------------------

export interface ProposeForm {
  kind: string;
  periodLabel: string;
  note: string;
}

export const emptyProposal = (): ProposeForm => ({ kind: '', periodLabel: '', note: '' });

/** The problem with a form, as the key of the field it is about; none when it can be sent. */
export function proposalProblem(form: ProposeForm): 'period' | undefined {
  const label = form.periodLabel.trim();
  return label === '' || label.length > 40 ? 'period' : undefined;
}

export function proposalBody(form: ProposeForm): Record<string, unknown> {
  return { period_label: form.periodLabel.trim(), ...(form.kind === '' ? {} : { evaluation_kind: form.kind }), ...(form.note.trim() === '' ? {} : { note: form.note.trim() }) };
}

export interface ResponseForm {
  kind: ResponseKind;
  receivedOn: string;
}

/** What the answer of the contractor needs: a dispute states its grounds (twenty characters), the day is a day and not in the future. */
export function responseProblem(form: ResponseForm, text: string, today: string): 'text' | 'day' | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.receivedOn) || form.receivedOn > today) return 'day';
  if (form.kind === 'DISPUTE' && text.trim().length < 20) return 'text';
  return undefined;
}

export function responseBody(form: ResponseForm, text: string): Record<string, unknown> {
  return { response_kind: form.kind, received_on: form.receivedOn, ...(text.trim() === '' ? {} : { response_text: text.trim() }) };
}

export interface OverrideForm {
  score: string;
  reason: string;
}

/** The overrides of the criteria that have no data: a whole score from 0 to 100 and a reason of twenty characters; a criterion left empty is not filled. */
export function overridesBody(overrides: Record<string, OverrideForm>): { body: Record<string, { score: number; reason: string }>; problem: string | undefined } {
  const body: Record<string, { score: number; reason: string }> = {};
  let problem: string | undefined;
  for (const [key, form] of Object.entries(overrides)) {
    if (form.score.trim() === '' && form.reason.trim() === '') continue;
    const score = Number(form.score);
    if (!/^\d{1,3}$/.test(form.score.trim()) || score > 100 || form.reason.trim().length < 20) {
      problem = key;
      continue;
    }
    body[key] = { score, reason: form.reason.trim() };
  }
  return { body, problem };
}

/** The criteria a proposal has no score for: the ones an adoption must fill. */
export const missingCriteria = (proposal: ProposalView): string[] => RATING_CRITERIA.filter((criterion) => (proposal.criteria[criterion]?.score ?? null) === null);
