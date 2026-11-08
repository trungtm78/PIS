import { DomainError, versionConflict } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** What a package asks of its bidders for the controls of VND-2: money in whole dong as numbers (the safe range is checked), days as `YYYY-MM-DD`. */
export interface PackageControlRow {
  packageId: string;
  securityBaseAmount: number | null;
  bidValidUntil: string | null;
  estimatedValue: number | null;
  durationMonths: number | null;
  /** The budget of the package, the value the finance test falls back to when no estimated value was set. */
  budgetVnd: number;
  version: number;
}

export interface PackageControlInput {
  securityBaseAmount?: number | null | undefined;
  bidValidUntil?: string | null | undefined;
  estimatedValue?: number | null | undefined;
  durationMonths?: number | null | undefined;
}

interface Sql {
  package_id: string;
  security_base_amount: string | null;
  bid_valid_until: string | null;
  estimated_value: string | null;
  duration_months: number | null;
  budget_vnd: string;
  version: string | null;
}

const money = (value: string | null): number | null => (value === null ? null : Number(value));

function checkMoney(value: number | null | undefined, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(field);
  return value;
}

/** The controls of a package (V7, V10): the base amount of the bid security, the last day the bids are valid, the estimated value and the months of the work. One row for a package, replaced under a version. */
export class VendorPackageControlStore {
  async get(tx: TenantTx, packageId: string): Promise<PackageControlRow> {
    const rows = await tx.query<Sql>(
      `select p.id as package_id, c.security_base_amount::text as security_base_amount, c.bid_valid_until::text as bid_valid_until, c.estimated_value::text as estimated_value, c.duration_months,
              p.budget_vnd::text as budget_vnd, c.version::text as version
         from machvon.procurement_package p left join machvon.vendor_package_control c on c.tenant_id = p.tenant_id and c.package_id = p.id
        where p.id = $1::uuid`,
      [packageId],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { packageId: row.package_id, securityBaseAmount: money(row.security_base_amount), bidValidUntil: row.bid_valid_until, estimatedValue: money(row.estimated_value), durationMonths: row.duration_months, budgetVnd: Number(row.budget_vnd), version: row.version === null ? 0 : Number(row.version) };
  }

  /** Writes the controls of a package; the first write needs no version (0), a later one must name the version it read (409 `VERSION_CONFLICT`). */
  async set(tx: TenantTx, packageId: string, input: PackageControlInput, actor: string, expectedVersion = 0): Promise<PackageControlRow> {
    const current = await this.get(tx, packageId);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    const securityBaseAmount = checkMoney(input.securityBaseAmount, 'security_base_amount');
    const estimatedValue = checkMoney(input.estimatedValue, 'estimated_value');
    const bidValidUntil = input.bidValidUntil ?? null;
    if (bidValidUntil !== null && !isDay(bidValidUntil)) throw invalid('bid_valid_until');
    const durationMonths = input.durationMonths ?? null;
    if (durationMonths !== null && (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 600)) throw invalid('duration_months');
    if (current.version === 0) {
      await tx.query(
        `insert into machvon.vendor_package_control (tenant_id, package_id, security_base_amount, bid_valid_until, estimated_value, duration_months, created_by, updated_by)
         values (${TENANT}, $1::uuid, $2::numeric, $3::date, $4::numeric, $5::int, $6::uuid, $6::uuid)`,
        [packageId, securityBaseAmount, bidValidUntil, estimatedValue, durationMonths, actor],
      );
    } else {
      await tx.query(
        `update machvon.vendor_package_control set security_base_amount = $2::numeric, bid_valid_until = $3::date, estimated_value = $4::numeric, duration_months = $5::int,
                updated_at = now(), updated_by = $6::uuid, version = version + 1 where package_id = $1::uuid`,
        [packageId, securityBaseAmount, bidValidUntil, estimatedValue, durationMonths, actor],
      );
    }
    return this.get(tx, packageId);
  }
}
