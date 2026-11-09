import type { Obj, SeedContext } from '../context.ts';
import TEXTS from '../data/enterprise-alerts.json' with { type: 'json' };
import { clipPlan } from './plan.ts';
import { publishAlertRules } from './public-alerts.ts';
import type { RuleSpec } from './public-alerts.ts';

/**
 * The early warnings of the enterprise demo (HOME-03, HOME-06), in two groups, both through the commands and the job of the product.
 *
 * `clip-ent-alerts` makes the rules (officer) and publishes them (leader, maker is not checker) BEFORE the weekly close snapshots are frozen. The warnings themselves are not made by the seed: the platform
 * evaluates the published rules when a snapshot is frozen (the job `dis.warning-evaluate` after `snapshot.frozen`, group `clip-ent-disbursement`). The metric that has figures on the enterprise plan is the late
 * weekly report (REPORT_OVERDUE: the plan of the enterprise is split into equity and loan, which the rate rules of the disbursement module do not read), so the three levels are three rules with their own days of grace:
 * to follow ("theo doi", INFO), to act on ("can xu ly", WARNING), urgent ("khan", CRITICAL).
 *
 * `clip-ent-alert-triage` runs after the freeze: the officer of the project board reads the warnings the job opened and handles them as a leader does (one level per project is kept open, the ones the project answered outside the system
 * are dismissed with a reason, one is acknowledged with a note), so the list of HOME-03 is a handful of warnings of the three levels and not one line for every rule of every project. Idempotent: it handles OPEN
 * warnings only, and a warning already handled is left as it is.
 */
const RULES: RuleSpec[] = [
  { rule_code: 'EW-DN-01', name: TEXTS['alerts.rule.info'], metric_code: 'REPORT_OVERDUE', comparator: 'MISSING', threshold_json: { grace_days: 0 }, severity: 'INFO' },
  { rule_code: 'EW-DN-02', name: TEXTS['alerts.rule.warning'], metric_code: 'REPORT_OVERDUE', comparator: 'MISSING', threshold_json: { grace_days: 1 }, severity: 'WARNING' },
  { rule_code: 'EW-DN-03', name: TEXTS['alerts.rule.critical'], metric_code: 'REPORT_OVERDUE', comparator: 'MISSING', threshold_json: { grace_days: 3 }, severity: 'CRITICAL' },
];
const RULE_CODES = RULES.map((rule) => rule.rule_code);
/** Handling a warning (acknowledge, dismiss) is the right `warning.handle` of the officer of the project board, over the projects of his scope. */
const HANDLER = 'projectManager';
/** The level each project (in the order of its code) keeps open; DROP is a project that answered outside the system: all its warnings are dismissed. */
const KEEP = ['CRITICAL', 'WARNING', 'WARNING', 'INFO', 'DROP', 'CRITICAL', 'WARNING', 'INFO', 'DROP', 'DROP'] as const;
const LEVELS = ['CRITICAL', 'WARNING', 'INFO'];

export async function seedClipEnterpriseAlerts(ctx: SeedContext): Promise<void> {
  if (clipPlan()?.dataset !== 'enterprise') {
    ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
    return;
  }
  await publishAlertRules(ctx, { rules: RULES, legalBasis: TEXTS['alerts.legalBasis'] });
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The open warnings of the rules of this group, waiting a while for the job that evaluates them after the freeze. */
async function openWarnings(ctx: SeedContext): Promise<Obj[]> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rows = (await ctx.list<Obj>(HANDLER, '/early-warnings', { status: 'OPEN' })).filter((row) => RULE_CODES.includes(String(row.rule_code)));
    if (rows.length > 0) return rows;
    await wait(2000);
  }
  return [];
}

export async function seedClipEnterpriseAlertTriage(ctx: SeedContext): Promise<void> {
  if (clipPlan()?.dataset !== 'enterprise') {
    ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
    return;
  }
  await ctx.step('DIS', 'early warnings handled by the officer', async () => {
    const warnings = await openWarnings(ctx);
    if (warnings.length === 0) {
      ctx.warn('the evaluation of the rules opened no warning: nothing to handle');
      return;
    }
    const byProject = new Map<string, Obj[]>();
    for (const row of warnings) {
      const code = String(((row.project ?? {}) as Obj).code ?? '');
      byProject.set(code, [...(byProject.get(code) ?? []), row]);
    }
    let acknowledged = false;
    let kept = 0;
    for (const [index, code] of [...byProject.keys()].sort().entries()) {
      const own = [...(byProject.get(code) ?? [])].sort((a, b) => String(b.opened_at).localeCompare(String(a.opened_at)));
      const wanted = KEEP[index % KEEP.length] ?? 'INFO';
      const keep = wanted === 'DROP' ? undefined : (own.find((row) => row.severity === wanted) ?? own.sort((a, b) => LEVELS.indexOf(String(a.severity)) - LEVELS.indexOf(String(b.severity)))[0]);
      for (const row of own) {
        const body = { reason: row === keep ? TEXTS['alerts.triage.acknowledged'] : wanted === 'DROP' ? TEXTS['alerts.triage.dismissed'] : TEXTS['alerts.triage.merged'] };
        if (row === keep) {
          kept += 1;
          // One of the urgent ones is taken up by the leader (status "acknowledged", still to be handled); the others stay open.
          if (!acknowledged && row.severity === 'CRITICAL') {
            acknowledged = true;
            await ctx.attempt(HANDLER, 'POST', `/early-warnings/${String(row.id)}/acknowledge`, body, { version: Number(row.version) });
          }
          continue;
        }
        await ctx.attempt(HANDLER, 'POST', `/early-warnings/${String(row.id)}/dismiss`, body, { version: Number(row.version) });
      }
    }
    ctx.log(`  [alerts] ${warnings.length} warnings opened by the job, ${kept} kept to be handled`);
  });
}
