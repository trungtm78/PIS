import { DomainError } from '@machvon/kernel';
import type { IndicatorReadings } from '@machvon/kernel';
import { PrjEvmStore } from './prj-evm-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * What the job `risk-rescore` reads from the system for each project (MR-1, MR.02): the live signals of schedule delay (the SPI of the earned value and the milestones past their day), payment integrity (drafts a check blocked,
 * requests sent with signals), claims and early warnings (the registers of CTR when the tenant has them, and the critical warnings of the DIS), funding gap (what the plan of the year asks against what was allocated) and
 * procurement delay (milestones of the packages past their day). It only reads, in the transaction of the caller, for the whole tenant; a figure it cannot know is `null`, never zero: a project with no baseline has no
 * SPI, one with no milestone has no slip, one with no schedule for the year has no funding gap, a tenant without the claim register has no count of claims.
 */

export interface ProjectToScore {
  id: string;
  code: string;
  status: string;
  projectGroup: string | null;
}

export interface ProjectReading {
  readings: IndicatorReadings;
  /** The figures the readings came from, in plain data: they go on the evidence of the score. */
  facts: Record<string, unknown>;
}

/** The statuses of a claim of the register of CTR in which it is still being settled. */
const LIVE_CLAIM_STATUSES = ['EVENT_RECORDED', 'NOTICE_SERVED', 'PARTICULARS_SUBMITTED', 'RESPONDED', 'SETTLEMENT_PROPOSED'] as const;
/** The statuses of an early warning of the register of CTR in which it is still open. */
const LIVE_EARLY_WARNING_STATUSES = ['RAISED', 'ASSESSED', 'MITIGATING'] as const;
const OPEN_DIS_WARNING_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED'] as const;
const WHOLE_TENANT = (): { sql: string; params: unknown[] } => ({ sql: 'true', params: [] });

const ratioPct = (numerator: number, denominator: number): number => Math.round((numerator / denominator) * 10_000) / 100;

export class RiskSignalReader {
  private readonly evm: PrjEvmStore;

  constructor(evm: PrjEvmStore = new PrjEvmStore()) {
    this.evm = evm;
  }

  /** The projects whose status is one the rule scores, in the order of their code, one page after `after`. */
  async projects(tx: TenantTx, statuses: readonly string[], limit: number, after?: string): Promise<ProjectToScore[]> {
    const rows = await tx.query<{ id: string; code: string; status: string; project_group: string | null }>(
      `select id, code, status, project_group from machvon.project where status = any($1::text[]) and ($2::text is null or code > $2::text collate "C") order by code collate "C" limit $3`,
      [[...statuses], after ?? null, limit],
    );
    return rows.map((row) => ({ id: row.id, code: row.code, status: row.status, projectGroup: row.project_group }));
  }

  /** The readings of every project given on the day `today` (`YYYY-MM-DD`, Vietnam time). */
  async read(tx: TenantTx, projects: readonly ProjectToScore[], today: string): Promise<Map<string, ProjectReading>> {
    const result = new Map<string, ProjectReading>(projects.map((project) => [project.id, { readings: {}, facts: {} }]));
    if (projects.length === 0) return result;
    const ids = projects.map((project) => project.id);
    const set = (id: string, indicator: keyof IndicatorReadings, value: number | null, fact: Record<string, unknown>): void => {
      const held = result.get(id);
      if (held === undefined) return;
      held.readings[indicator] = value;
      Object.assign(held.facts, fact);
    };
    await this.schedule(tx, projects, today, set);
    await this.milestones(tx, ids, today, set);
    await this.payments(tx, ids, set);
    await this.claims(tx, ids, set);
    await this.funding(tx, ids, today, set);
    await this.procurement(tx, ids, today, set);
    return result;
  }

  private async schedule(tx: TenantTx, projects: readonly ProjectToScore[], today: string, set: Setter): Promise<void> {
    for (const project of projects) {
      let spi: number | null = null;
      try {
        const view = await this.evm.evm(tx, WHOLE_TENANT, { projectId: project.id, asOf: today, scope: 'PROJECT', baseline: 'CURRENT' });
        spi = view.figures.spi === null ? null : Number(view.figures.spi);
      } catch (failure) {
        // A project that has no baseline, or whose figures cannot be told, has no SPI: that is "not known", not a delay of zero. Any other failure is a fault and goes up.
        if (!(failure instanceof DomainError)) throw failure;
      }
      const shortfall = spi === null || !Number.isFinite(spi) ? null : Math.max(0, Math.round((1 - spi) * 10_000) / 100);
      set(project.id, 'SPI_SHORTFALL_PCT', shortfall, { spi });
    }
  }

  private async milestones(tx: TenantTx, ids: readonly string[], today: string, set: Setter): Promise<void> {
    const rows = await tx.query<{ project_id: string; total: string; late: string; slip: string }>(
      `select m.project_id, count(*)::text as total,
              count(*) filter (where m.status in ('PLANNED', 'DELAYED') and m.actual_date is null and m.planned_date < $2::date)::text as late,
              coalesce(max($2::date - m.planned_date) filter (where m.status in ('PLANNED', 'DELAYED') and m.actual_date is null and m.planned_date < $2::date), 0)::text as slip
         from machvon.project_milestone m where m.project_id = any($1::uuid[]) and m.status <> 'CANCELLED' group by m.project_id`,
      [[...ids], today],
    );
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.project_id);
      set(row.project_id, 'MILESTONE_SLIP_DAYS', Number(row.slip), { milestones: Number(row.total), milestones_late: Number(row.late) });
    }
    for (const id of ids) if (!seen.has(id)) set(id, 'MILESTONE_SLIP_DAYS', null, { milestones: 0 });
  }

  private async payments(tx: TenantTx, ids: readonly string[], set: Setter): Promise<void> {
    const rows = await tx.query<{ project_id: string; blocked: string; signals: string }>(
      `select r.project_id,
              count(*) filter (where r.outcome = 'BLOCKED' and pr.status = 'DRAFT')::text as blocked,
              count(*) filter (where r.trigger_kind = 'SUBMIT' and r.signal_count > 0 and r.outcome <> 'BLOCKED' and pr.status = 'SUBMITTED')::text as signals
         from machvon.payment_integrity_run r join machvon.payment_request pr on pr.tenant_id = r.tenant_id and pr.id = r.payment_request_id
        where r.project_id = any($1::uuid[])
          and r.id = (select l.id from machvon.payment_integrity_run l where l.tenant_id = r.tenant_id and l.payment_request_id = r.payment_request_id order by l.created_at desc, l.id desc limit 1)
        group by r.project_id`,
      [[...ids]],
    );
    const found = new Map(rows.map((row) => [row.project_id, row]));
    for (const id of ids) {
      const row = found.get(id);
      // A count of flags is a real zero when no check has anything to say.
      set(id, 'PAYMENT_BLOCKED_DRAFTS', row === undefined ? 0 : Number(row.blocked), { payment_blocked_drafts: row === undefined ? 0 : Number(row.blocked), payment_signal_requests: row === undefined ? 0 : Number(row.signals) });
      set(id, 'PAYMENT_SIGNAL_REQUESTS', row === undefined ? 0 : Number(row.signals), {});
    }
  }

  private async has(tx: TenantTx, table: string): Promise<boolean> {
    const rows = await tx.query<{ found: boolean }>('select to_regclass($1) is not null as found', [`machvon.${table}`]);
    return rows[0]?.found === true;
  }

  private async claims(tx: TenantTx, ids: readonly string[], set: Setter): Promise<void> {
    const hasClaims = await this.has(tx, 'contract_claim');
    const hasWarnings = await this.has(tx, 'contract_early_warning');
    const claimCount = new Map<string, number>();
    if (hasClaims) {
      const rows = await tx.query<{ project_id: string; live: string }>(
        `select c.project_id, count(*)::text as live from machvon.contract_claim k join machvon.contract c on c.tenant_id = k.tenant_id and c.id = k.contract_id
          where c.project_id = any($1::uuid[]) and k.status = any($2::text[]) group by c.project_id`,
        [[...ids], [...LIVE_CLAIM_STATUSES]],
      );
      for (const row of rows) claimCount.set(row.project_id, Number(row.live));
    }
    const warnings = new Map<string, number>();
    if (hasWarnings) {
      const rows = await tx.query<{ project_id: string; high: string }>(
        `select c.project_id, count(*)::text as high from machvon.contract_early_warning w join machvon.contract c on c.tenant_id = w.tenant_id and c.id = w.contract_id
          where c.project_id = any($1::uuid[]) and w.status = any($2::text[]) and w.likelihood = 'HIGH' group by c.project_id`,
        [[...ids], [...LIVE_EARLY_WARNING_STATUSES]],
      );
      for (const row of rows) warnings.set(row.project_id, Number(row.high));
    }
    const dis = await tx.query<{ project_id: string; critical: string }>(
      `select w.project_id, count(*)::text as critical from machvon.early_warning w where w.project_id = any($1::uuid[]) and w.severity = 'CRITICAL' and w.status = any($2::text[]) group by w.project_id`,
      [[...ids], [...OPEN_DIS_WARNING_STATUSES]],
    );
    const critical = new Map(dis.map((row) => [row.project_id, Number(row.critical)]));
    for (const id of ids) {
      // Without the claim register of CTR the number of claims is not known (null), never zero.
      set(id, 'OPEN_CLAIMS', hasClaims ? (claimCount.get(id) ?? 0) : null, { claim_register: hasClaims, open_claims: hasClaims ? (claimCount.get(id) ?? 0) : null });
      const high = (warnings.get(id) ?? 0) + (critical.get(id) ?? 0);
      set(id, 'EARLY_WARNINGS_HIGH', high, { early_warning_register: hasWarnings, contract_early_warnings_high: warnings.get(id) ?? 0, dis_early_warnings_critical: critical.get(id) ?? 0 });
    }
  }

  private async funding(tx: TenantTx, ids: readonly string[], today: string, set: Setter): Promise<void> {
    const year = Number(today.slice(0, 4));
    const rows = await tx.query<{ project_id: string; needed: string; funded: string }>(
      `select s.project_id, s.needed::text as needed,
              coalesce((select sum(b.allocated_vnd) from machvon.allocation_line l
                          join machvon.appropriation a on a.tenant_id = l.tenant_id and a.id = l.appropriation_id
                          join machvon.allocation_balance b on b.tenant_id = l.tenant_id and b.allocation_line_id = l.id
                         where l.project_id = s.project_id and a.plan_year = $2::int and a.status in ('APPROVED', 'PUBLISHED')), 0)::text as funded
         from (select d.project_id, sum(d.amount_vnd) as needed from machvon.disbursement_schedule_line d
                where d.project_id = any($1::uuid[]) and d.plan_year = $2::int and d.kind = 'REGISTERED' and d.is_current group by d.project_id) s`,
      [[...ids], year],
    );
    const found = new Map(rows.map((row) => [row.project_id, row]));
    for (const id of ids) {
      const row = found.get(id);
      const needed = row === undefined ? 0 : Number(row.needed);
      if (row === undefined || !(needed > 0)) {
        set(id, 'FUNDING_GAP_PCT', null, { funding_year: year, funding_needed_vnd: null });
        continue;
      }
      const funded = Number(row.funded);
      const gap = Math.max(0, needed - funded);
      set(id, 'FUNDING_GAP_PCT', ratioPct(gap, needed), { funding_year: year, funding_needed_vnd: row.needed, funding_allocated_vnd: row.funded });
    }
  }

  private async procurement(tx: TenantTx, ids: readonly string[], today: string, set: Setter): Promise<void> {
    const rows = await tx.query<{ project_id: string; total: string; slip: string }>(
      `select pk.project_id, count(*)::text as total,
              coalesce(max($2::date - (m.planned_at at time zone 'Asia/Ho_Chi_Minh')::date) filter (where m.actual_at is null and (m.planned_at at time zone 'Asia/Ho_Chi_Minh')::date < $2::date), 0)::text as slip
         from machvon.procurement_milestone m join machvon.procurement_package pk on pk.tenant_id = m.tenant_id and pk.id = m.package_id
        where pk.project_id = any($1::uuid[]) and m.planned_at is not null
          and not exists (select 1 from machvon.procurement_milestone d where d.tenant_id = pk.tenant_id and d.package_id = pk.id and d.milestone_kind = 'CONTRACT_SIGNED' and d.actual_at is not null)
        group by pk.project_id`,
      [[...ids], today],
    );
    const found = new Map(rows.map((row) => [row.project_id, row]));
    for (const id of ids) {
      const row = found.get(id);
      set(id, 'PROCUREMENT_SLIP_DAYS', row === undefined ? null : Number(row.slip), { procurement_milestones: row === undefined ? 0 : Number(row.total) });
    }
  }
}

type Setter = (id: string, indicator: keyof IndicatorReadings, value: number | null, fact: Record<string, unknown>) => void;
