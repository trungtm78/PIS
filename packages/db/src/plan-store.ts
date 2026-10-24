import { randomUUID } from 'node:crypto';
import { DomainError, planDraftIssues, versionConflict } from '@machvon/kernel';
import type { PlanBillingCycle, PlanDraft, PlanExpiredBehavior, PlanFeatureDraft, PlanGraceBehavior, PlanIssue, PlanLimitKind, PlanVatCategory } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export type PlanVersionStatus = 'Draft' | 'Published' | 'Retired';

export interface PlanFeatureRow {
  featureCode: string;
  limitKind: PlanLimitKind;
  limitValue: string | null;
  meter: string | null;
  graceBehavior: PlanGraceBehavior;
  expiredBehavior: PlanExpiredBehavior;
}

export interface PlanVersionRow {
  id: string;
  planCode: string;
  revision: number;
  name: string;
  status: PlanVersionStatus;
  billingCycles: PlanBillingCycle[];
  basePriceVnd: string;
  vatCategory: PlanVatCategory;
  legalTermsRef: string;
  publishedBy: string | null;
  publishedAt: Date | null;
  version: number;
  features: PlanFeatureRow[];
}

export interface PublishPlanInput {
  planVersionId: string;
  expectedVersion: number;
  publishedBy: string;
}

export interface ListPlansInput {
  planCode?: string | undefined;
  status?: PlanVersionStatus | undefined;
  limit: number;
  /** The last plan version of the page before. */
  after?: string | undefined;
}

interface VersionDbRow {
  id: string;
  plan_code: string;
  revision: number;
  name: string;
  status: PlanVersionStatus;
  billing_cycles: PlanBillingCycle[];
  base_price_vnd: string;
  vat_category: PlanVatCategory;
  legal_terms_ref: string;
  published_by: string | null;
  published_at: Date | null;
  version: string;
}

interface FeatureDbRow {
  plan_version_id: string;
  feature_code: string;
  limit_kind: PlanLimitKind;
  limit_value: string | null;
  meter: string | null;
  grace_behavior: PlanGraceBehavior;
  expired_behavior: PlanExpiredBehavior;
}

const VERSION_COLUMNS = 'id, plan_code, revision, name, status, billing_cycles, base_price_vnd::text as base_price_vnd, vat_category, legal_terms_ref, published_by, published_at, version::text as version';
const FEATURE_COLUMNS = 'plan_version_id, feature_code, limit_kind, trim_scale(limit_value)::text as limit_value, meter, grace_behavior, expired_behavior';

// One plan code is numbered by one writer at a time; the code is compared without case, so STANDARD and standard are one plan.
const LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended('plan_code:' || lower($1), 0))";
const SPELLING_SQL = 'select plan_code, coalesce(max(revision), 0)::int as latest from machvon.product_plan_version where lower(plan_code) = lower($1) group by plan_code';
const INSERT_VERSION_SQL = `insert into machvon.product_plan_version
    (id, plan_code, revision, name, status, billing_cycles, base_price_vnd, vat_category, legal_terms_ref)
  values ($1::uuid, $2, $3, $4, 'Draft', $5::text[], $6::numeric, $7, $8)`;
const INSERT_FEATURE_SQL = `insert into machvon.plan_feature (id, plan_version_id, feature_code, limit_kind, limit_value, meter, grace_behavior, expired_behavior)
  values ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6, $7, $8)`;
const LOCK_VERSION_SQL = `select ${VERSION_COLUMNS} from machvon.product_plan_version where id = $1::uuid for update`;
const PUBLISH_SQL = `update machvon.product_plan_version
  set status = 'Published', published_by = $2::uuid, published_at = now(), version = version + 1
  where id = $1::uuid`;
const FEATURES_OF_SQL = `select ${FEATURE_COLUMNS} from machvon.plan_feature where plan_version_id = any($1::uuid[]) order by feature_code`;
const LIST_SQL = `select ${VERSION_COLUMNS} from machvon.product_plan_version v
  where ($1::text is null or lower(v.plan_code) = lower($1))
    and ($2::text is null or v.status = $2)
    and ($3::uuid is null or (v.plan_code, -v.revision) > (select a.plan_code, -a.revision from machvon.product_plan_version a where a.id = $3::uuid))
  order by v.plan_code, v.revision desc
  limit $4`;

const featureOf = (row: FeatureDbRow): PlanFeatureRow => ({
  featureCode: row.feature_code,
  limitKind: row.limit_kind,
  limitValue: row.limit_value,
  meter: row.meter,
  graceBehavior: row.grace_behavior,
  expiredBehavior: row.expired_behavior,
});

const versionOf = (row: VersionDbRow, features: readonly PlanFeatureRow[]): PlanVersionRow => ({
  id: row.id,
  planCode: row.plan_code,
  revision: row.revision,
  name: row.name,
  status: row.status,
  billingCycles: row.billing_cycles,
  basePriceVnd: row.base_price_vnd,
  vatCategory: row.vat_category,
  legalTermsRef: row.legal_terms_ref,
  publishedBy: row.published_by,
  publishedAt: row.published_at,
  version: Number(row.version),
  features: [...features],
});

/** What the validation of the kernel reads: the stored plan with the feature rows as they were written. */
const draftOf = (plan: PlanVersionRow): PlanDraft => ({
  planCode: plan.planCode,
  name: plan.name,
  billingCycles: plan.billingCycles,
  basePriceVnd: plan.basePriceVnd,
  vatCategory: plan.vatCategory,
  legalTermsRef: plan.legalTermsRef,
  features: plan.features.map(
    (feature): PlanFeatureDraft => ({
      featureCode: feature.featureCode,
      limitKind: feature.limitKind,
      ...(feature.limitValue === null ? {} : { limitValue: feature.limitValue }),
      ...(feature.meter === null ? {} : { meter: feature.meter }),
      graceBehavior: feature.graceBehavior,
      expiredBehavior: feature.expiredBehavior,
    }),
  ),
});

/** 422 PLAN_INVALID: the field of the first problem in `detail`, every problem in `issues`. */
export function planInvalid(issues: readonly PlanIssue[]): DomainError {
  const first = issues[0];
  return new DomainError('PLAN_INVALID', 422, first?.field, { extensions: { reason: first?.reason, issues: issues.map((issue) => ({ field: issue.field, reason: issue.reason })) } });
}

/**
 * The plan catalogue of the control plane (ST-SAS-007, SAS.md BR-SAS-07): plan versions are written as drafts and published once; a
 * published version is never edited, a change is the next revision of the same plan (409 PLAN_VERSION_IMMUTABLE, and the database
 * refuses it as well, V1480). The price of a plan, its limits and its behaviours at grace and at the end are what was sold, so a
 * subscription keeps pointing at the revision it was sold with whatever is published after it.
 */
export class PlanStore {
  /**
   * Writes the next revision of the plan as a draft. The plan code is matched without case, and the spelling of the plan that
   * exists is kept (the seeded plan is STANDARD, the contract writes codes in lower case).
   */
  async createDraft(tx: TenantTx, draft: PlanDraft): Promise<PlanVersionRow> {
    const issues = planDraftIssues(draft);
    if (issues.length > 0) throw planInvalid(issues);
    await tx.query(LOCK_SQL, [draft.planCode]);
    const [known] = await tx.query<{ plan_code: string; latest: number }>(SPELLING_SQL, [draft.planCode]);
    const planCode = known?.plan_code ?? draft.planCode;
    const revision = (known?.latest ?? 0) + 1;
    const id = randomUUID();
    await tx.query(INSERT_VERSION_SQL, [id, planCode, revision, draft.name.trim(), [...draft.billingCycles], draft.basePriceVnd, draft.vatCategory, draft.legalTermsRef.trim()]);
    for (const feature of draft.features) {
      await tx.query(INSERT_FEATURE_SQL, [randomUUID(), id, feature.featureCode, feature.limitKind, feature.limitValue ?? null, feature.meter ?? null, feature.graceBehavior, feature.expiredBehavior]);
    }
    const [stored] = await this.read(tx, [id]);
    if (stored === undefined) throw new Error('the plan version written was not found');
    return stored;
  }

  /**
   * Publishes a draft. A version that is already Published (or Retired) answers 409 PLAN_VERSION_IMMUTABLE whatever version the
   * caller holds; a stale version answers 409 VERSION_CONFLICT; a draft that is not fit to be sold answers 422 PLAN_INVALID.
   */
  async publish(tx: TenantTx, input: PublishPlanInput): Promise<PlanVersionRow> {
    const [row] = await tx.query<VersionDbRow>(LOCK_VERSION_SQL, [input.planVersionId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.status !== 'Draft') throw new DomainError('PLAN_VERSION_IMMUTABLE', 409);
    if (Number(row.version) !== input.expectedVersion) throw versionConflict(Number(row.version));
    const [current] = await this.read(tx, [row.id]);
    if (current === undefined) throw new Error('the plan version locked was not found');
    const issues = planDraftIssues(draftOf(current));
    if (issues.length > 0) throw planInvalid(issues);
    await tx.query(PUBLISH_SQL, [row.id, input.publishedBy]);
    const [published] = await this.read(tx, [row.id]);
    if (published === undefined) throw new Error('the plan version published was not found');
    return published;
  }

  /** The plan versions by plan code and revision, newest revision first, each with its features. */
  async list(tx: TenantTx, input: ListPlansInput): Promise<PlanVersionRow[]> {
    const rows = await tx.query<VersionDbRow>(LIST_SQL, [input.planCode ?? null, input.status ?? null, input.after ?? null, input.limit]);
    return this.attach(tx, rows);
  }

  private async read(tx: TenantTx, ids: readonly string[]): Promise<PlanVersionRow[]> {
    const rows = await tx.query<VersionDbRow>(`select ${VERSION_COLUMNS} from machvon.product_plan_version where id = any($1::uuid[]) order by plan_code, revision desc`, [[...ids]]);
    return this.attach(tx, rows);
  }

  private async attach(tx: TenantTx, rows: readonly VersionDbRow[]): Promise<PlanVersionRow[]> {
    if (rows.length === 0) return [];
    const features = await tx.query<FeatureDbRow>(FEATURES_OF_SQL, [rows.map((row) => row.id)]);
    return rows.map((row) => versionOf(row, features.filter((feature) => feature.plan_version_id === row.id).map(featureOf)));
  }
}
