import { BOTTLENECK_RULE_CODE, BOTTLENECK_RULE_TYPE, ISSUE_SEVERITIES, bottleneckModelOf } from '@machvon/kernel';
import type { BottleneckItem, BottleneckModel, HaltStatus, IssueSeverity, StepStatus } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { policyVersionOf } from './home-work-policy.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const VN_DAY = (column: string): string => `(${column} at time zone 'Asia/Ho_Chi_Minh')::date::text`;
export const HALT_RESOURCE = 'project_halt_dossier';
export const SOURCE_LIMIT = 500;

export interface BottleneckPolicyReading {
  model: BottleneckModel;
  version: string;
  unverified: boolean;
}

export interface SourceRead {
  items: BottleneckItem[];
  /** How many rows the source has that cannot be told (no day to age them from): said, never dropped without a word. */
  skipped: number;
  /** True when the source holds more rows than were read. */
  cut: boolean;
}

interface Person {
  id: string;
  name: string;
}
export interface DossierRow {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  projectStatus: string;
  unitId: string | null;
  unitName: string | null;
  reasonCode: string;
  reasonText: string;
  haltedOn: string;
  orderRef: string | null;
  expectedRestartOn: string | null;
  status: HaltStatus;
  planVersion: number;
  planSavedBy: Person | null;
  planSavedAt: string | null;
  planDecision: 'APPROVED' | 'RETURNED' | null;
  planDecidedBy: Person | null;
  planDecidedAt: string | null;
  planDecisionNote: string | null;
  closedBy: Person | null;
  closedAt: string | null;
  closeNote: string | null;
  restartedOn: string | null;
  createdBy: Person;
  createdAt: string;
}
export interface StepRow {
  id: string;
  dossierId: string;
  planVersion: number;
  ordinal: number;
  title: string;
  ownerId: string | null;
  ownerName: string | null;
  ownerUnitId: string | null;
  ownerUnitName: string | null;
  dueOn: string;
  status: StepStatus;
  closedBy: Person | null;
  closedAt: string | null;
  closeNote: string | null;
}
export interface UndocumentedHalt {
  projectId: string;
  projectCode: string;
  projectName: string;
  unitId: string | null;
  unitName: string | null;
}

interface DossierSql {
  id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  project_status: string;
  unit_id: string | null;
  unit_name: string | null;
  reason_code: string;
  reason_text: string;
  halted_on: string;
  order_ref: string | null;
  expected_restart_on: string | null;
  status: HaltStatus;
  plan_version: number;
  plan_saved_by: string | null;
  plan_saved_name: string | null;
  plan_saved_at: string | null;
  plan_decision: 'APPROVED' | 'RETURNED' | null;
  plan_decided_by: string | null;
  plan_decided_name: string | null;
  plan_decided_at: string | null;
  plan_decision_note: string | null;
  closed_by: string | null;
  closed_name: string | null;
  closed_at: string | null;
  close_note: string | null;
  restarted_on: string | null;
  created_by: string;
  created_name: string | null;
  created_at: string;
}

const person = (id: string | null, name: string | null): Person | null => (id === null ? null : { id, name: name ?? '' });

const DOSSIER_SELECT = `select h.id, h.project_id, p.code as project_code, p.name as project_name, p.status as project_status, p.owner_unit_id as unit_id, ou.name as unit_name, h.reason_code, h.reason_text, h.halted_on::text as halted_on,
  h.order_ref, h.expected_restart_on::text as expected_restart_on, h.status, h.plan_version, h.plan_saved_by, sd.display_name as plan_saved_name, ${ISO('h.plan_saved_at')} as plan_saved_at, h.plan_decision, h.plan_decided_by,
  dd.display_name as plan_decided_name, ${ISO('h.plan_decided_at')} as plan_decided_at, h.plan_decision_note, h.closed_by, cd.display_name as closed_name, ${ISO('h.closed_at')} as closed_at, h.close_note,
  h.restarted_on::text as restarted_on, h.created_by, rd.display_name as created_name, ${ISO('h.created_at')} as created_at
  from machvon.project_halt_dossier h
  join ${SCOPE_FROM} on p.tenant_id = h.tenant_id and p.id = h.project_id
  left join machvon.tenant_user_directory sd on sd.tenant_id = h.tenant_id and sd.membership_id = h.plan_saved_by
  left join machvon.tenant_user_directory dd on dd.tenant_id = h.tenant_id and dd.membership_id = h.plan_decided_by
  left join machvon.tenant_user_directory cd on cd.tenant_id = h.tenant_id and cd.membership_id = h.closed_by
  left join machvon.tenant_user_directory rd on rd.tenant_id = h.tenant_id and rd.membership_id = h.created_by`;

const toDossier = (row: DossierSql): DossierRow => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  projectName: row.project_name,
  projectStatus: row.project_status,
  unitId: row.unit_id,
  unitName: row.unit_name,
  reasonCode: row.reason_code,
  reasonText: row.reason_text,
  haltedOn: row.halted_on,
  orderRef: row.order_ref,
  expectedRestartOn: row.expected_restart_on,
  status: row.status,
  planVersion: row.plan_version,
  planSavedBy: person(row.plan_saved_by, row.plan_saved_name),
  planSavedAt: row.plan_saved_at,
  planDecision: row.plan_decision,
  planDecidedBy: person(row.plan_decided_by, row.plan_decided_name),
  planDecidedAt: row.plan_decided_at,
  planDecisionNote: row.plan_decision_note,
  closedBy: person(row.closed_by, row.closed_name),
  closedAt: row.closed_at,
  closeNote: row.close_note,
  restartedOn: row.restarted_on,
  createdBy: person(row.created_by, row.created_name) as Person,
  createdAt: row.created_at,
});

/**
 * What holds money and work up, and the dossiers of the halted projects (G3-9). The sources are read in the scope of the reader from the tables of their own modules (payment requests that wait, compensation that is due
 * and not paid, issues not solved, open halt dossiers); a row that cannot be dated is counted as skipped and said. The arithmetic and the lifecycle are the kernel's.
 */
export class AnaBottleneckStore {
  constructor(private readonly port: GovernancePolicyPort = new GovernancePolicyPort()) {}

  async policy(tx: TenantTx, asOf: string | Date): Promise<BottleneckPolicyReading> {
    const rule = await this.port.require(tx, BOTTLENECK_RULE_TYPE, BOTTLENECK_RULE_CODE, asOf);
    return { model: bottleneckModelOf(rule.params), version: policyVersionOf(rule), unverified: rule.unverified };
  }

  /** Payment requests that wait: to be checked (submitted, verified) or to be paid by the Treasury (sent). The amount is the net of the request; the holder of a request at the Treasury is the Treasury. */
  async payments(tx: TenantTx, scope: ScopeBuilder): Promise<SourceRead> {
    const visible = scope(1);
    const rows = await tx.query<{ id: string; project_id: string; project_code: string; unit_id: string | null; unit_name: string | null; status: string; net: string; since: string | null }>(
      `select pr.id, pr.project_id, p.code as project_code, p.owner_unit_id as unit_id, ou.name as unit_name, pr.status, pr.net_vnd::text as net,
              case pr.status when 'SUBMITTED' then ${VN_DAY('pr.submitted_at')} when 'VERIFIED' then ${VN_DAY('pr.verified_at')} else coalesce(${VN_DAY('pr.treasury_sent_at')}, pr.treasury_submitted_on::text) end as since
         from machvon.payment_request pr join ${SCOPE_FROM} on p.tenant_id = pr.tenant_id and p.id = pr.project_id
        where pr.status in ('SUBMITTED', 'VERIFIED', 'SENT_TREASURY') and ${visible.sql}
        order by pr.id limit ${SOURCE_LIMIT + 1}`,
      visible.params,
    );
    const cut = rows.length > SOURCE_LIMIT;
    const items: BottleneckItem[] = [];
    let skipped = 0;
    for (const row of rows.slice(0, SOURCE_LIMIT)) {
      if (row.since === null) {
        skipped += 1;
        continue;
      }
      items.push({
        key: `PAYMENT:${row.id}`,
        source: 'PAYMENT',
        sourceId: row.id,
        projectId: row.project_id,
        projectCode: row.project_code,
        unitId: row.unit_id,
        causeCode: row.status === 'SENT_TREASURY' ? 'PAYMENT_PENDING_TREASURY' : 'PAYMENT_PENDING_DOSSIER',
        amountVnd: row.net,
        amountNullReason: null,
        since: row.since,
        holder: row.status === 'SENT_TREASURY' ? { kind: 'EXTERNAL', id: null, name: null, code: 'TREASURY' } : { kind: 'UNIT', id: row.unit_id, name: row.unit_name, code: null },
        dedupeKey: `PAYMENT:${row.id}`,
      });
    }
    return { items, skipped, cut };
  }

  /** Compensation that was due and is not paid: the pending payments of a plan whose day has passed, added up for the plan; the day it began to be late is the first due day. */
  async land(tx: TenantTx, scope: ScopeBuilder, today: string): Promise<SourceRead> {
    const visible = scope(2);
    const rows = await tx.query<{ plan_id: string; project_id: string; project_code: string; unit_id: string | null; unit_name: string | null; amount: string; since: string }>(
      `select cp.plan_id, pl.project_id, p.code as project_code, cp.owner_unit_id as unit_id, ou.name as unit_name, sum(cp.amount_vnd)::text as amount, min(cp.due_on)::text as since
         from machvon.compensation_payment cp
         join machvon.compensation_plan pl on pl.tenant_id = cp.tenant_id and pl.id = cp.plan_id
         join ${SCOPE_FROM} on p.tenant_id = pl.tenant_id and p.id = pl.project_id
        where cp.status = 'PENDING' and cp.due_on < $1::date and ${visible.sql}
        group by cp.plan_id, pl.project_id, p.code, cp.owner_unit_id, ou.name
        order by cp.plan_id limit ${SOURCE_LIMIT + 1}`,
      [today, ...visible.params],
    );
    const cut = rows.length > SOURCE_LIMIT;
    return {
      items: rows.slice(0, SOURCE_LIMIT).map(
        (row): BottleneckItem => ({
          key: `LAND:${row.plan_id}`,
          source: 'LAND',
          sourceId: row.plan_id,
          projectId: row.project_id,
          projectCode: row.project_code,
          unitId: row.unit_id,
          causeCode: 'LAND_CLEARANCE',
          amountVnd: row.amount,
          amountNullReason: null,
          since: row.since,
          holder: { kind: 'UNIT', id: row.unit_id, name: row.unit_name, code: null },
          dedupeKey: null,
        }),
      ),
      skipped: 0,
      cut,
    };
  }

  /** Issues of the severity of the rule and above that are not solved: they hold no amount of their own (said), the holder is the person they are assigned to, and they age from the day they were opened. */
  async issues(tx: TenantTx, scope: ScopeBuilder, minSeverity: IssueSeverity): Promise<SourceRead> {
    const visible = scope(2);
    const severities = ISSUE_SEVERITIES.slice(ISSUE_SEVERITIES.indexOf(minSeverity));
    const rows = await tx.query<{ id: string; project_id: string; project_code: string; unit_id: string | null; assignee_id: string | null; assignee_name: string | null; source_module: string; source_ref_id: string | null; since: string | null }>(
      `select i.id, i.project_id, p.code as project_code, coalesce(i.owner_unit_id, p.owner_unit_id) as unit_id, i.assignee_id, d.display_name as assignee_name, i.source_module, i.source_ref_id::text as source_ref_id, ${VN_DAY('i.opened_at')} as since
         from machvon.issue i
         join ${SCOPE_FROM} on p.tenant_id = i.tenant_id and p.id = i.project_id
         left join machvon.tenant_user_directory d on d.tenant_id = i.tenant_id and d.membership_id = i.assignee_id
        where i.status in ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'REOPENED') and i.severity = any($1::text[]) and ${visible.sql}
        order by i.id limit ${SOURCE_LIMIT + 1}`,
      [[...severities], ...visible.params],
    );
    const cut = rows.length > SOURCE_LIMIT;
    const items: BottleneckItem[] = [];
    let skipped = 0;
    for (const row of rows.slice(0, SOURCE_LIMIT)) {
      if (row.since === null) {
        skipped += 1;
        continue;
      }
      items.push({
        key: `ISSUE:${row.id}`,
        source: 'ISSUE',
        sourceId: row.id,
        projectId: row.project_id,
        projectCode: row.project_code,
        unitId: row.unit_id,
        causeCode: 'ISSUE_UNRESOLVED',
        amountVnd: null,
        amountNullReason: 'NO_AMOUNT',
        since: row.since,
        holder: row.assignee_id === null ? { kind: 'UNIT', id: row.unit_id, name: null, code: null } : { kind: 'PERSON', id: row.assignee_id, name: row.assignee_name, code: null },
        // An issue that PAY opened for a payment request is that request: the amount is the request's, counted once.
        dedupeKey: row.source_module === 'PAY' && row.source_ref_id !== null ? `PAYMENT:${row.source_ref_id}` : null,
      });
    }
    return { items, skipped, cut };
  }

  /** The open halt dossiers as items: no amount, the cause the dossier names, from the day the halt began, held by the unit that owns the project. */
  async halts(tx: TenantTx, scope: ScopeBuilder): Promise<SourceRead> {
    const visible = scope(1);
    const rows = await tx.query<DossierSql>(`${DOSSIER_SELECT} where h.status in ('HALTED', 'RESTART_PLANNED') and ${visible.sql} order by h.id limit ${SOURCE_LIMIT + 1}`, visible.params);
    return {
      items: rows.slice(0, SOURCE_LIMIT).map((row): BottleneckItem => {
        const dossier = toDossier(row);
        return {
          key: `HALT:${dossier.id}`,
          source: 'HALT',
          sourceId: dossier.id,
          projectId: dossier.projectId,
          projectCode: dossier.projectCode,
          unitId: dossier.unitId,
          causeCode: dossier.reasonCode,
          amountVnd: null,
          amountNullReason: 'NO_AMOUNT',
          since: dossier.haltedOn,
          holder: { kind: 'UNIT', id: dossier.unitId, name: dossier.unitName, code: null },
          dedupeKey: null,
        };
      }),
      skipped: 0,
      cut: rows.length > SOURCE_LIMIT,
    };
  }

  /** The projects that are suspended and have no open dossier: the gap, said. */
  async undocumented(tx: TenantTx, scope: ScopeBuilder): Promise<UndocumentedHalt[]> {
    const visible = scope(1);
    const rows = await tx.query<{ id: string; code: string; name: string; unit_id: string | null; unit_name: string | null }>(
      `select p.id, p.code, p.name, p.owner_unit_id as unit_id, ou.name as unit_name from ${SCOPE_FROM}
        where p.status = 'SUSPENDED' and ${visible.sql}
          and not exists (select 1 from machvon.project_halt_dossier h where h.tenant_id = p.tenant_id and h.project_id = p.id and h.status in ('HALTED', 'RESTART_PLANNED'))
        order by p.code, p.id limit ${SOURCE_LIMIT}`,
      visible.params,
    );
    return rows.map((row) => ({ projectId: row.id, projectCode: row.code, projectName: row.name, unitId: row.unit_id, unitName: row.unit_name }));
  }

  async projectStatus(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<{ status: string; unitId: string | null } | undefined> {
    const visible = scope(2);
    const [row] = await tx.query<{ status: string; unit_id: string | null }>(`select p.status, p.owner_unit_id as unit_id from ${SCOPE_FROM} where p.id = $1::uuid and ${visible.sql}`, [projectId, ...visible.params]);
    return row === undefined ? undefined : { status: row.status, unitId: row.unit_id };
  }

  async dossiers(tx: TenantTx, scope: ScopeBuilder, filter: { status?: string | undefined; open?: boolean | undefined }, limit: number): Promise<DossierRow[]> {
    const visible = scope(4);
    const rows = await tx.query<DossierSql>(
      `${DOSSIER_SELECT} where ($1::text is null or h.status = $1) and (not $2::boolean or h.status in ('HALTED', 'RESTART_PLANNED')) and ${visible.sql} order by h.halted_on, h.id limit $3`,
      [filter.status ?? null, filter.open === true, limit, ...visible.params],
    );
    return rows.map(toDossier);
  }

  async findDossier(tx: TenantTx, scope: ScopeBuilder, id: string, lock = false): Promise<DossierRow | undefined> {
    const visible = scope(2);
    const [row] = await tx.query<DossierSql>(`${DOSSIER_SELECT} where h.id = $1::uuid and ${visible.sql}${lock ? ' for update of h' : ''}`, [id, ...visible.params]);
    return row === undefined ? undefined : toDossier(row);
  }

  async insertDossier(tx: TenantTx, input: { projectId: string; reasonCode: string; reasonText: string; haltedOn: string; orderRef: string | null; expectedRestartOn: string | null; actor: string }): Promise<{ id: string }> {
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.project_halt_dossier (tenant_id, project_id, reason_code, reason_text, halted_on, order_ref, expected_restart_on, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::date, $5, $6::date, $7::uuid) returning id`,
      [input.projectId, input.reasonCode, input.reasonText, input.haltedOn, input.orderRef, input.expectedRestartOn, input.actor],
    );
    return { id: (row as { id: string }).id };
  }

  async steps(tx: TenantTx, dossierId: string, planVersion?: number): Promise<StepRow[]> {
    const rows = await tx.query<{ id: string; dossier_id: string; plan_version: number; ordinal: number; title: string; owner_id: string | null; owner_name: string | null; owner_unit_id: string | null; owner_unit_name: string | null; due_on: string; status: StepStatus; closed_by: string | null; closed_name: string | null; closed_at: string | null; close_note: string | null }>(
      `select s.id, s.dossier_id, s.plan_version, s.ordinal, s.title, s.owner_id, od.display_name as owner_name, s.owner_unit_id, ou.name as owner_unit_name, s.due_on::text as due_on, s.status, s.closed_by, cd.display_name as closed_name, ${ISO('s.closed_at')} as closed_at, s.close_note
         from machvon.project_restart_step s
         left join machvon.tenant_user_directory od on od.tenant_id = s.tenant_id and od.membership_id = s.owner_id
         left join machvon.organization_unit ou on ou.tenant_id = s.tenant_id and ou.id = s.owner_unit_id
         left join machvon.tenant_user_directory cd on cd.tenant_id = s.tenant_id and cd.membership_id = s.closed_by
        where s.dossier_id = $1::uuid and ($2::int is null or s.plan_version = $2::int) order by s.plan_version, s.ordinal`,
      [dossierId, planVersion ?? null],
    );
    return rows.map((row) => ({ id: row.id, dossierId: row.dossier_id, planVersion: row.plan_version, ordinal: row.ordinal, title: row.title, ownerId: row.owner_id, ownerName: row.owner_name, ownerUnitId: row.owner_unit_id, ownerUnitName: row.owner_unit_name, dueOn: row.due_on, status: row.status, closedBy: person(row.closed_by, row.closed_name), closedAt: row.closed_at, closeNote: row.close_note }));
  }

  /** Saves a plan as the next version: the dossier moves to it (and forgets the decision on the one before), the steps are numbered from 1. */
  async savePlan(tx: TenantTx, dossierId: string, nextVersion: number, steps: ReadonlyArray<{ title: string; ownerId: string | null; ownerUnitId: string | null; dueOn: string }>, expectedRestartOn: string | null, actor: string): Promise<void> {
    await tx.query(
      `update machvon.project_halt_dossier set plan_version = $2, plan_saved_by = $3::uuid, plan_saved_at = now(), plan_decision = null, plan_decided_by = null, plan_decided_at = null, plan_decision_note = null,
              expected_restart_on = coalesce($4::date, expected_restart_on) where id = $1::uuid`,
      [dossierId, nextVersion, actor, expectedRestartOn],
    );
    let ordinal = 0;
    for (const step of steps) {
      ordinal += 1;
      await tx.query(
        `insert into machvon.project_restart_step (tenant_id, dossier_id, plan_version, ordinal, title, owner_id, owner_unit_id, due_on)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5::uuid, $6::uuid, $7::date)`,
        [dossierId, nextVersion, ordinal, step.title, step.ownerId, step.ownerUnitId, step.dueOn],
      );
    }
  }

  async decidePlan(tx: TenantTx, dossierId: string, decision: 'APPROVED' | 'RETURNED', actor: string, note: string): Promise<void> {
    await tx.query(
      `update machvon.project_halt_dossier set plan_decision = $2, plan_decided_by = $3::uuid, plan_decided_at = now(), plan_decision_note = $4, status = case when $2 = 'APPROVED' then 'RESTART_PLANNED' else status end where id = $1::uuid`,
      [dossierId, decision, actor, note],
    );
  }

  async closeStep(tx: TenantTx, stepId: string, status: 'DONE' | 'DROPPED', actor: string, note: string): Promise<void> {
    await tx.query(`update machvon.project_restart_step set status = $2, closed_by = $3::uuid, closed_at = now(), close_note = $4 where id = $1::uuid`, [stepId, status, actor, note]);
  }

  async findStep(tx: TenantTx, dossierId: string, stepId: string): Promise<StepRow | undefined> {
    return (await this.steps(tx, dossierId)).find((step) => step.id === stepId);
  }

  async closeDossier(tx: TenantTx, dossierId: string, outcome: 'RESTARTED' | 'CANCELLED', actor: string, note: string, restartedOn: string | null): Promise<void> {
    await tx.query(`update machvon.project_halt_dossier set status = $2, closed_by = $3::uuid, closed_at = now(), close_note = $4, restarted_on = $5::date where id = $1::uuid`, [dossierId, outcome, actor, note, restartedOn]);
  }

  async hasOpenDossier(tx: TenantTx, projectId: string): Promise<boolean> {
    const [row] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.project_halt_dossier where project_id = $1::uuid and status in ('HALTED', 'RESTART_PLANNED')", [projectId]);
    return Number(row?.n ?? 0) > 0;
  }

  async memberExists(tx: TenantTx, membershipId: string): Promise<boolean> {
    const [row] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.membership where id = $1::uuid', [membershipId]);
    return Number(row?.n ?? 0) > 0;
  }

  async unitExists(tx: TenantTx, unitId: string): Promise<boolean> {
    const [row] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.organization_unit where id = $1::uuid', [unitId]);
    return Number(row?.n ?? 0) > 0;
  }
}
