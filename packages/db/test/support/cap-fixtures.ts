import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { CapAppropriationStore } from '../../src/cap-appropriation-store';
import type { AppropriationInput } from '../../src/cap-appropriation-store';
import { CapPlanApprovalStore } from '../../src/cap-plan-approval-store';
import { CapPlanPublicationStore } from '../../src/cap-plan-publication-store';
import { CapPlanStore } from '../../src/cap-plan-store';
import type { DraftScopes } from '../../src/cap-plan-store';
import type { PlanReadScope } from '../../src/cap-plan-reads';
import { WORKER_MEMBERSHIP_ID } from '../../src/consumer-inbox';
import { BASELINE_PACK, applyBaseline } from '../../src/master-baseline';
import { PrjProjectStore } from '../../src/prj-project-store';
import type { ScopeBuilder } from '../../src/scope-version';
import type { TenantTx } from '../../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './authz-fixtures';

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const allDrafts: PlanReadScope = { lines: everything, drafts: true };
const scopes: DraftScopes = { write: everything, read: allDrafts };
const allow = (): undefined => undefined;
const TODAY = vietnamDateOf(new Date());

export const MAKER = 1;
export const APPROVER = 2;
export const PUBLISHER = 3;
export const ROOT = 1;
export const BQL1 = 2;
export const BILLION = 1_000_000_000;
export const money = (billions: number): string => String(billions * BILLION);

export interface PublishedLine {
  planId: string;
  year: number;
  lineId: string;
  balanceId: string;
  appropriationId: string;
  projectId: string;
}

/**
 * Capital in force for the tests of the availability control: a published appropriation, a project and a published plan with one line (and its balance) per call. Everything
 * goes through the stores of the product, the way the commands leave it, so the balances are the ones publication writes.
 */
export class CapWorld {
  readonly harness = new AuthzHarness();
  private readonly appropriations = new CapAppropriationStore();
  private readonly plans = new CapPlanStore();
  private readonly approvals = new CapPlanApprovalStore();
  private readonly publication = new CapPlanPublicationStore();
  private readonly projects = new PrjProjectStore();
  private counter = 0;
  private yearCounter = 2100;
  private fundVersionId = '';
  private areaVersionId = '';

  as<T>(work: (tx: TenantTx) => Promise<T>, member = MAKER, tenant = TENANT_A): Promise<T> {
    return this.harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
  }

  owner<R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
    return this.harness.owner<R>(TENANT_A, [[sql, params]]);
  }

  async start(): Promise<void> {
    await this.harness.start();
    await this.harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
    ]);
    for (const member of [MAKER, APPROVER, PUBLISHER]) await this.harness.seedMembership(TENANT_A, member, ROOT);
    await this.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER_MEMBERSHIP_ID, TODAY));
    this.fundVersionId = await this.fundSource('NSTW');
    this.areaVersionId = await this.master('AREA', 'AREA', {});
  }

  stop(): Promise<void> {
    return this.harness.stop();
  }

  /** A master record of the tenant in force, with its business key (a fund source is named by it in a policy). */
  async master(name: string, masterType: string, attributes: Record<string, unknown>): Promise<string> {
    this.counter += 1;
    const recordId = randomUUID();
    const versionId = randomUUID();
    const key = `${name}-${this.counter}`;
    await this.harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [TENANT_A, recordId, masterType, key, memberId(MAKER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $5, $6::jsonb, '2020-01-01', 'EFFECTIVE', $7, now(), $8, $8)`,
        [TENANT_A, versionId, masterType, key, `Label ${key}`, JSON.stringify(attributes), recordId, memberId(MAKER)],
      ],
    ]);
    return versionId;
  }

  /** A fund source in force: its version, and the business key a policy names. */
  async fundSource(category: string): Promise<string> {
    const versionId = await this.master(`${category}-DTPT`, 'FUND_SOURCE', { category, relation: 'ADDITIVE' });
    return versionId;
  }

  async businessKeyOf(versionId: string): Promise<string> {
    const [row] = await this.owner<{ business_key: string }>('select r.business_key from machvon.master_record r join machvon.master_record_version v on v.master_record_id = r.id where v.id = $1::uuid', [versionId]);
    if (row === undefined) throw new Error('no such fund source');
    return row.business_key;
  }

  get defaultFundVersionId(): string {
    return this.fundVersionId;
  }

  async document(): Promise<string> {
    const id = randomUUID();
    await this.owner(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
      [TENANT_A, id, `QD-${id.slice(0, 8)}/2026`, memberId(MAKER)],
    );
    return id;
  }

  freshYear(): number {
    this.yearCounter -= 1;
    return this.yearCounter;
  }

  async appropriation(options: Partial<AppropriationInput> = {}): Promise<{ id: string; year: number }> {
    const planYear = options.planYear ?? this.freshYear();
    const input: AppropriationInput = {
      fundSourceVersionId: this.fundVersionId,
      planYear,
      origin: 'PM_ASSIGNED',
      budgetLevel: 'CENTRAL',
      amountVnd: money(10),
      decisionDocumentId: await this.document(),
      issuingAuthority: 'Thủ tướng Chính phủ',
      sourceYear: planYear,
      ...options,
    };
    const draft = await this.as((tx) => this.appropriations.register(tx, input, memberId(MAKER), TODAY));
    await this.as((tx) => this.appropriations.decide(tx, draft.id, draft.version, 'approve', memberId(APPROVER), TODAY), APPROVER);
    return { id: draft.id, year: planYear };
  }

  async project(options: { group?: string; unitNumber?: number } = {}): Promise<string> {
    this.counter += 1;
    const code = `AVC-${this.counter}-${randomUUID().slice(0, 6)}`;
    const created = await this.as((tx) =>
      this.projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(options.unitNumber ?? BQL1), areaMasterVersionId: this.areaVersionId, totalInvestmentVnd: '500000000000' }, memberId(MAKER), TODAY),
    );
    await this.owner('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, 'PIPELINE', options.group ?? 'B', String(7000000 + this.counter)]);
    return created.id;
  }

  /**
   * One line published with its balance: `allocated` of VND on an appropriation (a new one of `appropriationAmount` unless `appropriationId` is given), for a project of the
   * group and the unit asked for. Reservations, commitments and disbursements are set afterwards with `setFigures`.
   */
  async publishedLine(
    options: { allocated?: string; appropriationAmount?: string; appropriationId?: string; year?: number; group?: string; unitNumber?: number; fundVersionId?: string } = {},
  ): Promise<PublishedLine> {
    const allocated = options.allocated ?? money(1);
    const appropriation =
      options.appropriationId === undefined
        ? await this.appropriation({ amountVnd: options.appropriationAmount ?? money(10), ...(options.year === undefined ? {} : { planYear: options.year }), ...(options.fundVersionId === undefined ? {} : { fundSourceVersionId: options.fundVersionId }) })
        : { id: options.appropriationId, year: options.year ?? 0 };
    const projectId = await this.project({ ...(options.group === undefined ? {} : { group: options.group }), ...(options.unitNumber === undefined ? {} : { unitNumber: options.unitNumber }) });
    this.counter += 1;
    const created = await this.as((tx) =>
      this.plans.createPlan(
        tx,
        { planCode: `AVC-${this.counter}-${randomUUID().slice(0, 6)}`, planKind: 'ANNUAL', planYear: appropriation.year, periodFromYear: appropriation.year, periodToYear: appropriation.year, scopeUnitId: unitId(ROOT) },
        memberId(MAKER),
        allow,
      ),
    );
    const planId = created.id;
    const draftVersion = await this.versionOf(planId);
    await this.as((tx) =>
      this.plans.draft(tx, planId, draftVersion, { lines: [{ projectId, appropriationId: appropriation.id, bucket: 'CURRENT_YEAR', sourceYear: appropriation.year, amountVnd: allocated }], removeLineIds: [] }, memberId(MAKER), scopes, TODAY),
    );
    const submitVersion = await this.versionOf(planId);
    await this.as((tx) => this.approvals.submit(tx, planId, submitVersion, memberId(MAKER), allow));
    const decideVersion = await this.versionOf(planId);
    await this.as((tx) => this.approvals.decide(tx, planId, decideVersion, 'approve', 'Reviewed against the decision', memberId(APPROVER), allow), APPROVER);
    const publishVersion = await this.versionOf(planId);
    const decisionDocumentId = await this.document();
    await this.as((tx) => this.publication.publish(tx, planId, publishVersion, { decisionDocumentId, effectiveAt: undefined }, memberId(PUBLISHER), allow, TODAY), PUBLISHER);
    const [line] = await this.owner<{ id: string }>('select al.id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid', [planId]);
    const [balance] = await this.owner<{ id: string }>('select id from machvon.allocation_balance where allocation_line_id = $1::uuid', [line?.id]);
    if (line === undefined || balance === undefined) throw new Error('the plan was not published with a balance');
    return { planId, year: appropriation.year, lineId: line.id, balanceId: balance.id, appropriationId: appropriation.id, projectId };
  }

  /** The reserved, committed and disbursed amounts of a balance, set the way the stories of the chain will have left them. */
  setFigures(balanceId: string, figures: { reserved?: string; committed?: string; disbursed?: string }): Promise<unknown> {
    return this.owner(
      'update machvon.allocation_balance set reserved_vnd = coalesce($2::numeric, reserved_vnd), committed_vnd = coalesce($3::numeric, committed_vnd), disbursed_vnd = coalesce($4::numeric, disbursed_vnd) where id = $1::uuid',
      [balanceId, figures.reserved ?? null, figures.committed ?? null, figures.disbursed ?? null],
    );
  }

  async balanceOf(balanceId: string): Promise<{ allocated: string; reserved: string; committed: string; disbursed: string; version: string }> {
    const [row] = await this.owner<{ allocated: string; reserved: string; committed: string; disbursed: string; version: string }>(
      'select allocated_vnd::text as allocated, reserved_vnd::text as reserved, committed_vnd::text as committed, disbursed_vnd::text as disbursed, version::text as version from machvon.allocation_balance where id = $1::uuid',
      [balanceId],
    );
    if (row === undefined) throw new Error('no such balance');
    return row;
  }

  private async versionOf(planId: string): Promise<number> {
    const [row] = await this.owner<{ version: string }>('select version::text as version from machvon.capital_plan where id = $1::uuid', [planId]);
    return Number(row?.version);
  }
}
