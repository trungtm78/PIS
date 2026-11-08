import { VND2C_TEXT, VENDOR_FACET_SEVERITY, poorStreak, streakSuggestion, vnd2cText } from '@machvon/kernel';
import type { WorkKind } from '@machvon/kernel';
import { forAudience } from './home-integrity-sources.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { base } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import { VendorPerformanceStore } from './vendor-performance-store.ts';
import type { VendorRatingLine } from './vendor-performance-store.ts';
import { VendorRiskStore } from './vendor-risk-store.ts';

/** The permissions the audiences of these alerts read them with, on the whole tenant (a register of contractors belongs to no unit). */
export const GAMMA_AUDIENCE_PERMISSIONS = { performance: 'vnd.performance.publish', risk: 'vnd.risk.decide' } as const;

const severity = (facet: string, context: SourceContext): SourceRow['severity'] => severityOf('VENDOR', facet, context.rules) ?? VENDOR_FACET_SEVERITY[facet] ?? 'ACTION';

type Fields = Pick<SourceRow, 'title' | 'subtitle' | 'status' | 'dueOn' | 'originalDueOn' | 'target'> & { startedAt?: string | null; causeKey: string };

function row(kind: WorkKind, id: string, facet: string, context: SourceContext, fields: Fields): SourceRow {
  return { ...base(kind), id, severity: severity(facet, context), consequence: CONSEQUENCES[kind] ?? null, ...fields };
}

/**
 * The alerts of the risk grade and of the performance of a contractor (VND-2, V13 and V4), read when the alert centre is read (no job):
 *  - `VENDOR_PERFORMANCE_PUBLISH`: an adopted rating not yet published, within the reminder window of the six months (DUE_SOON) or past them (OVERDUE).
 *  - `VENDOR_PERFORMANCE_RESPONSE`: the contractor answered and the rating is not adopted yet, near the end of the review window (DUE_SOON) or past it (OVERDUE).
 *  - `VENDOR_POOR_STREAK`: a contractor whose latest ratings are poor, from the second one (STREAK).
 *  - `VENDOR_RISK_REVIEW`: a grade waiting for its second person (PENDING) or a grade in force past its review day (OVERDUE).
 */
export async function gammaVendorAlerts(context: SourceContext): Promise<SourceRow[]> {
  const performance = new VendorPerformanceStore();
  const risk = new VendorRiskStore();
  const rows: SourceRow[] = [];
  const all = await performance.worklist(context.tx, { state: 'ALL', limit: 1000 }, context.today);
  const lines = all.lines;
  const publish: SourceRow[] = [];
  const response: SourceRow[] = [];
  for (const line of lines) {
    if (line.publication === null && (line.publicationClock === 'DUE_SOON' || line.publicationClock === 'OVERDUE')) publish.push(publishRow(line, context));
  }
  rows.push(...(await forAudience(context, 'VENDOR', GAMMA_AUDIENCE_PERMISSIONS.performance, publish, true)));
  const open = await openResponses(performance, context);
  for (const line of open) response.push(responseRow(line, context));
  rows.push(...(await forAudience(context, 'VENDOR', GAMMA_AUDIENCE_PERMISSIONS.performance, response, true)));

  const streaks = await streakRows(performance, context);
  rows.push(...(await forAudience(context, 'VENDOR', GAMMA_AUDIENCE_PERMISSIONS.risk, streaks, true)));

  const riskRows: SourceRow[] = [];
  for (const one of await risk.waiting(context.tx)) {
    riskRows.push(
      row('VENDOR_RISK_REVIEW', one.id, 'PENDING', context, {
        title: vnd2cText(VND2C_TEXT.risk_pending_title, { tier: one.tier, name: one.contractorName }),
        subtitle: vnd2cText(VND2C_TEXT.risk_pending_detail, { assessed: one.assessedAt.slice(0, 10), score: one.score }),
        status: 'PENDING',
        dueOn: context.today,
        originalDueOn: one.assessedAt.slice(0, 10),
        causeKey: `vendor-risk-pending:${one.contractorId}`,
        startedAt: one.assessedAt,
        target: { screen: 'VND-11', id: one.contractorId },
      }),
    );
  }
  for (const one of await risk.register(context.tx, { reviewDue: true, limit: 500 }, context.today)) {
    if (one.nextReviewOn === null || one.tier === null) continue;
    riskRows.push(
      row('VENDOR_RISK_REVIEW', `due:${one.contractorId}`, 'REVIEW_OVERDUE', context, {
        title: vnd2cText(VND2C_TEXT.risk_overdue_title, { tier: one.tier, name: one.name }),
        subtitle: vnd2cText(VND2C_TEXT.risk_overdue_detail, { due: one.nextReviewOn }),
        status: 'OVERDUE',
        dueOn: one.nextReviewOn,
        originalDueOn: one.nextReviewOn,
        causeKey: `vendor-risk-review:${one.contractorId}`,
        target: { screen: 'VND-11', id: one.contractorId },
      }),
    );
  }
  rows.push(...(await forAudience(context, 'VENDOR', GAMMA_AUDIENCE_PERMISSIONS.risk, riskRows, true)));
  return rows;
}

function publishRow(line: VendorRatingLine, context: SourceContext): SourceRow {
  const facet = line.publicationClock === 'OVERDUE' ? 'OVERDUE' : 'DUE_SOON';
  const due = line.publicationDueOn as string;
  return row('VENDOR_PERFORMANCE_PUBLISH', line.proposalId, facet, context, {
    title: vnd2cText(VND2C_TEXT.publish_title, { contract: line.contractCode, name: line.contractorName }),
    subtitle: vnd2cText(VND2C_TEXT.publish_detail, { due, status: line.publicationClock as string }),
    status: line.publicationClock as string,
    dueOn: due,
    originalDueOn: due,
    causeKey: `vendor-performance-publish:${line.proposalId}`,
    target: { screen: 'VND-12', id: line.contractorId },
  });
}

function responseRow(line: VendorRatingLine, context: SourceContext): SourceRow {
  const facet = line.responseReview === 'OVERDUE' ? 'OVERDUE' : 'DUE_SOON';
  const received = line.responseReceivedOn as string;
  return row('VENDOR_PERFORMANCE_RESPONSE', line.proposalId, facet, context, {
    title: vnd2cText(VND2C_TEXT.response_title, { contract: line.contractCode, name: line.contractorName }),
    subtitle: vnd2cText(VND2C_TEXT.response_detail, { received, status: line.responseReview }),
    status: line.responseReview,
    dueOn: context.today,
    originalDueOn: received,
    causeKey: `vendor-performance-response:${line.proposalId}`,
    target: { screen: 'VND-12', id: line.contractorId },
  });
}

/** Ratings the contractor answered that wait for the investor, near the end of the review window or past it. */
async function openResponses(performance: VendorPerformanceStore, context: SourceContext): Promise<VendorRatingLine[]> {
  const found = await context.tx.query<{ contractor_id: string }>("select distinct contractor_id from machvon.contract_rating_proposal where state = 'RESPONDED'");
  const out: VendorRatingLine[] = [];
  for (const one of found) {
    const history = await performance.history(context.tx, one.contractor_id, context.today);
    out.push(...history.lines.filter((line) => line.state === 'RESPONDED' && (line.responseReview === 'DUE_SOON' || line.responseReview === 'OVERDUE')));
  }
  return out;
}

async function streakRows(performance: VendorPerformanceStore, context: SourceContext): Promise<SourceRow[]> {
  const found = await context.tx.query<{ contractor_id: string }>("select distinct contractor_id from machvon.contract_rating_proposal where state = 'ADOPTED' and rating = 'POOR'");
  const out: SourceRow[] = [];
  for (const one of found) {
    const history = await performance.history(context.tx, one.contractor_id, context.today);
    const streak = poorStreak(performance.rated(history.lines));
    const suggestion = streakSuggestion(streak, history.policy.value);
    if (suggestion === 'NONE') continue;
    const name = history.lines[0]?.contractorName ?? one.contractor_id;
    out.push(
      row('VENDOR_POOR_STREAK', one.contractor_id, 'STREAK', context, {
        title: vnd2cText(VND2C_TEXT.streak_title, { name, count: streak }),
        subtitle: vnd2cText(VND2C_TEXT.streak_detail, { suggestion }),
        status: suggestion,
        dueOn: context.today,
        originalDueOn: context.today,
        causeKey: `vendor-poor-streak:${one.contractor_id}`,
        target: { screen: 'VND-12', id: one.contractor_id },
      }),
    );
  }
  return out;
}
