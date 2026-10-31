import { randomUUID } from 'node:crypto';
import { DomainError, EVALUATION_TRIGGER_KINDS, EVALUATION_TRIGGER_STATUSES, assertTriggerStage, earliestDueOn, isPostHandoverKind, nextTriggerStatus, vietnamDateOf } from '@machvon/kernel';
import type { EvaluationTriggerKind, EvaluationTriggerStatus } from '@machvon/kernel';
import { calendarDate } from './ctr-contract-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE = 200;
const UNIQUE_VIOLATION = '23505';

export const EVALUATION_TRIGGER_RESOURCE = 'evaluation_trigger';
export const EVALUATION_TRIGGER_SCHEDULED_EVENT = 'ast.evaluation_trigger.scheduled.v1';
export const EVALUATION_TRIGGER_ACKNOWLEDGED_EVENT = 'ast.evaluation_trigger.acknowledged.v1';

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};

/** The scopes a command on a trigger is judged by: the one of its permission decides, the one of the right to read tells a refusal from a miss. */
export interface TriggerScopes {
  update: ScopeBuilder;
  read: ScopeBuilder;
}

export interface ScheduleInput {
  projectId: string;
  triggerKind: string;
  sourceHandoverId?: string | undefined;
  dueOn: string;
}

export interface TriggerFilter {
  projectId?: string | undefined;
  status?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/** What a command did to a trigger: the facts the audit row and the event carry. */
export interface TriggerResult {
  id: string;
  projectId: string;
  triggerKind: EvaluationTriggerKind;
  sourceHandoverId: string | null;
  dueOn: string;
  mneEvaluationId: string | null;
  fromStatus: EvaluationTriggerStatus | null;
  status: EvaluationTriggerStatus;
  version: number;
}

export interface TriggerLine {
  id: string;
  project: { id: string; code: string; name: string };
  triggerKind: EvaluationTriggerKind;
  handover: { id: string; handoverNo: string | null; acceptedOn: string | null } | null;
  dueOn: string;
  status: EvaluationTriggerStatus;
  firedAt: string | null;
  evaluation: { id: string; evaluationKind: string; status: string } | null;
  createdAt: string;
  version: number;
}

/** A trigger that fell due and was fired by the job: the facts its event carries and the one who is told. */
export interface FiredTrigger {
  id: string;
  projectId: string;
  triggerKind: EvaluationTriggerKind;
  sourceHandoverId: string | null;
  dueOn: string;
  version: number;
  recipientId: string;
  ownerUnit: { id: string; path: string };
  investorUnit: { id: string; path: string } | null;
}

interface LineSql {
  id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  trigger_kind: EvaluationTriggerKind;
  handover_id: string | null;
  handover_no: string | null;
  accepted_on: string | null;
  due_on: string;
  status: EvaluationTriggerStatus;
  fired_at: string | null;
  evaluation_id: string | null;
  evaluation_kind: string | null;
  evaluation_status: string | null;
  created_at: string;
  version: string;
}

interface Held {
  id: string;
  project_id: string;
  trigger_kind: EvaluationTriggerKind;
  source_handover_id: string | null;
  due_on: string;
  status: EvaluationTriggerStatus;
  version: string;
}

/** The project of a trigger with the two units its scope is judged by: the aliases `p`, `ou` and `iu` of the scope of a project. */
const PROJECT_JOINS = `join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;
const PROJECT_FROM = `machvon.project p ${PROJECT_JOINS}`;
const TRIGGER_PROJECT_FROM = `machvon.evaluation_trigger t join machvon.project p on p.tenant_id = t.tenant_id and p.id = t.project_id ${PROJECT_JOINS}`;

const FROM = `${TRIGGER_PROJECT_FROM}
  left join machvon.handover h on h.tenant_id = t.tenant_id and h.id = t.source_handover_id
  left join machvon.mne_evaluation e on e.tenant_id = t.tenant_id and e.id = t.mne_evaluation_id`;

const SELECT = `select t.id, t.project_id, p.code as project_code, p.name as project_name, t.trigger_kind, h.id as handover_id, h.handover_no,
       (h.accepted_at at time zone 'Asia/Ho_Chi_Minh')::date::text as accepted_on, t.due_on::text as due_on, t.status, ${timestampKey('t.fired_at')} as fired_at,
       e.id as evaluation_id, e.evaluation_kind, e.status as evaluation_status, ${timestampKey('t.created_at')} as created_at, t.version::text as version
  from ${FROM}`;

const toLine = (row: LineSql): TriggerLine => ({
  id: row.id,
  project: { id: row.project_id, code: row.project_code, name: row.project_name },
  triggerKind: row.trigger_kind,
  handover: row.handover_id === null ? null : { id: row.handover_id, handoverNo: row.handover_no, acceptedOn: row.accepted_on },
  dueOn: row.due_on,
  status: row.status,
  firedAt: row.fired_at,
  evaluation: row.evaluation_id === null ? null : { id: row.evaluation_id, evaluationKind: row.evaluation_kind ?? '', status: row.evaluation_status ?? '' },
  createdAt: row.created_at,
  version: Number(row.version),
});

/**
 * The trigger of the evaluation after the investment (ST-AST-006, AST 3.4, UC-AST-04, UAT-AC394). A trigger is set for a project: after an accepted handover it falls due 12 or 24 months after the day
 * the handover was accepted (and not before), after the settlement of the project when that is closed, or by hand. Setting it twice is 409 `TRIGGER_DUPLICATE`. The job fires a trigger on its day,
 * once; MNE does the evaluation and acknowledges the trigger with it. Nothing here evaluates.
 */
export class AstEvaluationStore {
  async schedule(tx: TenantTx, input: ScheduleInput, actor: string, scopes: TriggerScopes, now: Date): Promise<TriggerResult> {
    const projectId = idOf(input.projectId, 'project_id');
    const kind = EVALUATION_TRIGGER_KINDS.find((candidate) => candidate === input.triggerKind) ?? this.badField('trigger_kind');
    const dueOn = calendarDate(input.dueOn, 'due_on');
    const handoverId = input.sourceHandoverId === undefined ? null : idOf(input.sourceHandoverId, 'source_handover_id');

    const project = await this.project(tx, projectId, scopes);
    assertTriggerStage(kind, project.status);
    if (handoverId === null && isPostHandoverKind(kind)) throw invalid('source_handover_id');
    if (handoverId !== null) await this.assertHandover(tx, kind, handoverId, projectId, dueOn);
    // A trigger after a handover has its earliest day; the others are not set for a day that has gone.
    if (!isPostHandoverKind(kind) && dueOn < vietnamDateOf(now)) throw invalid('due_on', 'IN_THE_PAST');

    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.evaluation_trigger (tenant_id, id, project_id, trigger_kind, source_handover_id, due_on, status, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5::date, 'SCHEDULED', $6::uuid, $6::uuid, 1)`,
        [id, projectId, kind, handoverId, dueOn, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('TRIGGER_DUPLICATE', 409, 'trigger_kind', { extensions: { trigger_kind: kind } });
      throw error;
    }
    return { id, projectId, triggerKind: kind, sourceHandoverId: handoverId, dueOn, mneEvaluationId: null, fromStatus: null, status: 'SCHEDULED', version: 1 };
  }

  /** MNE did the evaluation: the trigger that was fired is acknowledged with it; the trigger is locked first, so two acknowledgements cannot both succeed. */
  async acknowledge(tx: TenantTx, id: string, mneEvaluationId: string, actor: string, scopes: TriggerScopes): Promise<TriggerResult> {
    const evaluationId = idOf(mneEvaluationId, 'mne_evaluation_id');
    const held = await this.lock(tx, idOf(id, 'id'), scopes);
    const status = nextTriggerStatus(held.status, 'ACKNOWLEDGE');
    const evaluations = await tx.query<{ project_id: string }>('select project_id from machvon.mne_evaluation where id = $1::uuid', [evaluationId]);
    if (evaluations[0] === undefined) throw invalid('mne_evaluation_id', 'NOT_FOUND');
    if (evaluations[0].project_id !== held.project_id) throw invalid('mne_evaluation_id', 'NOT_AN_EVALUATION_OF_THE_PROJECT');
    const version = Number(held.version) + 1;
    await tx.query(
      `update machvon.evaluation_trigger
          set status = $2, mne_evaluation_id = $3::uuid, updated_at = now(), updated_by = $4::uuid, version = $5::bigint
        where id = $1::uuid`,
      [held.id, status, evaluationId, actor, version],
    );
    return {
      id: held.id,
      projectId: held.project_id,
      triggerKind: held.trigger_kind,
      sourceHandoverId: held.source_handover_id,
      dueOn: held.due_on,
      mneEvaluationId: evaluationId,
      fromStatus: held.status,
      status,
      version,
    };
  }

  /** The triggers in the scope of the caller, the newest first; the cursor is the creation time and the id. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: TriggerFilter): Promise<TriggerLine[]> {
    const project = filter.projectId === undefined ? null : idOf(filter.projectId, 'project_id');
    const status = filter.status === undefined ? null : (EVALUATION_TRIGGER_STATUSES.find((candidate) => candidate === filter.status) ?? this.badField('status'));
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    assertTimestampCursor(filter.after?.code);
    const predicate = scope(6);
    const rows = await tx.query<LineSql>(
      `${SELECT} where ${predicate.sql} and ($1::uuid is null or t.project_id = $1::uuid) and ($2::text is null or t.status = $2)
          and ($3::text is null or (${timestampKey('t.created_at')}, t.id) < ($3::text, $4::uuid))
        order by t.created_at desc, t.id desc limit $5`,
      [project, status, filter.after?.code ?? null, filter.after?.id ?? null, filter.limit, ...predicate.params],
    );
    return rows.map(toLine);
  }

  /**
   * The triggers whose day has come (the day in Vietnam), fired once: each is locked, marked FIRED with the time and handed to the caller for its event. A trigger being fired by another pass is
   * skipped, and one already fired is not selected, so a second pass over the same day finds nothing.
   */
  async fireDue(tx: TenantTx, today: string, now: Date, actor: string): Promise<FiredTrigger[]> {
    const day = calendarDate(today, 'today');
    const due = await tx.query<{ id: string; project_id: string; trigger_kind: EvaluationTriggerKind; source_handover_id: string | null; due_on: string; version: string; created_by: string; owner_id: string; owner_path: string; investor_id: string | null; investor_path: string | null }>(
      `select t.id, t.project_id, t.trigger_kind, t.source_handover_id, t.due_on::text as due_on, t.version::text as version, t.created_by, ou.id as owner_id, ou.path as owner_path, iu.id as investor_id, iu.path as investor_path
         from machvon.evaluation_trigger t
         join machvon.project p on p.tenant_id = t.tenant_id and p.id = t.project_id
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where t.status = 'SCHEDULED' and t.due_on <= $1::date
        order by t.due_on, t.id
        for update of t skip locked`,
      [day],
    );
    const fired: FiredTrigger[] = [];
    for (const row of due) {
      const version = Number(row.version) + 1;
      await tx.query(
        `update machvon.evaluation_trigger set status = $2, fired_at = $3::timestamptz, updated_at = now(), updated_by = $4::uuid, version = $5::bigint where id = $1::uuid`,
        [row.id, nextTriggerStatus('SCHEDULED', 'FIRE'), now.toISOString(), actor, version],
      );
      fired.push({
        id: row.id,
        projectId: row.project_id,
        triggerKind: row.trigger_kind,
        sourceHandoverId: row.source_handover_id,
        dueOn: row.due_on,
        version,
        recipientId: row.created_by,
        ownerUnit: { id: row.owner_id, path: row.owner_path },
        investorUnit: row.investor_id === null || row.investor_path === null ? null : { id: row.investor_id, path: row.investor_path },
      });
    }
    return fired;
  }

  /** Records the event that announced a fired trigger on the trigger itself (the column is written once; the guard of the table refuses a second write). */
  async announced(tx: TenantTx, id: string, eventId: string): Promise<void> {
    await tx.query('update machvon.evaluation_trigger set outbox_event_id = $2::uuid where id = $1::uuid and outbox_event_id is null', [id, eventId]);
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------

  private badField(field: string): never {
    throw invalid(field);
  }

  /** The handover a trigger after it refers to: one of the project; for a trigger after a handover it is accepted and the day is not before the acceptance plus 12 or 24 months. */
  private async assertHandover(tx: TenantTx, kind: EvaluationTriggerKind, handoverId: string, projectId: string, dueOn: string): Promise<void> {
    const rows = await tx.query<{ project_id: string; status: string; accepted_on: string | null }>(
      `select c.project_id, h.status, (h.accepted_at at time zone 'Asia/Ho_Chi_Minh')::date::text as accepted_on
         from machvon.handover h join machvon.contract c on c.tenant_id = h.tenant_id and c.id = h.contract_id
        where h.id = $1::uuid`,
      [handoverId],
    );
    const handover = rows[0];
    if (handover === undefined || handover.project_id !== projectId) throw invalid('source_handover_id', 'NOT_A_HANDOVER_OF_THE_PROJECT');
    if (!isPostHandoverKind(kind)) return;
    if (handover.status !== 'ACCEPTED' || handover.accepted_on === null) throw new DomainError('HANDOVER_NOT_ACCEPTED', 422, 'source_handover_id', { extensions: { status: handover.status } });
    const earliest = earliestDueOn(kind, handover.accepted_on);
    if (earliest !== undefined && dueOn < earliest) throw new DomainError('VALIDATION_FAILED', 422, 'due_on', { extensions: { reason: 'BEFORE_EARLIEST', earliest_due_on: earliest } });
  }

  /** The project a command works on, inside the scope of the command; one the caller can read and not change is a refusal, one it cannot see does not exist. */
  private async project(tx: TenantTx, id: string, scopes: TriggerScopes): Promise<{ status: string }> {
    const predicate = scopes.update(2);
    const rows = await tx.query<{ status: string }>(`select p.status from ${PROJECT_FROM} where p.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    if (rows[0] !== undefined) return rows[0];
    const readable = scopes.read(2);
    const seen = await tx.query(`select p.id from ${PROJECT_FROM} where p.id = $1::uuid and ${readable.sql}`, [id, ...readable.params]);
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }

  /** The trigger locked for update inside the scope of the command. */
  private async lock(tx: TenantTx, id: string, scopes: TriggerScopes): Promise<Held & { id: string }> {
    const from = TRIGGER_PROJECT_FROM;
    const predicate = scopes.update(2);
    const rows = await tx.query<Held>(
      `select t.id, t.project_id, t.trigger_kind, t.source_handover_id, t.due_on::text as due_on, t.status, t.version::text as version from ${from} where t.id = $1::uuid and ${predicate.sql} for update of t`,
      [id, ...predicate.params],
    );
    if (rows[0] !== undefined) return rows[0];
    const readable = scopes.read(2);
    const seen = await tx.query(`select t.id from ${from} where t.id = $1::uuid and ${readable.sql}`, [id, ...readable.params]);
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }
}
