import { randomUUID } from 'node:crypto';
import { NOOP_METRICS, RISK_SIGNAL_KINDS, RISK_SIGNAL_RULE_CODE, RISK_SIGNAL_RULE_TYPE, crossings, evidenceOf, lineMove, parseRiskSignalPolicy, scoreSignal, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink, RiskSignalPolicy, SignalScore } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { enqueueOutbox } from './outbox.ts';
import { RISK_ALERT_RESOURCE, RISK_SIGNAL_RESOURCE, RiskSignalStore } from './risk-signal-store.ts';
import type { RaisedAlert, SignalLine } from './risk-signal-store.ts';
import { RiskSignalReader } from './risk-signal-reader.ts';
import type { ProjectToScore } from './risk-signal-reader.ts';
import type { TenantTx } from './tenant-database.ts';

export const RISK_SIGNAL_SCORED_EVENT = 'project.risk_signal_scored.v1';
export const RISK_ALERT_RAISED_EVENT = 'project.risk_alert_raised.v1';
export const RISK_ALERT_RESOLVED_EVENT = 'project.risk_alert_resolved.v1';
/** The lines the pass wrote (opened, re-scored or cleared), summed over the tenants by the sweep (gauge). */
export const RISK_RESCORE_METRIC = 'prj_risk_signal_changed';
export const RISK_ALERT_METRIC = 'prj_risk_alert_raised_total';
const RESOURCE_TYPE = 'project_risk_rescore';
const PAGE = 200;
/** The most projects one pass reads, in the order of their code: a bound against a pass that never ends. */
const MAX_PROJECTS = 5000;
const MAX_REGISTER_ALERTS = 500;

export interface RiskRescoreResult {
  projects: number;
  opened: number;
  rescored: number;
  cleared: number;
  /** Kinds of a project whose indicators could not be read at all: the line (if any) was left as it was. */
  unavailable: number;
  alertsRaised: number;
  alertsResolved: number;
  ruleVersion: string;
  ruleUnverified: boolean;
}

/**
 * The job `risk-rescore` (MR-1, MR.02, G1-14): each pass re-scores the risk lines of every project the rule scores, from the live signals of the system (schedule delay by SPI and milestones, payment integrity, claims
 * and early warnings, funding gap, procurement delay). The thresholds, the impacts and the line from which a line opens are the rule `RISK_SIGNAL_POLICY` in force (through the governance port, else the starting
 * value flagged not verified), and the version that decided is stored on the line, on its history and on its alerts. Opening, re-scoring and clearing a line each write a row of the history with the evidence, an audit row
 * and the event `project.risk_signal_scored.v1` in the same transaction; a score that goes UP across the critical line or by the points of a jump raises an alert (`RISK_SCORE_CRITICAL`, `RISK_SCORE_JUMP`) once for a
 * subject and a day, and a standing critical alert ends the day the score falls below the line. The risks that people wrote (PRJ-16) at or above the critical line get the same alert. A line that was read again and did
 * not move writes nothing but the day it was last looked at, so running the pass twice, or two runners at once, changes nothing the second time.
 */
export class RiskRescoreJob {
  private readonly policies = new GovernancePolicyPort();
  private readonly reader: RiskSignalReader;
  private readonly store = new RiskSignalStore();
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly metrics: MetricsSink;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, metrics: MetricsSink = NOOP_METRICS, reader: RiskSignalReader = new RiskSignalReader()) {
    this.audit = audit;
    this.metrics = metrics;
    this.reader = reader;
  }

  /** The rule in force on the day, with the version text stored beside every score ('built-in:1' for the starting value nobody approved). */
  async policyOf(tx: TenantTx, today: string): Promise<{ policy: RiskSignalPolicy; version: string; unverified: boolean }> {
    const found = await this.policies.require(tx, RISK_SIGNAL_RULE_TYPE, RISK_SIGNAL_RULE_CODE, today);
    return { policy: parseRiskSignalPolicy(found.params), version: found.source === 'DEFAULT' ? 'built-in:1' : String(found.version), unverified: found.unverified };
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<RiskRescoreResult> {
    const today = vietnamDateOf(now);
    const { policy, version, unverified } = await this.policyOf(tx, today);
    const result: RiskRescoreResult = { projects: 0, opened: 0, rescored: 0, cleared: 0, unavailable: 0, alertsRaised: 0, alertsResolved: 0, ruleVersion: version, ruleUnverified: unverified };
    let after: string | undefined;
    while (result.projects < MAX_PROJECTS) {
      const page = await this.reader.projects(tx, policy.scoredStatuses, PAGE, after);
      if (page.length === 0) break;
      await this.pass(tx, page, { policy, version, unverified, today, actor, now }, result);
      result.projects += page.length;
      after = page[page.length - 1]?.code;
      if (page.length < PAGE) break;
    }
    await this.registerAlerts(tx, { policy, version, unverified, today, actor, now }, result);
    const resolved = await this.store.resolveEnded(tx, policy.criticalScore, today);
    result.alertsResolved = resolved.length;
    for (const id of resolved) await this.record(tx, actor, now, 'project.risk_alert_resolved', RISK_ALERT_RESOLVED_EVENT, { alertId: id, version: 0 });
    return result;
  }

  private async pass(tx: TenantTx, projects: readonly ProjectToScore[], at: Context, result: RiskRescoreResult): Promise<void> {
    const readings = await this.reader.read(tx, projects, at.today);
    const lines = await this.store.linesOf(
      tx,
      projects.map((project) => project.id),
    );
    for (const project of projects) {
      const read = readings.get(project.id);
      if (read === undefined) continue;
      for (const kind of RISK_SIGNAL_KINDS) {
        const scored = scoreSignal(kind, read.readings, at.policy);
        const existing = lines.get(`${project.id}:${kind}`);
        const move = lineMove(existing, scored);
        const evidence = evidenceOf(scored, read.readings, read.facts);
        const write = { projectId: project.id, kind, likelihood: scored.likelihood, impact: scored.impact, evidence, ruleVersion: at.version, ruleUnverified: at.unverified, today: at.today };
        if (move === 'SKIP') {
          result.unavailable += 1;
        } else if (move === 'KEEP') {
          if (existing !== undefined) await this.store.touch(tx, existing, write);
        } else if (move === 'OPEN') {
          // The row is locked before it is changed, so two runners write one history row between them.
          const held = existing === undefined ? undefined : await this.store.lockLine(tx, project.id, kind);
          const line = await this.store.open(tx, write, held);
          if (line !== undefined) {
            result.opened += 1;
            await this.changed(tx, at, project, scored, line, 'OPEN', 0, result);
          }
        } else if (existing !== undefined) {
          const held = await this.store.lockLine(tx, project.id, kind);
          if (held !== undefined && held.version === existing.version) {
            const line = move === 'RESCORE' ? await this.store.rescore(tx, held, write) : await this.store.clear(tx, held, write);
            if (move === 'RESCORE') result.rescored += 1;
            else result.cleared += 1;
            await this.changed(tx, at, project, scored, line, move, held.status === 'ACTIVE' ? held.score : 0, result);
          }
        }
      }
    }
  }

  /** The history row, the audit row, the event and the alerts of one line that moved. */
  private async changed(tx: TenantTx, at: Context, project: ProjectToScore, scored: SignalScore, line: SignalLine, move: 'OPEN' | 'RESCORE' | 'CLEAR', priorScore: number, result: RiskRescoreResult): Promise<void> {
    await this.store.appendHistory(tx, {
      projectId: project.id,
      signalId: line.id,
      kind: line.signalKind,
      likelihood: line.likelihood,
      impact: line.impact,
      priorScore: priorScore === 0 ? null : priorScore,
      status: line.status,
      evidence: line.evidence,
      ruleVersion: at.version,
      today: at.today,
      actor: at.actor,
    });
    const correlationId = randomUUID();
    await this.audit.recordInTx(tx, at.actor, {
      action: 'project.risk_signal_scored',
      resourceType: RISK_SIGNAL_RESOURCE,
      resourceId: line.id,
      classification: 'INTERNAL',
      diff: { project_id: project.id, code: project.code, signal_kind: line.signalKind, move, status: line.status, score: line.score, prior_score: priorScore === 0 ? null : priorScore, rule_version: at.version },
      correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: RISK_SIGNAL_RESOURCE,
      aggregateId: line.id,
      aggregateVersion: line.version,
      type: RISK_SIGNAL_SCORED_EVENT,
      schemaVersion: 1,
      payload: {
        project_id: project.id,
        actor_id: at.actor,
        occurred_at: at.now.toISOString(),
        signal_id: line.id,
        signal_kind: line.signalKind,
        move,
        status: line.status,
        likelihood: line.likelihood,
        impact: line.impact,
        score: line.score,
        prior_score: priorScore === 0 ? null : priorScore,
        severity: scored.level,
        rule_version: at.version,
        rule_unverified: at.unverified,
      },
      eventKey: `${RISK_SIGNAL_RESOURCE}:${line.id}:${line.version}`,
      correlationId,
    });
    if (move === 'CLEAR') return;
    for (const crossing of crossings(priorScore, line.score, at.policy)) {
      const raised = await this.store.raiseAlert(tx, {
        projectId: project.id,
        alertType: crossing.alertType,
        subject: { kind: 'SIGNAL', signalId: line.id, signalKind: line.signalKind },
        score: line.score,
        priorScore,
        threshold: crossing.threshold,
        ruleVersion: at.version,
        ruleUnverified: at.unverified,
        today: at.today,
        actor: at.actor,
      });
      if (raised !== undefined) await this.announce(tx, at, raised, project.code, result);
    }
  }

  /** The risks of the register of PRJ-16 that reached the critical line and have no standing alert: one alert each. */
  private async registerAlerts(tx: TenantTx, at: Context, result: RiskRescoreResult): Promise<void> {
    const risks = await this.store.registerCritical(tx, at.policy.scoredStatuses, at.policy.criticalScore, MAX_REGISTER_ALERTS);
    for (const risk of risks) {
      const raised = await this.store.raiseAlert(tx, {
        projectId: risk.projectId,
        alertType: 'RISK_SCORE_CRITICAL',
        subject: { kind: 'REGISTER', riskId: risk.riskId },
        score: risk.score,
        priorScore: risk.priorScore,
        threshold: at.policy.criticalScore,
        ruleVersion: at.version,
        ruleUnverified: at.unverified,
        today: at.today,
        actor: at.actor,
      });
      if (raised !== undefined) await this.announce(tx, at, raised, '', result);
    }
  }

  private async announce(tx: TenantTx, at: Context, alert: RaisedAlert, projectCode: string, result: RiskRescoreResult): Promise<void> {
    result.alertsRaised += 1;
    this.metrics.increment(RISK_ALERT_METRIC);
    const correlationId = randomUUID();
    await this.audit.recordInTx(tx, at.actor, {
      action: 'project.risk_alert_raised',
      resourceType: RISK_ALERT_RESOURCE,
      resourceId: alert.id,
      classification: 'INTERNAL',
      diff: { project_id: alert.projectId, code: projectCode, alert_type: alert.alertType, subject_kind: alert.subjectKind, subject_id: alert.subjectId, score: alert.score, prior_score: alert.priorScore, threshold: alert.threshold, rule_version: at.version },
      correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: RISK_ALERT_RESOURCE,
      aggregateId: alert.id,
      aggregateVersion: 1,
      type: RISK_ALERT_RAISED_EVENT,
      schemaVersion: 1,
      payload: {
        project_id: alert.projectId,
        actor_id: at.actor,
        occurred_at: at.now.toISOString(),
        alert_id: alert.id,
        alert_type: alert.alertType,
        subject_kind: alert.subjectKind,
        subject_id: alert.subjectId,
        score: alert.score,
        prior_score: alert.priorScore,
        threshold: alert.threshold,
        rule_version: at.version,
        rule_unverified: at.unverified,
      },
      eventKey: `${RISK_ALERT_RESOURCE}:${alert.id}:raised`,
      correlationId,
    });
  }

  /** One audit row and one event for something that ended on its own (a standing alert whose score fell). */
  private async record(tx: TenantTx, actor: string, now: Date, action: string, type: string, what: { alertId: string; version: number }): Promise<void> {
    const correlationId = randomUUID();
    await this.audit.recordInTx(tx, actor, { action, resourceType: RISK_ALERT_RESOURCE, resourceId: what.alertId, classification: 'INTERNAL', diff: { alert_id: what.alertId, status: 'RESOLVED' }, reason: 'score_below_line', correlationId, requestId: randomUUID() });
    await enqueueOutbox(tx, {
      aggregateType: RISK_ALERT_RESOURCE,
      aggregateId: what.alertId,
      aggregateVersion: what.version + 1,
      type,
      schemaVersion: 1,
      payload: { alert_id: what.alertId, actor_id: actor, occurred_at: now.toISOString(), status: 'RESOLVED' },
      eventKey: `${RISK_ALERT_RESOURCE}:${what.alertId}:resolved`,
      correlationId,
    });
  }
}

interface Context {
  policy: RiskSignalPolicy;
  version: string;
  unverified: boolean;
  today: string;
  actor: string;
  now: Date;
}

