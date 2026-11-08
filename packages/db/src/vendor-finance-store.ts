import { randomUUID } from 'node:crypto';
import { DomainError, assertFinancialPeriod, assessCapacity, assessFinance, averageRevenue, ratiosOf, versionConflict } from '@machvon/kernel';
import type { CapacityAssessment, CapacityFacts, CapacityPolicy, FinanceAssessment, FinancePolicy, FinancialPeriod, Ratios } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';
import { VendorPackageControlStore } from './vendor-package-control-store.ts';
import type { PackageControlRow } from './vendor-package-control-store.ts';
import type { Policy } from './vendor-policy.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string): string => `to_char(${column} at time zone 'UTC', ${ISO})`;

export interface FinancialPeriodRow extends FinancialPeriod {
  id: string;
  contractorId: string;
  documentId: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdBy: string;
  version: number;
  ratios: Ratios;
}

export interface NewFinancialPeriod {
  fiscalYear: number;
  revenue: number;
  totalAssets: number;
  currentAssets: number;
  currentLiabilities: number;
  totalDebt: number;
  equity: number;
  ebit: number;
  interestExpense: number;
  documentId?: string | undefined;
}

interface PeriodSql {
  id: string;
  contractor_id: string;
  fiscal_year: number;
  revenue: string;
  total_assets: string;
  current_assets: string;
  current_liabilities: string;
  total_debt: string;
  equity: string;
  ebit: string;
  interest_expense: string;
  document_id: string | null;
  verified_by: string | null;
  verified_at: string | null;
  created_by: string;
  version: string;
}

const PERIOD_SELECT = `select id, contractor_id, fiscal_year, revenue::text as revenue, total_assets::text as total_assets, current_assets::text as current_assets, current_liabilities::text as current_liabilities,
  total_debt::text as total_debt, equity::text as equity, ebit::text as ebit, interest_expense::text as interest_expense, document_id, verified_by, ${iso('verified_at')} as verified_at, created_by, version::text as version
  from machvon.vendor_financial_period`;

const toPeriod = (row: PeriodSql): FinancialPeriodRow => {
  const period: FinancialPeriod = {
    year: row.fiscal_year,
    revenue: Number(row.revenue),
    totalAssets: Number(row.total_assets),
    currentAssets: Number(row.current_assets),
    currentLiabilities: Number(row.current_liabilities),
    totalDebt: Number(row.total_debt),
    equity: Number(row.equity),
    ebit: Number(row.ebit),
    interestExpense: Number(row.interest_expense),
    verified: row.verified_by !== null,
  };
  return { ...period, id: row.id, contractorId: row.contractor_id, documentId: row.document_id, verifiedBy: row.verified_by, verifiedAt: row.verified_at, createdBy: row.created_by, version: Number(row.version), ratios: ratiosOf(period) };
};

export interface FinanceReading {
  periods: FinancialPeriodRow[];
  assessment: FinanceAssessment;
  /** What the package asks (the yearly value basis), when a package was named. */
  requirement: { packageId: string; packageValue: number; durationMonths: number; valueFrom: 'ESTIMATED_VALUE' | 'BUDGET' } | null;
}

export interface CapacityReading {
  facts: CapacityFacts;
  assessment: CapacityAssessment;
}

/**
 * The financial standing and the load of a contractor (VND-2, V7 and V9). A period is entered from the audited report by one person and verified against the paper by another (the database holds that too); a
 * corrected year is a new row that supersedes the one before, so the figures that stood on the day of an evaluation stay answerable. Only verified figures count, and a test with too little data says so (never a pass).
 * The load counts the remaining value of the contracts that are signed, active or suspended (contract value minus the total accepted), the contracts past their completion day, and the awards that were approved or
 * submitted and have no contract yet; the contractor of a joint venture is counted for the work value of its place as a member, and for the whole contract as the lead.
 */
export class VendorFinanceStore {
  private readonly controls = new VendorPackageControlStore();

  async periods(tx: TenantTx, contractorId: string, includeSuperseded = false): Promise<FinancialPeriodRow[]> {
    const rows = await tx.query<PeriodSql>(`${PERIOD_SELECT} where contractor_id = $1::uuid and ($2::boolean or superseded_by_id is null) order by fiscal_year desc, created_at desc`, [contractorId, includeSuperseded]);
    return rows.map(toPeriod);
  }

  async find(tx: TenantTx, id: string): Promise<FinancialPeriodRow | undefined> {
    const rows = await tx.query<PeriodSql>(`${PERIOD_SELECT} where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toPeriod(rows[0]);
  }

  /**
   * Records a year. A year that has no active row is a new row; one that has is superseded by the new row (a correction: it must be verified again, and until then it does not count). Figures equal to the active
   * row's are 409 `FINANCIAL_PERIOD_DUPLICATE`.
   */
  async record(tx: TenantTx, contractorId: string, input: NewFinancialPeriod, actor: string): Promise<FinancialPeriodRow> {
    if ((await tx.query('select 1 from machvon.contractor where id = $1::uuid for update', [contractorId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const figures = { year: input.fiscalYear, revenue: input.revenue, totalAssets: input.totalAssets, currentAssets: input.currentAssets, currentLiabilities: input.currentLiabilities, totalDebt: input.totalDebt, equity: input.equity, ebit: input.ebit, interestExpense: input.interestExpense };
    assertFinancialPeriod(figures);
    if (input.documentId !== undefined && (await tx.query('select 1 from machvon.document where id = $1::uuid', [input.documentId])).length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'document_id');
    const [active] = await tx.query<PeriodSql>(`${PERIOD_SELECT} where contractor_id = $1::uuid and fiscal_year = $2::int and superseded_by_id is null for update`, [contractorId, input.fiscalYear]);
    if (active !== undefined) {
      const held = toPeriod(active);
      const same = held.revenue === input.revenue && held.totalAssets === input.totalAssets && held.currentAssets === input.currentAssets && held.currentLiabilities === input.currentLiabilities && held.totalDebt === input.totalDebt && held.equity === input.equity && held.ebit === input.ebit && held.interestExpense === input.interestExpense;
      // The same figures with the paper added to a year that had none are not a duplicate: the paper is what lets a second person verify the year.
      const addsPaper = held.documentId === null && input.documentId !== undefined;
      if (same && !addsPaper) throw new DomainError('FINANCIAL_PERIOD_DUPLICATE', 409, 'fiscal_year');
    }
    const id = randomUUID();
    // The year has one active row: the old one is marked superseded first (the reference to the new row is checked when the transaction ends), then the new row takes the year.
    if (active !== undefined) await tx.query('update machvon.vendor_financial_period set superseded_by_id = $2::uuid, superseded_at = now(), updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [active.id, id, actor]);
    await tx.query(
      `insert into machvon.vendor_financial_period (tenant_id, id, contractor_id, fiscal_year, revenue, total_assets, current_assets, current_liabilities, total_debt, equity, ebit, interest_expense, document_id, created_by, updated_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3::int, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::uuid, $13::uuid, $13::uuid)`,
      [id, contractorId, input.fiscalYear, input.revenue, input.totalAssets, input.currentAssets, input.currentLiabilities, input.totalDebt, input.equity, input.ebit, input.interestExpense, input.documentId ?? null, actor],
    );
    return (await this.find(tx, id)) as FinancialPeriodRow;
  }

  /** A person other than the one who entered the year checks it against the paper (403 `SELF_APPROVAL_DENIED`); once (409 `STAGE_TRANSITION_DENIED`); a paper is needed (422 `document_id`). */
  async verify(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<FinancialPeriodRow> {
    const [row] = await tx.query<{ created_by: string; verified_by: string | null; superseded_by_id: string | null; document_id: string | null; version: string }>('select created_by, verified_by, superseded_by_id, document_id, version::text as version from machvon.vendor_financial_period where id = $1::uuid for update', [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    if (row.created_by === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (row.verified_by !== null || row.superseded_by_id !== null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if (row.document_id === null) throw new DomainError('VALIDATION_FAILED', 422, 'document_id');
    await tx.query('update machvon.vendor_financial_period set verified_by = $2::uuid, verified_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid', [id, actor]);
    return (await this.find(tx, id)) as FinancialPeriodRow;
  }

  /** The assessment of a contractor: the ratios of the latest verified year and the average revenue against the rule and, when a package is named, against what it asks. */
  async assessFor(tx: TenantTx, contractorId: string, packageId: string | undefined, policy: Policy<FinancePolicy>): Promise<FinanceReading> {
    if ((await tx.query('select 1 from machvon.contractor where id = $1::uuid', [contractorId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const periods = await this.periods(tx, contractorId);
    let control: PackageControlRow | null = null;
    if (packageId !== undefined) control = await this.controls.get(tx, packageId);
    const requirement = control === null ? null : { packageId: control.packageId, packageValue: control.estimatedValue ?? control.budgetVnd, durationMonths: control.durationMonths ?? 12, valueFrom: control.estimatedValue === null ? ('BUDGET' as const) : ('ESTIMATED_VALUE' as const) };
    const assessment = assessFinance(periods, policy.value, requirement === null ? null : { packageValue: requirement.packageValue, durationMonths: requirement.durationMonths });
    return { periods, assessment, requirement };
  }

  /** The load of a contractor on a day against its average revenue (the years and the rule of the finance policy). */
  async capacity(tx: TenantTx, contractorId: string, today: string, finance: Policy<FinancePolicy>, policy: Policy<CapacityPolicy>): Promise<CapacityReading> {
    if ((await tx.query('select 1 from machvon.contractor where id = $1::uuid', [contractorId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const [open] = await tx.query<{ value: string | null; count: string; late: string }>(
      `select coalesce(sum(held.value), 0)::text as value, count(*)::text as count, count(*) filter (where held.completion_due is not null and held.completion_due < $2::date)::text as late
         from (
           select greatest(coalesce(k.contract_value_vnd, 0) - coalesce(k.accepted_total_vnd, 0), 0) as value, k.completion_due
             from machvon.contract k where k.contractor_id = $1::uuid and k.status in ('SIGNED', 'ACTIVE', 'SUSPENDED')
           union all
           select greatest(p.work_value_vnd - coalesce(k.accepted_total_vnd, 0) * p.share_pct / 100, 0), k.completion_due
             from machvon.contract_party p join machvon.contract k on k.tenant_id = p.tenant_id and k.id = p.contract_id
            where p.contractor_id = $1::uuid and p.role = 'MEMBER' and p.status = 'ACTIVE' and k.contractor_id <> $1::uuid and k.status in ('SIGNED', 'ACTIVE', 'SUSPENDED')
         ) held`,
      [contractorId, today],
    );
    const [pending] = await tx.query<{ value: string | null; count: string }>(
      `select coalesce(sum(r.award_price_vnd), 0)::text as value, count(*)::text as count from machvon.procurement_result r
        where r.winner_contractor_id = $1::uuid and r.outcome = 'AWARDED' and r.status in ('SUBMITTED', 'APPROVED')
          and not exists (select 1 from machvon.contract k where k.tenant_id = r.tenant_id and k.package_id = r.package_id)`,
      [contractorId],
    );
    const periods = await this.periods(tx, contractorId);
    const facts: CapacityFacts = {
      openContractValue: Number(open?.value ?? 0),
      openContractCount: Number(open?.count ?? 0),
      lateContractCount: Number(open?.late ?? 0),
      pendingAwardValue: Number(pending?.value ?? 0),
      pendingAwardCount: Number(pending?.count ?? 0),
      averageAnnualRevenue: averageRevenue(periods, finance.value.revenue_years),
    };
    return { facts, assessment: assessCapacity(facts, policy.value) };
  }
}
