import { randomUUID } from 'node:crypto';
import {
  DomainError,
  LESSONS_RULE_TYPE,
  LOOK_AHEAD_RULE_CODE,
  assertLesson,
  assertNotProposer,
  lessonsDefaults,
  lessonsGate,
  lessonsPolicyOf,
  versionConflict,
  vietnamDateOf,
} from '@machvon/kernel';
import type { LessonDraft, LessonsGateReading, LessonsPolicy, Provenance } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const LESSON_RESOURCE = 'lesson_learned';
export const LESSON_WAIVER_RESOURCE = 'lesson_waiver';
const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export interface LessonsPolicyReading {
  policy: LessonsPolicy;
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  provenance: Provenance | null;
}

export interface LessonRow {
  id: string;
  projectId: string;
  category: string;
  title: string;
  situation: string;
  recommendation: string;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED';
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  version: number;
}

export interface WaiverRow {
  id: string;
  projectId: string;
  gate: string;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  version: number;
}

export interface LessonsView {
  project: { id: string; code: string; name: string; status: string };
  lessons: LessonRow[];
  waiver: WaiverRow | null;
  gate: LessonsGateReading;
  rule: LessonsPolicyReading;
}

interface LessonSql {
  id: string;
  project_id: string;
  category: string;
  title: string;
  situation: string;
  recommendation: string;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED';
  proposed_by: string;
  proposed_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  version: string;
}
interface WaiverSql {
  id: string;
  project_id: string;
  gate: string;
  reason: string;
  requested_by: string;
  requested_at: string;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  version: string;
}

const LESSON_COLUMNS = `id, project_id, category, title, situation, recommendation, status, proposed_by, ${ISO('proposed_at')} as proposed_at, decided_by, ${ISO('decided_at')} as decided_at, decision_note, version::text as version`;
const WAIVER_COLUMNS = `id, project_id, gate, reason, requested_by, ${ISO('requested_at')} as requested_at, status, decided_by, ${ISO('decided_at')} as decided_at, decision_note, version::text as version`;

const toLesson = (row: LessonSql): LessonRow => ({
  id: row.id,
  projectId: row.project_id,
  category: row.category,
  title: row.title,
  situation: row.situation,
  recommendation: row.recommendation,
  status: row.status,
  proposedBy: row.proposed_by,
  proposedAt: row.proposed_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionNote: row.decision_note,
  version: Number(row.version),
});
const toWaiver = (row: WaiverSql): WaiverRow => ({
  id: row.id,
  projectId: row.project_id,
  gate: row.gate,
  reason: row.reason,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  status: row.status,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionNote: row.decision_note,
  version: Number(row.version),
});

/**
 * The lessons learned of a project and the waiver of them (G1-19). A lesson is proposed by one person and approved or rejected by another; when the project has none to give, a waiver with a reason is asked
 * for and decided by a person other than who asked. The closing gate (`gate`) reads both and answers by the rule `LESSONS_LEARNED_POLICY`, and the stage store of PRJ refuses to close a project that does not
 * meet it. A person sees only the projects in the scope of the grant that holds the permission.
 */
export class PrjLessonsStore {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  async policy(tx: TenantTx, asOf: string | Date): Promise<LessonsPolicyReading> {
    const found = await this.port.get(tx, LESSONS_RULE_TYPE, LOOK_AHEAD_RULE_CODE, asOf);
    if (found === undefined) return { policy: lessonsPolicyOf(lessonsDefaults()), version: 0, source: 'DEFAULT', unverified: true, provenance: null };
    return { policy: lessonsPolicyOf(found.params), version: found.version, source: found.source, unverified: found.unverified, provenance: found.provenance };
  }

  private async project(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<{ id: string; code: string; name: string; status: string; ownerUnitId: string }> {
    const visible = scope(2);
    const rows = await tx.query<{ id: string; code: string; name: string; status: string; owner_unit_id: string }>(`select p.id, p.code, p.name, p.status, p.owner_unit_id from ${SCOPE_FROM} where p.id = $1::uuid and ${visible.sql} for update of p`, [projectId, ...visible.params]);
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { id: row.id, code: row.code, name: row.name, status: row.status, ownerUnitId: row.owner_unit_id };
  }

  /** The gate of a project on a gate name (`CLOSE`): what the stage store and the screen both ask. */
  async gate(tx: TenantTx, projectId: string, gate: string, now: Date): Promise<LessonsGateReading> {
    const rule = await this.policy(tx, vietnamDateOf(now));
    const counts = await tx.query<{ approved: string; pending: string }>(
      "select count(*) filter (where status = 'APPROVED')::text as approved, count(*) filter (where status = 'PROPOSED')::text as pending from machvon.lesson_learned where project_id = $1::uuid",
      [projectId],
    );
    const waiver = await tx.query<{ status: string }>("select status from machvon.lesson_waiver where project_id = $1::uuid and gate = $2 and status in ('REQUESTED', 'APPROVED')", [projectId, gate]);
    return lessonsGate({ gate, approved: Number(counts[0]?.approved ?? '0'), pending: Number(counts[0]?.pending ?? '0'), waiverApproved: waiver[0]?.status === 'APPROVED', waiverPending: waiver[0]?.status === 'REQUESTED' }, rule.policy);
  }

  async propose(tx: TenantTx, scope: ScopeBuilder, input: { projectId: string; draft: LessonDraft; actor: string; now: Date }): Promise<LessonRow> {
    const project = await this.project(tx, scope, input.projectId);
    const rule = await this.policy(tx, input.now);
    assertLesson(input.draft, rule.policy);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.lesson_learned (tenant_id, id, project_id, owner_unit_id, category, title, situation, recommendation, proposed_by, proposed_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9::timestamptz)`,
      [id, project.id, project.ownerUnitId, input.draft.category, input.draft.title.trim(), input.draft.situation.trim(), input.draft.recommendation.trim(), input.actor, input.now.toISOString()],
    );
    return this.lesson(tx, id);
  }

  async lesson(tx: TenantTx, id: string): Promise<LessonRow> {
    const rows = await tx.query<LessonSql>(`select ${LESSON_COLUMNS} from machvon.lesson_learned where id = $1::uuid`, [id]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toLesson(rows[0]);
  }

  /** Decides a lesson once, by a person other than who proposed it (403 `SELF_APPROVAL_DENIED`); a lesson that was decided is 409 `LESSON_STATE_INVALID`. */
  async decide(tx: TenantTx, scope: ScopeBuilder, input: { id: string; expectedVersion: number; decision: string; note: string | undefined; actor: string; now: Date }): Promise<LessonRow> {
    if (input.decision !== 'APPROVE' && input.decision !== 'REJECT') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    if (input.decision === 'REJECT' && (input.note === undefined || input.note.trim().length < 10)) throw new DomainError('VALIDATION_FAILED', 422, 'note');
    const visible = scope(2);
    const rows = await tx.query<{ id: string; status: string; proposed_by: string; version: string }>(
      `select l.id, l.status, l.proposed_by, l.version::text as version
         from machvon.lesson_learned l join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
        where l.id = $1::uuid and ${visible.sql} for update of l`,
      [input.id, ...visible.params],
    );
    const held = rows[0];
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(held.version) !== input.expectedVersion) throw versionConflict(Number(held.version));
    if (held.status !== 'PROPOSED') throw new DomainError('LESSON_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    assertNotProposer(input.actor, [held.proposed_by]);
    await tx.query("update machvon.lesson_learned set status = $2, decided_by = $3::uuid, decided_at = $4::timestamptz, decision_note = $5, version = version + 1 where id = $1::uuid", [input.id, input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', input.actor, input.now.toISOString(), input.note?.trim() ?? null]);
    return this.lesson(tx, input.id);
  }

  async requestWaiver(tx: TenantTx, scope: ScopeBuilder, input: { projectId: string; reason: string; actor: string; now: Date }): Promise<WaiverRow> {
    const project = await this.project(tx, scope, input.projectId);
    const rule = await this.policy(tx, input.now);
    if (!rule.policy.allowWaiver) throw new DomainError('LESSON_WAIVER_NOT_ALLOWED', 422, 'reason');
    if (input.reason.trim().length < 20 || input.reason.length > 2000) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const open = await tx.query<{ id: string }>("select id from machvon.lesson_waiver where project_id = $1::uuid and gate = 'CLOSE' and status in ('REQUESTED', 'APPROVED')", [project.id]);
    if (open[0] !== undefined) throw new DomainError('LESSON_STATE_INVALID', 409, 'project_id', { extensions: { waiver_id: open[0].id } });
    const id = randomUUID();
    await tx.query(
      `insert into machvon.lesson_waiver (tenant_id, id, project_id, owner_unit_id, gate, reason, requested_by, requested_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, 'CLOSE', $4, $5::uuid, $6::timestamptz)`,
      [id, project.id, project.ownerUnitId, input.reason.trim(), input.actor, input.now.toISOString()],
    );
    return this.waiver(tx, id);
  }

  async waiver(tx: TenantTx, id: string): Promise<WaiverRow> {
    const rows = await tx.query<WaiverSql>(`select ${WAIVER_COLUMNS} from machvon.lesson_waiver where id = $1::uuid`, [id]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toWaiver(rows[0]);
  }

  async decideWaiver(tx: TenantTx, scope: ScopeBuilder, input: { id: string; expectedVersion: number; decision: string; note: string | undefined; actor: string; now: Date }): Promise<WaiverRow> {
    if (input.decision !== 'APPROVE' && input.decision !== 'REJECT') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    if (input.decision === 'REJECT' && (input.note === undefined || input.note.trim().length < 10)) throw new DomainError('VALIDATION_FAILED', 422, 'note');
    const visible = scope(2);
    const rows = await tx.query<{ id: string; status: string; requested_by: string; version: string }>(
      `select w.id, w.status, w.requested_by, w.version::text as version
         from machvon.lesson_waiver w join ${SCOPE_FROM} on p.tenant_id = w.tenant_id and p.id = w.project_id
        where w.id = $1::uuid and ${visible.sql} for update of w`,
      [input.id, ...visible.params],
    );
    const held = rows[0];
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(held.version) !== input.expectedVersion) throw versionConflict(Number(held.version));
    if (held.status !== 'REQUESTED') throw new DomainError('LESSON_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    assertNotProposer(input.actor, [held.requested_by]);
    await tx.query('update machvon.lesson_waiver set status = $2, decided_by = $3::uuid, decided_at = $4::timestamptz, decision_note = $5, version = version + 1 where id = $1::uuid', [input.id, input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', input.actor, input.now.toISOString(), input.note?.trim() ?? null]);
    return this.waiver(tx, input.id);
  }

  /** The lessons of a project, its waiver and the answer of the closing gate, in the scope of the caller. */
  async view(tx: TenantTx, scope: ScopeBuilder, projectId: string, now: Date): Promise<LessonsView> {
    const visible = scope(2);
    const projects = await tx.query<{ id: string; code: string; name: string; status: string }>(`select p.id, p.code, p.name, p.status from ${SCOPE_FROM} where p.id = $1::uuid and ${visible.sql}`, [projectId, ...visible.params]);
    const project = projects[0];
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const lessons = await tx.query<LessonSql>(`select ${LESSON_COLUMNS} from machvon.lesson_learned where project_id = $1::uuid order by proposed_at desc, id`, [project.id]);
    const waivers = await tx.query<WaiverSql>(`select ${WAIVER_COLUMNS} from machvon.lesson_waiver where project_id = $1::uuid and gate = 'CLOSE' order by requested_at desc limit 1`, [project.id]);
    return { project, lessons: lessons.map(toLesson), waiver: waivers[0] === undefined ? null : toWaiver(waivers[0]), gate: await this.gate(tx, project.id, 'CLOSE', now), rule: await this.policy(tx, now) };
  }

  /** The projects that are completed or settled and do not meet the closing gate yet, in the scope of the caller: what the alert centre lists. */
  async missingAtClose(tx: TenantTx, scope: ScopeBuilder, now: Date, limit = 200): Promise<Array<{ projectId: string; projectCode: string; status: string; required: number; approved: number }>> {
    const visible = scope(1);
    const rows = await tx.query<{ id: string; code: string; status: string }>(`select p.id, p.code, p.status from ${SCOPE_FROM} where p.status in ('COMPLETED', 'SETTLED') and ${visible.sql} order by p.code, p.id limit ${Math.trunc(limit) * 3}`, [...visible.params]);
    const found: Array<{ projectId: string; projectCode: string; status: string; required: number; approved: number }> = [];
    for (const row of rows) {
      if (found.length >= limit) break;
      const gate = await this.gate(tx, row.id, 'CLOSE', now);
      if (!gate.met) found.push({ projectId: row.id, projectCode: row.code, status: row.status, required: gate.required, approved: gate.approved });
    }
    return found;
  }
}
