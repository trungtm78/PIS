import { FEEDBACK_RULE_TYPE, GOV10_SCREENS, message } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { forAudience } from './home-integrity-sources.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { SOURCE_LIMIT, base } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';

/** The permission of the people who review "this alert is wrong" reports (the owners of the alert types, on the whole tenant). */
export const ALERT_FEEDBACK_REVIEW_PERMISSION = 'alert.feedback.review';

const DAY_MS = 86_400_000;

/**
 * The reports "this alert is wrong" that wait for a review, as a source of the alert centre for the reviewers (G2-9, ALERT_TYPE `ALERT_FEEDBACK_REVIEW`). A report that waited longer than `pending_long_days` of the rule
 * `ALERT_FEEDBACK_POLICY` is to be acted on, a younger one is to be watched. The report is about an item; the item itself is never touched by it.
 */
export class HomeAlertFeedbackSources {
  private readonly port = new GovernancePolicyPort();

  async items(context: SourceContext): Promise<SourceRow[]> {
    const rule = await this.port.get(context.tx, FEEDBACK_RULE_TYPE, 'DEFAULT', context.today);
    const longDays = typeof rule?.params.pending_long_days === 'number' ? rule.params.pending_long_days : 7;
    const rows = await context.tx.query<{ id: string; alert_type_code: string; reason: string; created_at: string; created_on: string }>(
      `select f.id, f.alert_type_code, f.reason, to_char(f.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at, ((f.created_at) at time zone 'Asia/Ho_Chi_Minh')::date::text as created_on
         from machvon.alert_feedback f where f.status = 'PENDING' order by f.created_at, f.id limit ${SOURCE_LIMIT}`,
    );
    const items: SourceRow[] = rows.map((row) => {
      const waited = (context.now.getTime() - Date.parse(row.created_at)) / DAY_MS;
      return {
        ...base('ALERT_FEEDBACK_REVIEW'),
        id: row.id,
        dueOn: null,
        originalDueOn: null,
        title: message('home.source.feedback.title', { type: row.alert_type_code }),
        subtitle: message(`alert.feedback.reason.${row.reason.toLowerCase()}`),
        status: 'PENDING',
        severity: severityOf('ALERT_FEEDBACK', waited >= longDays ? 'PENDING_LONG' : 'PENDING', context.rules),
        consequence: CONSEQUENCES.ALERT_FEEDBACK_REVIEW ?? null,
        causeKey: `feedback:${row.id}`,
        startedAt: row.created_at,
        target: { screen: GOV10_SCREENS.alertFeedbackQueue, id: row.id },
      };
    });
    return forAudience(context, 'ALERT_FEEDBACK', ALERT_FEEDBACK_REVIEW_PERMISSION, items, true);
  }
}
