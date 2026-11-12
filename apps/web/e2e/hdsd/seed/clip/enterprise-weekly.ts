import { vnd } from '../context.ts';
import type { Obj, SeedContext } from '../context.ts';
import TEXTS from '../data/enterprise-weekly.json' with { type: 'json' };
import { clipPlan } from './plan.ts';

/**
 * Group `clip-ent-weekly`: the "Giải ngân" menu (DIS-01..13, DIS-15). Eight weeks of weekly reports (W2026-39 to W2026-45) and two monthly reports with their narrative (M2026-09, M2026-10) for
 * the projects that hold a capital plan, handed in by the project officer and decided by the leader, each at the day of the stack clock it belongs to (a report is "late" or not by the clock of the
 * server when it is sent, so the seed moves the clock of the stack to the right day for every step and puts it back at the end, whatever happened).
 *
 * The story it tells: most reports are on time and accepted; one project sends a week late; one project does not report for a week at all (overdue on DIS-15); one report is returned, corrected
 * and accepted (revision 2); the report of the last closed week of one project stays returned; three reports of the last closed week wait for the leader; two drafts of the current week are in
 * preparation. W2026-46 of the six projects of `clip-ent-mobile` is left to that group (it hands them in and keeps them pending): this group only drafts W2026-46 for projects that group does not touch.
 *
 * Cumulative figures never go down from one week to the next and stay at or below what `clip-ent-mobile` reports for W2026-46, so that the next week is never a fall. The cumulative of a
 * weekly report is the amount disbursed to date by the project through its contracts; it is a different series from the annual disbursement of the enterprise snapshot (HOME-09) and does not feed it.
 *
 * Idempotent: the state of every report is read first (a report found past a step is left alone); the clock of the stack is restored in a `finally`.
 */

const MAKER = 'projectManager';
const LEADER = 'capApprover';
const DAY_MS = 86_400_000;

interface ProjectSpec {
  code: string;
  disbursedBn: number;
  constructionBn: number;
  acceptanceBn: number;
  submittedBn: number;
  progressPct: number;
  nextBn: number;
  phases: string[];
  difficulty: { from: number; to: number; text: string; solution: string; proposal: string };
}

const T = TEXTS as unknown as {
  fractions: number[];
  progressBack: number[];
  projects: ProjectSpec[];
  returnItems: { fix: string[]; leave: string[] };
  text: Record<string, string> & { reportReasons: Record<string, string> };
};

type Outcome = 'ACCEPT' | 'ACCEPT_LATE' | 'RETURN_FIX' | 'RETURN_LEAVE' | 'DRAFT' | 'SKIP';

/** The exceptions of the story, keyed "<project code>@<index>" (index 0 is W2026-39, 7 is W2026-46 and the month of November); every other report is on time and accepted. */
const WEEK_EXCEPTIONS: Record<string, Outcome> = {
  'DA-PMDT130@4': 'ACCEPT_LATE',
  'DA-PMTB191@3': 'SKIP',
  'DA-PMDT137@5': 'RETURN_FIX',
  // The open week: the six projects of clip-ent-mobile are left to that group.
  'DA-PMDT105@7': 'SKIP',
  'DA-PMDT114@7': 'SKIP',
  'DA-PMDT120@7': 'SKIP',
  'DA-PMTB164@7': 'SKIP',
  'DA-PMTB168@7': 'SKIP',
  'DA-PMTB172@7': 'SKIP',
  'DA-PMDT137@7': 'RETURN_FIX',
  'DA-PMTB180@7': 'RETURN_LEAVE',
  'DA-PMTB191@7': 'DRAFT',
};
/** The month of November (open): some reports are handed in and accepted, some are drafts in preparation, one project has not started. */
const MONTH_EXCEPTIONS: Record<string, Outcome> = {
  'DA-PMDT120@7': 'DRAFT',
  'DA-PMTB172@7': 'DRAFT',
  'DA-PMTB180@7': 'DRAFT',
  'DA-PMTB191@7': 'SKIP',
};
const FIRST_WEEK = 39;
const WEEKS = 8;

const fmt = (value: number): string => value.toFixed(1).replace('.', ',');
const money = (bn: number): string => vnd(Math.round(bn * 100) / 100);

interface Clock {
  offset: number;
  now: Date;
}

interface Row {
  id: string;
  status: string;
  revision: number;
  version: number;
}

interface Job {
  kind: 'WEEK' | 'MONTH';
  code: string;
  /** Index 0..6 into the series of the project (the week of the series the figures are those of). */
  index: number;
  periodId: string;
  endDate: string;
}

function apiBase(ctx: SeedContext): string {
  const given = process.env.CLIP_API_URL ?? '';
  return given === '' ? `http://127.0.0.1:${ctx.info.apiPort}` : given.replace(/\/+$/u, '');
}

async function readClock(base: string): Promise<Clock> {
  const body = (await (await fetch(`${base}/__e2e/clock`)).json()) as { offset_days: number; now: string };
  return { offset: Number(body.offset_days), now: new Date(body.now) };
}

async function writeClock(base: string, offset: number): Promise<void> {
  const reply = await fetch(`${base}/__e2e/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offset_days: offset }) });
  if (!reply.ok) throw new Error(`the clock of the stack cannot be set (HTTP ${reply.status})`);
}

/** The text of a report of a project in a week of the series: the eight structured fields of the enterprise pack and the four classic sections. */
function narrativeOf(project: ProjectSpec, index: number, monthly: boolean): Obj {
  const phase = project.phases[index < 2 ? 0 : index < 5 ? 1 : 2] ?? '';
  const hard = index >= project.difficulty.from && index <= project.difficulty.to;
  const fraction = T.fractions[index] ?? 1;
  const previous = T.fractions[index - 1] ?? 0;
  const total = project.disbursedBn * fraction;
  const step = project.disbursedBn * (fraction - previous);
  const disbursement = `${T.text.disbursementPrefix} ${fmt(total)} tỷ đồng${index > 0 ? `, tăng ${fmt(step)} tỷ đồng so với kỳ trước` : ''}; tiến độ vật lý ${fmt(project.progressPct - (T.progressBack[index] ?? 0))}%.`;
  const difficulty = hard ? project.difficulty.text : monthly ? T.text.noDifficultyMonth : T.text.noDifficulty;
  const solution = hard ? project.difficulty.solution : T.text.nextPlan;
  const proposal = hard ? project.difficulty.proposal : 'Không có đề xuất.';
  return {
    results: phase,
    causes: hard ? project.difficulty.text : T.text.noDifficulty,
    solutions: solution,
    proposals: proposal,
    enterprise: {
      status: phase,
      schedule: hard && index >= project.difficulty.from + 1 ? T.text.scheduleDelay : T.text.schedule,
      disbursement,
      difficulties: difficulty,
      solutions: solution,
      next_plan: T.text.nextPlan,
      proposals: proposal,
    },
  };
}

function figuresOf(project: ProjectSpec, index: number): Obj {
  const fraction = T.fractions[index] ?? 1;
  return {
    funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: money(project.disbursedBn * fraction), next_month_vnd: money(project.nextBn) }],
    construction_vnd: money(project.constructionBn * fraction),
    acceptance_vnd: money(project.acceptanceBn * fraction),
    treasury_submitted_vnd: money(project.submittedBn * fraction),
    preparing_dossier_vnd: vnd(0),
    physical_progress_pct: (project.progressPct - (T.progressBack[index] ?? 0)).toFixed(2),
  };
}

class Run {
  /** Projects that hold no capital plan in force (the report is refused); learned from the first refusal. */
  readonly unreportable = new Set<string>();
  /** Periods that ended before any capital plan was in force. */
  readonly noPlan = new Set<string>();
  readonly counts = { created: 0, submitted: 0, accepted: 0, returned: 0, corrected: 0, drafts: 0 };
  private day: string;
  private readonly origin: Clock;
  private readonly base: string;
  private readonly projectIds = new Map<string, string>();

  private readonly ctx: SeedContext;

  constructor(ctx: SeedContext, origin: Clock) {
    this.ctx = ctx;
    this.origin = origin;
    this.base = apiBase(ctx);
    this.day = ctx.today;
  }

  async prepare(): Promise<void> {
    for (const row of await this.ctx.list<Obj>(MAKER, '/resources/project')) this.projectIds.set(String(row.code), String(row.id));
  }

  /** Moves the clock of the stack to the day (never into the future of the real day), at the time of day the seed started. */
  async at(day: string): Promise<void> {
    const target = day > this.ctx.today ? this.ctx.today : day;
    if (target === this.day) return;
    const diff = Math.round((Date.parse(target) - Date.parse(this.ctx.today)) / DAY_MS);
    await writeClock(this.base, this.origin.offset + diff);
    this.day = target;
  }

  async restore(): Promise<void> {
    await writeClock(this.base, this.origin.offset);
    this.day = this.ctx.today;
  }

  now(): Promise<Clock> {
    return readClock(this.base);
  }

  /** The latest revision of the project in the period, or undefined. */
  async current(code: string, periodId: string): Promise<Row | undefined> {
    const projectId = this.projectIds.get(code);
    if (projectId === undefined) return undefined;
    const rows = (await this.ctx.list<Obj>(MAKER, '/resources/report_revision', { project_id: projectId, period_id: periodId })).filter((row) => row.status !== 'WITHDRAWN');
    rows.sort((a, b) => Number(b.revision) - Number(a.revision));
    const top = rows[0];
    return top === undefined ? undefined : { id: String(top.id), status: String(top.status), revision: Number(top.revision), version: Number(top.version) };
  }

  private async versionOf(person: string, id: string): Promise<number> {
    return Number((await this.ctx.get<Obj>(person, `/reports/${id}`)).version);
  }

  /** Starts the draft of a report (the text first with the enterprise block, then without it when an entry rule of the tenant refuses it). */
  async create(job: Job, project: ProjectSpec): Promise<string | undefined> {
    const type = job.kind === 'WEEK' ? 'WEEKLY' : 'MONTHLY';
    const text = narrativeOf(project, job.index, job.kind === 'MONTH');
    const enterprise = text.enterprise as Obj;
    const head = { project_id: this.projectIds.get(project.code), period_id: job.periodId, report_type: type, measurement_basis: 'PROJECT_TO_DATE', ...figuresOf(project, job.index) };
    for (const narrative of [text, { ...text, enterprise: undefined }, undefined]) {
      const reply = await this.ctx.call(MAKER, 'POST', '/reports', narrative === undefined ? head : { ...head, narrative });
      if (reply.ok) {
        this.counts.created += 1;
        return String(reply.json.resource_id);
      }
      const code = String((reply.json as Obj).code ?? '');
      if (code === 'PROJECT_STAGE_INVALID') {
        this.unreportable.add(project.code);
        return undefined;
      }
      if (code === 'PLAN_VERSION_NOT_EFFECTIVE') {
        // The plan of the project was published after the period ended (its effective instant is the day it was published): that week cannot be reported.
        if (!this.noPlan.has(job.code)) this.ctx.warn(`${job.code}: no capital plan was in force at the end of the period (${project.code}), the report of that period is left out`);
        this.noPlan.add(job.code);
        return undefined;
      }
      if (reply.status >= 500) this.ctx.expectOk(reply);
      this.ctx.warn(`${project.code} ${job.code}: POST /reports -> HTTP ${reply.status} ${reply.text.slice(0, 200)}`);
      if (enterprise === undefined) break;
    }
    return undefined;
  }

  async submit(person: string, id: string): Promise<boolean> {
    const reply = await this.ctx.attempt(person, 'POST', `/reports/${id}/submit`, {}, { version: await this.versionOf(person, id) });
    if (reply.ok) this.counts.submitted += 1;
    return reply.ok;
  }

  /** Creates (when absent) and hands in a report; a report found handed in is left alone. */
  async handIn(job: Job, project: ProjectSpec): Promise<void> {
    if (this.unreportable.has(project.code) || this.noPlan.has(job.code)) return;
    const row = await this.current(project.code, job.periodId);
    if (row !== undefined && row.status !== 'DRAFT') return;
    const id = row?.id ?? (await this.create(job, project));
    if (id === undefined) return;
    if (await this.submit(MAKER, id)) this.ctx.record({ module: 'DIS', screen: job.kind === 'WEEK' ? 'DIS-01' : 'DIS-13', kind: job.kind === 'WEEK' ? 'weekly-report' : 'monthly-report', id, code: `${project.code} ${job.code}`, note: '' });
  }

  async draftOnly(job: Job, project: ProjectSpec): Promise<void> {
    if (this.unreportable.has(project.code) || this.noPlan.has(job.code)) return;
    if ((await this.current(project.code, job.periodId)) !== undefined) return;
    const id = await this.create(job, project);
    if (id === undefined) return;
    this.counts.drafts += 1;
    this.ctx.record({ module: 'DIS', screen: 'DIS-01', kind: 'weekly-report-draft', id, code: `${project.code} ${job.code}`, note: T.text.reportReasons.draft ?? '' });
  }

  async decide(job: Job, project: ProjectSpec, decision: 'approve' | 'return', reason: string, items: string[] = []): Promise<void> {
    const row = await this.current(project.code, job.periodId);
    if (row === undefined || row.status !== 'SUBMITTED') return;
    const body: Obj = { decision, reason, evidence_ids: [] };
    if (decision === 'return') {
      body.return_items = items;
      body.due_at = new Date((await this.now()).now.getTime() + 3 * DAY_MS).toISOString();
    }
    const reply = await this.ctx.attempt(LEADER, 'POST', `/reports/${row.id}/decision`, body, { version: await this.versionOf(LEADER, row.id) });
    if (!reply.ok) return;
    if (decision === 'approve') this.counts.accepted += 1;
    else this.counts.returned += 1;
  }

  /** The maker answers a return with the next revision (the volumes put right), which is then handed in. */
  async correct(job: Job, project: ProjectSpec): Promise<void> {
    const row = await this.current(project.code, job.periodId);
    if (row === undefined) return;
    if (row.status === 'RETURNED') {
      const figures = figuresOf(project, job.index);
      const reply = await this.ctx.attempt(
        MAKER,
        'POST',
        `/reports/${row.id}/corrections`,
        {
          amendment_reason: T.text.correction,
          progress: { construction_vnd: figures.construction_vnd, acceptance_vnd: figures.acceptance_vnd, treasury_submitted_vnd: figures.treasury_submitted_vnd, preparing_dossier_vnd: figures.preparing_dossier_vnd, physical_progress_pct: figures.physical_progress_pct },
        },
        { version: await this.versionOf(MAKER, row.id) },
      );
      if (!reply.ok) return;
      this.counts.corrected += 1;
    }
    const next = await this.current(project.code, job.periodId);
    if (next !== undefined && next.status === 'DRAFT') await this.submit(MAKER, next.id);
  }
}

/** The weekly periods of the story and the two months. */
function addJobs(jobs: Job[], periods: Obj[]): void {
  for (let week = 0; week < WEEKS; week += 1) {
    const code = `W2026-${String(FIRST_WEEK + week)}`;
    const period = periods.find((row) => row.code === code && row.period_type === 'WEEK');
    if (period !== undefined) jobs.push({ kind: 'WEEK', code, index: week, periodId: String(period.id), endDate: String(period.end_date) });
  }
  for (const [code, index] of [['M2026-09', 0], ['M2026-10', 5], ['M2026-11', 7]] as const) {
    const period = periods.find((row) => row.code === code && row.period_type === 'MONTH');
    if (period !== undefined) jobs.push({ kind: 'MONTH', code, index, periodId: String(period.id), endDate: String(period.end_date) });
  }
}

const shift = (day: string, days: number): string => new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);

interface Step {
  day: string;
  run: () => Promise<void>;
}

/** The steps of a job, each with the day of the stack clock it belongs to, in order. */
function stepsOf(run: Run, job: Job, projects: ProjectSpec[]): Step[] {
  const steps: Step[] = [];
  // A weekly report is due on the last day of the week, a monthly one on the 5th of the next month.
  const dueDay = job.kind === 'WEEK' ? job.endDate : shift(`${job.endDate.slice(0, 7)}-01`, 35).slice(0, 8) + '05';
  const onTime = shift(dueDay, -1);
  for (const project of projects) {
    const exceptions = job.kind === 'WEEK' ? WEEK_EXCEPTIONS : job.index === 7 ? MONTH_EXCEPTIONS : {};
    const outcome: Outcome = exceptions[`${project.code}@${job.index}`] ?? 'ACCEPT';
    if (outcome === 'SKIP') continue;
    if (outcome === 'DRAFT') {
      steps.push({ day: onTime, run: () => run.draftOnly(job, project) });
      continue;
    }
    const sendDay = outcome === 'ACCEPT_LATE' ? shift(dueDay, 2) : onTime;
    steps.push({ day: sendDay, run: () => run.handIn(job, project) });
    if (outcome === 'RETURN_LEAVE') {
      steps.push({ day: shift(sendDay, 6), run: () => run.decide(job, project, 'return', T.text.returnLeave ?? '', T.returnItems.leave) });
    } else if (outcome === 'RETURN_FIX') {
      steps.push({ day: shift(sendDay, 1), run: () => run.decide(job, project, 'return', T.text.returnFix ?? '', T.returnItems.fix) });
      steps.push({ day: shift(sendDay, 2), run: () => run.correct(job, project) });
      steps.push({ day: shift(sendDay, 3), run: () => run.decide(job, project, 'approve', T.text.approve ?? '') });
    } else {
      steps.push({ day: shift(sendDay, 1), run: () => run.decide(job, project, 'approve', (job.kind === 'WEEK' ? T.text.approve : T.text.monthApprove) ?? '') });
    }
  }
  return steps.sort((a, b) => a.day.localeCompare(b.day));
}

/** Weekly commitments of disbursement (DIS-24, read only there): what the project officer commits to pay in each week, put beside what the bank paid in the weeks that are frozen. */
const COMMITMENT_BN: Record<string, number> = { 'DA-PMDT105': 2.4, 'DA-PMDT114': 1.2, 'DA-PMDT120': 3.1, 'DA-PMDT130': 4.5, 'DA-PMDT137': 1.6, 'DA-PMTB164': 0.8, 'DA-PMTB168': 2.2, 'DA-PMTB172': 0.7, 'DA-PMTB180': 1.1, 'DA-PMTB191': 0.4 };
const COMMITMENT_WEEKS = ['W2026-45', 'W2026-46', 'W2026-47', 'W2026-48'];

async function registerCommitments(ctx: SeedContext, periods: Obj[]): Promise<number> {
  const projects = new Map((await ctx.list<Obj>(MAKER, '/resources/project')).map((row) => [String(row.code), String(row.id)]));
  const have = new Set((await ctx.list<Obj>(MAKER, '/disbursement-schedules', { plan_year: ctx.year, granularity: 'WEEK', kind: 'WEEKLY_COMMITMENT' })).map((row) => `${String((row.project as Obj | null)?.id)}|${String((row.period as Obj | null)?.id)}`));
  let made = 0;
  for (const [code, billions] of Object.entries(COMMITMENT_BN)) {
    const projectId = projects.get(code);
    if (projectId === undefined) continue;
    for (const [index, weekCode] of COMMITMENT_WEEKS.entries()) {
      const period = periods.find((row) => row.code === weekCode && row.period_type === 'WEEK');
      if (period === undefined || have.has(`${projectId}|${String(period.id)}`)) continue;
      // The first week is only committed for the larger projects, so that the table shows both a week with an actual and weeks ahead.
      if (index === 0 && billions < 2) continue;
      const reply = await ctx.attempt(MAKER, 'POST', '/disbursement-schedules', { project_id: projectId, plan_year: ctx.year, granularity: 'WEEK', period_id: String(period.id), kind: 'WEEKLY_COMMITMENT', bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', amount_vnd: money(billions) });
      if (reply.ok) made += 1;
    }
  }
  return made;
}

export async function seedClipEnterpriseWeekly(ctx: SeedContext): Promise<void> {
  if (clipPlan()?.dataset !== 'enterprise') {
    ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
    return;
  }
  await ctx.syncClock();
  const base = apiBase(ctx);
  const origin = await readClock(base);
  const run = new Run(ctx, origin);
  try {
    await run.prepare();
    const periods = await ctx.list<Obj>(MAKER, '/resources/reporting_period', { calendar_code: 'DEFAULT' });
    const jobs: Job[] = [];
    addJobs(jobs, periods);
    if (jobs.length === 0) {
      ctx.warn('no weekly period of the year exists: the weekly reports are left out');
      return;
    }
    // Chronological: the report of a period is judged against what the periods before it reached.
    jobs.sort((a, b) => a.endDate.localeCompare(b.endDate));
    await ctx.step('DIS', 'weekly and monthly reports of the last weeks', async () => {
      for (const job of jobs) {
        for (const step of stepsOf(run, job, T.projects)) {
          if (run.noPlan.has(job.code)) break;
          await run.at(step.day);
          await step.run();
        }
      }
    });
    const commitments = await ctx.step('CAP', 'weekly disbursement commitments', () => registerCommitments(ctx, periods));
    ctx.log(`  [${ctx.group}] weekly commitments ${commitments}; reports made ${run.counts.created}, handed in ${run.counts.submitted}, accepted ${run.counts.accepted}, returned ${run.counts.returned}, corrected ${run.counts.corrected}, drafts ${run.counts.drafts}; periods without a plan in force: ${[...run.noPlan].join(', ') || '-'}; projects that cannot report: ${[...run.unreportable].join(', ') || '-'}`);
  } finally {
    await run.restore();
  }
}
