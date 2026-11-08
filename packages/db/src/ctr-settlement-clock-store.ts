import { randomUUID } from 'node:crypto';
import {
  CONTRACT_SETTLEMENT_RULE_TYPE,
  DomainError,
  SETTLEMENT_CLOCK_CONTRACT_STATUSES,
  metStateOf,
  settlementClockDueOn,
  settlementClockReading,
  settlementDeadlineDefaults,
  settlementDeadlineParams,
  settlementMonths,
  vietnamDateOf,
} from '@machvon/kernel';
import type { Provenance, SettlementClockState, SettlementDeadlineParams, StoredClockState } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { SCOPE_FROM as CONTRACT_SCOPE_FROM } from './ctr-contract-store.ts';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const SETTLEMENT_CLOCK_RESOURCE = 'contract_settlement_clock';
export const SETTLEMENT_CLOCK_STARTED_EVENT = 'ctr.settlement_clock_started.v1';
export const SETTLEMENT_CLOCK_MET_EVENT = 'ctr.settlement_clock_met.v1';
const RULE_CODE = 'DEFAULT';
const READ_LIMIT = 5000;

export interface SettlementRuleReading {
  params: SettlementDeadlineParams;
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  provenance: Provenance | null;
}

export interface SettlementClockRow {
  id: string;
  contract: { id: string; code: string; status: string };
  project: { id: string; code: string; name: string };
  contractor: { id: string; name: string } | null;
  projectGroup: string | null;
  startedOn: string;
  monthsAllowed: number;
  dueOn: string;
  policyVersion: number;
  stored: StoredClockState;
  state: SettlementClockState;
  daysLeft: number;
  metOn: string | null;
  settlementId: string | null;
}

export interface SettlementClockFilter {
  state?: SettlementClockState | undefined;
  unitId?: string | undefined;
}

export interface SyncResult {
  started: number;
  met: number;
  open: number;
}

interface ClockSql {
  id: string;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  project_code: string;
  project_name: string;
  contractor_id: string | null;
  contractor_name: string | null;
  project_group: string | null;
  started_on: string;
  months_allowed: number;
  due_on: string;
  near_days: number;
  policy_version: number;
  state: StoredClockState;
  met_on: string | null;
  settlement_id: string | null;
}

const toRow = (row: ClockSql, today: string): SettlementClockRow => {
  const reading = settlementClockReading({ dueOn: row.due_on, today, stored: row.state, metOn: row.met_on, nearDays: row.near_days });
  return {
    id: row.id,
    contract: { id: row.contract_id, code: row.contract_code, status: row.contract_status },
    project: { id: row.project_id, code: row.project_code, name: row.project_name },
    contractor: row.contractor_id === null ? null : { id: row.contractor_id, name: row.contractor_name ?? '' },
    projectGroup: row.project_group,
    startedOn: row.started_on,
    monthsAllowed: row.months_allowed,
    dueOn: row.due_on,
    policyVersion: row.policy_version,
    stored: row.state,
    state: reading.state,
    daysLeft: reading.daysLeft,
    metOn: row.met_on,
    settlementId: row.settlement_id,
  };
};

/**
 * The settlement clocks of contracts (G1-18): `sync` starts the clock of every contract that is completed (the day it was completed, the months of the rule for the group of its project, the due day counted then)
 * and ends the clock of a contract whose settlement file was handed in (MET on time, MET_LATE after the due day); `board` reads the clocks in the scope of the caller, judged on the day. A contract of a project
 * without a group is given the default months of the rule and says so (its group is null). The rule is read through the governance port: nothing here is a number.
 */
export class CtrSettlementClockStore {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  async rule(tx: TenantTx, asOf: string | Date): Promise<SettlementRuleReading> {
    const found = await this.port.get(tx, CONTRACT_SETTLEMENT_RULE_TYPE, RULE_CODE, asOf);
    if (found === undefined) return { params: settlementDeadlineDefaults(), version: 0, source: 'DEFAULT', unverified: true, provenance: null };
    return { params: settlementDeadlineParams(found.params), version: found.version, source: found.source, unverified: found.unverified, provenance: found.provenance };
  }

  /** One pass for the tenant of the transaction; idempotent for the same day. */
  async sync(tx: TenantTx, actor: string, audit: Pick<AuditWriter, 'recordInTx'>, enqueue: (event: { type: string; aggregateId: string; payload: Record<string, unknown>; eventKey: string; correlationId: string }) => Promise<void>, now: Date): Promise<SyncResult> {
    const today = vietnamDateOf(now);
    const rule = await this.rule(tx, today);
    const correlationId = randomUUID();
    const waiting = await tx.query<{ id: string; project_id: string; owner_unit_id: string; project_group: string | null; completed_on: string }>(
      `select c.id, c.project_id, p.owner_unit_id, p.project_group, c.completed_on::text as completed_on
         from machvon.contract c join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
        where c.status = any($1::text[]) and c.completed_on is not null
          and not exists (select 1 from machvon.contract_settlement_clock k where k.tenant_id = c.tenant_id and k.contract_id = c.id)
        order by c.completed_on, c.id
        for update of c skip locked`,
      [SETTLEMENT_CLOCK_CONTRACT_STATUSES],
    );
    let started = 0;
    for (const contract of waiting) {
      const months = settlementMonths(rule.params, contract.project_group);
      const dueOn = settlementClockDueOn(contract.completed_on, months);
      const id = randomUUID();
      await tx.query(
        `insert into machvon.contract_settlement_clock (tenant_id, id, contract_id, project_id, owner_unit_id, project_group, started_on, months_allowed, due_on, near_days, policy_version, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::date, $7, $8::date, $9, $10, $11::uuid, $11::uuid)`,
        [id, contract.id, contract.project_id, contract.owner_unit_id, contract.project_group, contract.completed_on, months, dueOn, rule.params.near_days, rule.version, actor],
      );
      await audit.recordInTx(tx, actor, {
        action: 'ctr.settlement_clock_started',
        resourceType: SETTLEMENT_CLOCK_RESOURCE,
        resourceId: id,
        classification: 'INTERNAL',
        diff: { contract_id: contract.id, project_group: contract.project_group, started_on: contract.completed_on, months_allowed: months, due_on: dueOn, policy_version: rule.version },
        correlationId,
        requestId: randomUUID(),
      });
      await enqueue({ type: SETTLEMENT_CLOCK_STARTED_EVENT, aggregateId: id, payload: { contract_id: contract.id, project_id: contract.project_id, due_on: dueOn }, eventKey: `${SETTLEMENT_CLOCK_RESOURCE}:${id}:started`, correlationId });
      started += 1;
    }
    const open = await tx.query<{ id: string; contract_id: string; due_on: string; handed_on: string; settlement_id: string }>(
      `select k.id, k.contract_id, k.due_on::text as due_on, s.handed_on, s.id as settlement_id
         from machvon.contract_settlement_clock k
         join lateral (select sr.id, (sr.submitted_at at time zone 'Asia/Ho_Chi_Minh')::date::text as handed_on
                         from machvon.settlement_revision sr
                        where sr.tenant_id = k.tenant_id and sr.contract_id = k.contract_id and sr.submitted_at is not null and sr.status in ('SUBMITTED', 'VERIFYING', 'VERIFIED', 'CLOSED')
                        order by sr.submitted_at, sr.id limit 1) s on true
        where k.state = 'OPEN'
        order by k.id
        for update of k skip locked`,
    );
    let met = 0;
    for (const clock of open) {
      const state = metStateOf(clock.handed_on, clock.due_on);
      await tx.query('update machvon.contract_settlement_clock set state = $2, met_on = $3::date, settlement_id = $4::uuid, updated_at = $5::timestamptz, updated_by = $6::uuid, version = version + 1 where id = $1::uuid', [clock.id, state, clock.handed_on, clock.settlement_id, now.toISOString(), actor]);
      await audit.recordInTx(tx, actor, {
        action: 'ctr.settlement_clock_met',
        resourceType: SETTLEMENT_CLOCK_RESOURCE,
        resourceId: clock.id,
        classification: 'INTERNAL',
        diff: { contract_id: clock.contract_id, state, met_on: clock.handed_on, due_on: clock.due_on, settlement_id: clock.settlement_id },
        correlationId,
        requestId: randomUUID(),
      });
      await enqueue({ type: SETTLEMENT_CLOCK_MET_EVENT, aggregateId: clock.id, payload: { contract_id: clock.contract_id, state, met_on: clock.handed_on }, eventKey: `${SETTLEMENT_CLOCK_RESOURCE}:${clock.id}:met`, correlationId });
      met += 1;
    }
    const left = await tx.query<{ n: string }>("select count(*)::text as n from machvon.contract_settlement_clock where state = 'OPEN'");
    return { started, met, open: Number(left[0]?.n ?? '0') };
  }

  /** The clocks in the scope of the caller, judged on `today`: the rows (at most one read), the totals of all of them, and the rule that decided. */
  async board(tx: TenantTx, scope: ScopeBuilder, filter: SettlementClockFilter, now: Date): Promise<{ rows: SettlementClockRow[]; all: SettlementClockRow[]; truncated: boolean; rule: SettlementRuleReading }> {
    const today = vietnamDateOf(now);
    const visible = scope(2);
    if (filter.unitId !== undefined && !/^[0-9a-f-]{36}$/i.test(filter.unitId)) throw new DomainError('VALIDATION_FAILED', 422, 'unit_id');
    const rows = await tx.query<ClockSql>(
      `select k.id, c.id as contract_id, c.code as contract_code, c.status as contract_status, p.id as project_id, p.code as project_code, p.name as project_name, c.contractor_id, kt.name as contractor_name,
              k.project_group, k.started_on::text as started_on, k.months_allowed, k.due_on::text as due_on, k.near_days, k.policy_version, k.state, k.met_on::text as met_on, k.settlement_id
         from ${CONTRACT_SCOPE_FROM}
         join machvon.contract_settlement_clock k on k.tenant_id = c.tenant_id and k.contract_id = c.id
         left join machvon.contractor kt on kt.tenant_id = c.tenant_id and kt.id = c.contractor_id
        where ($1::uuid is null or p.owner_unit_id = $1::uuid or p.investor_unit_id = $1::uuid) and ${visible.sql}
        order by k.due_on, k.id
        limit ${READ_LIMIT + 1}`,
      [filter.unitId ?? null, ...visible.params],
    );
    const truncated = rows.length > READ_LIMIT;
    const all = rows.slice(0, READ_LIMIT).map((row) => toRow(row, today));
    return { rows: filter.state === undefined ? all : all.filter((row) => row.state === filter.state), all, truncated, rule: await this.rule(tx, today) };
  }

  /** The clocks that are near their end or past it, in the scope of the caller: what the alert centre lists. */
  async attention(tx: TenantTx, scope: ScopeBuilder, now: Date): Promise<SettlementClockRow[]> {
    const board = await this.board(tx, scope, {}, now);
    return board.all.filter((row) => row.state === 'NEAR' || row.state === 'OVERDUE');
  }
}
