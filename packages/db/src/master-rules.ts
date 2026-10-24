import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/** One reading of a rule: the version in force on the date, with everything a screen needs to say where the rule comes from. */
export interface RuleReading {
  ruleType: string;
  businessKey: string;
  revision: number;
  validFrom: string;
  validUntil: string | null;
  legalBasis: string;
  ownerModule: string;
  /** The rule is a working assumption until the confirmation named by `cxn` arrives; a screen that applies it says so ("chờ ký"). */
  awaitingConfirmation: boolean;
  cxn: string | null;
  attributes: Record<string, unknown>;
}

export interface NationalCodeRule {
  mode: 'BLOCK' | 'WARN';
  /** The stage of a project from which the national project code is required. */
  fromStageKey: string;
  /** The format of the code, when a format rule is in force; the code is checked against it before a stage is left. */
  format: { pattern: string; example: string } | null;
  reading: RuleReading;
}

export interface SuggestedGroup {
  groupKey: string;
  /** The sector whose table decided; null when the default table did. */
  sectorKey: string | null;
  reading: RuleReading;
}

interface RuleSqlRow {
  business_key: string;
  revision: number;
  valid_from: string;
  valid_until: string | null;
  legal_basis: string | null;
  attributes: Record<string, unknown>;
}

const AMOUNT = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const DEFAULT_RULE_KEY = 'DEFAULT';

const cents = (amount: string): bigint => {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};

function reading(ruleType: string, row: RuleSqlRow): RuleReading {
  const { attributes } = row;
  return {
    ruleType,
    businessKey: row.business_key,
    revision: row.revision,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    legalBasis: row.legal_basis ?? '',
    ownerModule: typeof attributes.owner_module === 'string' ? attributes.owner_module : '',
    awaitingConfirmation: attributes.awaiting_confirmation === true,
    cxn: typeof attributes.cxn === 'string' ? attributes.cxn : null,
    attributes,
  };
}

interface Band {
  sector_key: string | null;
  group_key: string;
  min_amount: string;
  max_amount: string | null;
}

/**
 * The port through which the modules read the legal rules that are kept as data (BR-MDM-09, ST-MDM-003): the rule is the version
 * that was in force on the business date, so a project proposed before a threshold changed is grouped by the old threshold. Nothing
 * here decides for the module; it returns the rule with its legal basis and whether it still waits for a confirmation.
 */
export class MasterRules {
  /** The rule of a type and key in force on `asOf`, or undefined when none is. The rules of the platform come before a tenant's own. */
  async read(tx: TenantTx, ruleType: string, businessKey: string, asOf: string): Promise<RuleReading | undefined> {
    const rows = await tx.query<RuleSqlRow>(
      `select r.business_key, v.revision, v.valid_from::text as valid_from, v.valid_until::text as valid_until, v.legal_basis, v.attributes
         from machvon.master_record r
         join machvon.master_record_version v on v.master_record_id = r.id
        where r.master_type = $1 and r.business_key = $2 and v.status in ('APPROVED', 'EFFECTIVE', 'RETIRED') and v.published_at is not null
          and v.valid_from <= $3::date and (v.valid_until is null or v.valid_until > $3::date)
        order by case r.namespace when 'PLATFORM' then 0 else 1 end, v.revision desc limit 1`,
      [ruleType, businessKey, asOf],
    );
    return rows[0] === undefined ? undefined : reading(ruleType, rows[0]);
  }

  /** Whether and from which stage the national project code is required, with the format it must have. */
  async nationalCode(tx: TenantTx, asOf: string): Promise<NationalCodeRule | undefined> {
    const required = await this.read(tx, 'NATIONAL_CODE_REQUIRED', DEFAULT_RULE_KEY, asOf);
    if (required === undefined) return undefined;
    const format = await this.read(tx, 'NATIONAL_CODE_FORMAT', DEFAULT_RULE_KEY, asOf);
    const { mode, from_stage_key: fromStageKey } = required.attributes;
    return {
      mode: mode === 'WARN' ? 'WARN' : 'BLOCK',
      fromStageKey: String(fromStageKey),
      format: format === undefined ? null : { pattern: String(format.attributes.pattern), example: String(format.attributes.example) },
      reading: required,
    };
  }

  /**
   * The group a project of this size falls in, by the table that was in force on the date it is proposed. The table of the sector
   * decides when it has one, the default table otherwise; the amount is a decimal string in VND and is compared exactly.
   */
  async suggestGroup(tx: TenantTx, request: { sectorKey?: string | undefined; totalInvestmentVnd: string }, asOf: string): Promise<SuggestedGroup | undefined> {
    if (!AMOUNT.test(request.totalInvestmentVnd)) throw new DomainError('VALIDATION_FAILED', 422, 'total_investment_vnd');
    const rule = await this.read(tx, 'PROJECT_GROUP_THRESHOLDS', DEFAULT_RULE_KEY, asOf);
    if (rule === undefined) return undefined;
    const bands = rule.attributes.bands as Band[];
    const amount = cents(request.totalInvestmentVnd);
    const own = request.sectorKey === undefined ? [] : bands.filter((band) => band.sector_key === request.sectorKey);
    const sectorKey = own.length > 0 ? (request.sectorKey ?? null) : null;
    const table = own.length > 0 ? own : bands.filter((band) => band.sector_key === null);
    // The edges are half open: an amount on an edge belongs to the band above it.
    const band = table.find((candidate) => cents(candidate.min_amount) <= amount && (candidate.max_amount === null || amount < cents(candidate.max_amount)));
    return band === undefined ? undefined : { groupKey: band.group_key, sectorKey, reading: rule };
  }
}
