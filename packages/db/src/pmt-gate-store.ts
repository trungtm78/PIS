import { randomUUID } from 'node:crypto';
import { DomainError, isIsoDate, periodsOverlap, shiftDays, vietnamDateOf } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import { PmtDossierStore } from './pmt-dossier-store.ts';
import { appliesTo, checkApplicability } from './pmt-permit-applicability.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const GATE_CODES = ['CONTRACT_ACTIVATION', 'START_CONSTRUCTION', 'ACCEPTANCE_COMPLETION', 'HANDOVER', 'ADVANCE_DISBURSEMENT'] as const;
export type GateCode = (typeof GATE_CODES)[number];
export const GATE_REQUIREMENTS = ['VALID_PERMIT', 'VALID_OR_EXEMPT', 'SUBMITTED_ONLY'] as const;
export type GateRequirement = (typeof GATE_REQUIREMENTS)[number];
export type GateRuleStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type GateStatus = 'PASSED' | 'PASSED_WITH_WAIVER' | 'BLOCKED';

const MAX_LEGAL_BASIS = 2000;
const MAX_MILESTONE = 100;
const UNIQUE_VIOLATION = '23505';
const EXCLUSION_VIOLATION = '23P01';
/** A permit counts as filed once it has left PLANNED and until it is rejected or taken back. */
const FILED_STATUSES: readonly string[] = ['SUBMITTED', 'IN_APPRAISAL', 'SUPPLEMENT_REQUESTED', 'ISSUED', 'EXEMPTED', 'EXPIRED', 'SUPERSEDED'];
/** A permit that was valid on a past day may since have expired or been replaced by its renewal; a revoked one is not counted (the day it was taken back is not kept). */
const WAS_VALID_STATUSES: readonly string[] = ['ISSUED', 'EXPIRED', 'SUPERSEDED'];

export interface GateRuleRow {
  id: string;
  gateCode: GateCode;
  projectMilestoneCode: string | null;
  permitTypeId: string;
  permitTypeCode: string;
  requirement: GateRequirement;
  appliesToRule: Record<string, unknown>;
  legalBasis: string;
  effectiveFrom: string;
  /** The last day the rule applies (inclusive); null while it is open-ended. */
  effectiveUntil: string | null;
  revision: number;
  status: GateRuleStatus;
  version: number;
  /** Creation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  createdAtKey: string;
}

export interface GateRuleInput {
  gateCode: string;
  projectMilestoneCode?: string | undefined;
  permitTypeId: string;
  requirement: string;
  appliesToRule: unknown;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil?: string | undefined;
}

interface RuleSql {
  id: string;
  gate_code: GateCode;
  project_milestone_code: string | null;
  permit_type_id: string;
  permit_type_code: string;
  requirement: GateRequirement;
  applies_to_rule: Record<string, unknown>;
  legal_basis: string;
  effective_from: string;
  effective_until: string | null;
  revision: number;
  status: GateRuleStatus;
  version: string;
  created_at_key: string;
}

const SELECT = `select id, gate_code, project_milestone_code, permit_type_id, permit_type_code, requirement, applies_to_rule, legal_basis, effective_from::text as effective_from,
  effective_until::text as effective_until, revision, status, version::text as version, ${timestampKey('created_at')} as created_at_key
  from machvon.permit_gate_rule`;

const toRow = (row: RuleSql): GateRuleRow => ({
  id: row.id,
  gateCode: row.gate_code,
  projectMilestoneCode: row.project_milestone_code,
  permitTypeId: row.permit_type_id,
  permitTypeCode: row.permit_type_code,
  requirement: row.requirement,
  appliesToRule: row.applies_to_rule,
  legalBasis: row.legal_basis,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  revision: row.revision,
  status: row.status,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const overlap = (): DomainError => new DomainError('GATE_RULE_OVERLAP', 409);

function dateOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isIsoDate(value)) throw invalid(field);
  return value;
}

function gateOf(value: unknown): GateCode {
  if (typeof value !== 'string' || !(GATE_CODES as readonly string[]).includes(value)) throw invalid('gate_code');
  return value as GateCode;
}

/** One rule of a gate as the evaluation judged it for a project on a day. */
export interface RuleVerdict {
  ruleId: string;
  revision: number;
  projectMilestoneCode: string | null;
  permitTypeCode: string;
  requirement: GateRequirement;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  outcome: 'SATISFIED' | 'WAIVED' | 'BLOCKING';
  /** The permit that satisfies the rule, when one does. */
  permit: { id: string; permitNo: string | null; status: string; validUntil: string | null } | null;
  /** The waiver that lets the project through, when one does. */
  waiver: { id: string; validUntil: string } | null;
}

export interface GateEvaluation {
  projectId: string;
  gateCode: GateCode;
  asOf: string;
  status: GateStatus;
  verdicts: RuleVerdict[];
}

interface PermitSql {
  id: string;
  permit_type_code: string;
  permit_no: string | null;
  status: string;
  valid_from: string | null;
  valid_until: string | null;
  no_expiry: boolean;
}

interface WaiverSql {
  id: string;
  permit_type_code: string;
  valid_until: string;
}

/** Whether the permit was valid on the day: issued by then and not past its last day (the first and the last day both count, BR-PMT-01). */
function validOn(permit: PermitSql, day: string): boolean {
  if (!WAS_VALID_STATUSES.includes(permit.status)) return false;
  if (permit.valid_from !== null && permit.valid_from > day) return false;
  return permit.no_expiry || (permit.valid_until !== null && permit.valid_until >= day);
}

/** The permit that satisfies a requirement on a day, when one does. */
function satisfying(requirement: GateRequirement, permits: readonly PermitSql[], day: string): PermitSql | undefined {
  const valid = permits.find((permit) => validOn(permit, day));
  if (valid !== undefined || requirement === 'VALID_PERMIT') return valid;
  if (requirement === 'VALID_OR_EXEMPT') return permits.find((permit) => permit.status === 'EXEMPTED');
  return permits.find((permit) => FILED_STATUSES.includes(permit.status));
}

/**
 * The gate rules and the evaluation of the gates (ST-PMT-004, PMT 3.2, BR-PMT-03): which permit a gate of a project asks for is dated legal data with a
 * legal basis; the evaluation answers PASSED, PASSED_WITH_WAIVER or BLOCKED for a project on a day by the rules in force that day, and lists what blocks.
 * The commands of CTR, QMS, PRJ, AST and PAY call `assertPasses` in their own transaction and refuse with PERMIT_GATE_BLOCKED. A rule is never edited: a
 * change is a new revision that takes over from a date.
 */
export class PmtGateStore {
  private readonly today: () => string;
  private readonly dossiers: PmtDossierStore;

  constructor(options: { today?: () => string } = {}) {
    this.today = options.today ?? (() => vietnamDateOf(new Date()));
    this.dossiers = new PmtDossierStore({ today: this.today });
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<GateRuleRow | undefined> {
    const rows = await tx.query<RuleSql>(`${SELECT} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** Whether the project is one the scope reaches (a project outside it, or of another tenant, is not one the caller may ask about). */
  async visible(tx: TenantTx, projectId: string, scope: ScopeBuilder): Promise<boolean> {
    const predicate = scope(2);
    const rows = await tx.query(`select 1 from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`, [projectId, ...predicate.params]);
    return rows.length > 0;
  }

  /** The rules of the tenant, the newest first, by gate and status. */
  async list(tx: TenantTx, filter: { gateCode?: GateCode | undefined; status?: GateRuleStatus | undefined }, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<GateRuleRow[]> {
    const rows = await tx.query<RuleSql>(
      `${SELECT}
        where ($1::text is null or gate_code = $1) and ($2::text is null or status = $2)
          and ($3::text is null or (${timestampKey('created_at')}, id) < ($3::text, $4::uuid))
        order by created_at desc, id desc limit $5`,
      [filter.gateCode ?? null, filter.status ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  /**
   * Publishes a rule for a gate and a permit type. A gate and a permit type seen for the first time start at revision 1, which may begin on any
   * day; otherwise the new rule is the next revision and takes over from its first day, as for the permit types: the rule before it must not apply
   * on or after that day (409 GATE_RULE_OVERLAP), an open-ended one is ended the day before, and the new rule may not begin on a day that is gone.
   * The legal basis is required (422 LEGAL_BASIS_REQUIRED): a gate without a law behind it is not published.
   */
  async publish(tx: TenantTx, input: GateRuleInput, actor: string): Promise<{ id: string; revision: number; version: number; supersededId: string | null; permitTypeCode: string }> {
    const gateCode = gateOf(input.gateCode);
    if (typeof input.requirement !== 'string' || !(GATE_REQUIREMENTS as readonly string[]).includes(input.requirement)) throw invalid('requirement');
    if (typeof input.legalBasis !== 'string' || input.legalBasis.trim() === '') throw new DomainError('LEGAL_BASIS_REQUIRED', 422, 'legal_basis');
    const legalBasis = input.legalBasis.trim();
    // eslint-disable-next-line no-control-regex
    if (legalBasis.length > MAX_LEGAL_BASIS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(legalBasis)) throw invalid('legal_basis');
    const milestone = input.projectMilestoneCode === undefined ? null : input.projectMilestoneCode.trim();
    // eslint-disable-next-line no-control-regex
    if (milestone !== null && (milestone === '' || milestone.length > MAX_MILESTONE || /[\u0000-\u001f\u007f]/.test(milestone))) throw invalid('project_milestone_code');
    const appliesToRule = checkApplicability(input.appliesToRule);
    const effectiveFrom = dateOf(input.effectiveFrom, 'effective_from');
    const effectiveUntil = input.effectiveUntil === undefined ? null : dateOf(input.effectiveUntil, 'effective_until');
    if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) throw invalid('effective_until');

    const type = (await tx.query<{ id: string; code: string; status: string }>('select id, code, status from machvon.permit_type where id = $1::uuid', [input.permitTypeId.toLowerCase()]))[0];
    // A type of another tenant, or one that was never published, is no permit type to ask for.
    if (type === undefined || type.status === 'DRAFT') throw invalid('permit_type_id');

    // One publication at a time per gate and permit type: the checks below read what the other one is about to write.
    await tx.query("select pg_advisory_xact_lock(hashtextextended(coalesce(current_setting('app.tenant_id', true), '') || ':pmt-gate:' || $1::text || ':' || $2::text, 0))", [gateCode, type.code]);
    const latestRow = (await tx.query<RuleSql>(`${SELECT} where gate_code = $1 and permit_type_code = $2 order by revision desc limit 1 for update`, [gateCode, type.code]))[0];
    const latest = latestRow === undefined ? undefined : toRow(latestRow);
    const proposed = { from: effectiveFrom, until: effectiveUntil };
    let supersededId: string | null = null;
    if (latest !== undefined) {
      const endsBefore = latest.effectiveUntil ?? shiftDays(proposed.from, -1);
      const notAfter = proposed.from <= latest.effectiveFrom || endsBefore <= latest.effectiveFrom;
      if (notAfter || periodsOverlap({ from: latest.effectiveFrom, until: endsBefore }, proposed)) throw overlap();
      if (proposed.from < this.today()) throw invalid('effective_from');
      await tx.query(
        `update machvon.permit_gate_rule set status = 'RETIRED', effective_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
        [latest.id, endsBefore, actor],
      );
      supersededId = latest.id;
    }
    const id = randomUUID();
    const revision = (latest?.revision ?? 0) + 1;
    try {
      await tx.query(
        `insert into machvon.permit_gate_rule
           (tenant_id, id, gate_code, project_milestone_code, permit_type_id, requirement, applies_to_rule, legal_basis, effective_from, effective_until, revision, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5, $6::jsonb, $7, $8::date, $9::date, $10, 'PUBLISHED', $11::uuid, $11::uuid)`,
        [id, gateCode, milestone, type.id, input.requirement, JSON.stringify(appliesToRule), legalBasis, effectiveFrom, effectiveUntil, revision, actor],
      );
    } catch (error) {
      // The exclusion constraint and the one-published index are the last word when two publications raced past the checks above.
      const { code, constraint } = error as { code?: string; constraint?: string };
      if (code === EXCLUSION_VIOLATION || (code === UNIQUE_VIOLATION && (constraint === 'permit_gate_rule_published_uq' || constraint === 'permit_gate_rule_rev_uq'))) throw overlap();
      throw error;
    }
    return { id, revision, version: 1, supersededId, permitTypeCode: type.code };
  }

  /** Ends a rule: the last day it applies. The end may only move earlier and not into days that are gone; asking for the end it already has changes nothing. */
  async retire(tx: TenantTx, id: string, effectiveUntil: string, actor: string): Promise<{ row: GateRuleRow; version: number; changed: boolean }> {
    const until = dateOf(effectiveUntil, 'effective_until');
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.status === 'DRAFT') throw invalid('status');
    if (until <= row.effectiveFrom) throw invalid('effective_until');
    const unchanged = row.status === 'RETIRED' && row.effectiveUntil === until;
    if (row.effectiveUntil !== null && until > row.effectiveUntil) throw invalid('effective_until');
    if (!unchanged && until < this.today()) throw invalid('effective_until');
    if (unchanged) return { row, version: row.version, changed: false };
    await tx.query(
      `update machvon.permit_gate_rule set status = 'RETIRED', effective_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, until, actor],
    );
    return { row, version: row.version + 1, changed: true };
  }

  /**
   * Evaluates a gate for a project on a Vietnam day (today by default): the rules in force that day that apply to the project, each judged against
   * the permits of the project's dossiers and the waivers in force. undefined when the project does not exist in the tenant. No rule in force means
   * nothing is asked for: the gate passes.
   */
  async evaluate(tx: TenantTx, projectId: string, gateCode: string, asOf?: string): Promise<GateEvaluation | undefined> {
    const gate = gateOf(gateCode);
    const day = asOf === undefined ? this.today() : dateOf(asOf, 'as_of');
    const place = await this.dossiers.projectPlace(tx, projectId);
    if (place === undefined) return undefined;
    const rules = (
      await tx.query<RuleSql>(`${SELECT} where gate_code = $1 and status <> 'DRAFT' and effective_from <= $2::date and (effective_until is null or effective_until >= $2::date) order by permit_type_code, id`, [gate, day])
    )
      .map(toRow)
      .filter((rule) => appliesTo(rule.appliesToRule, place.facts));
    if (rules.length === 0) return { projectId: place.projectId, gateCode: gate, asOf: day, status: 'PASSED', verdicts: [] };
    const codes = [...new Set(rules.map((rule) => rule.permitTypeCode))];
    const permits = await tx.query<PermitSql>(
      `select x.id, x.permit_type_code, x.permit_no, x.status, x.valid_from::text as valid_from, x.valid_until::text as valid_until, x.no_expiry
         from machvon.permit x join machvon.permit_dossier d on d.tenant_id = x.tenant_id and d.id = x.dossier_id
        where d.project_id = $1::uuid and x.permit_type_code = any($2::text[]) order by x.created_at, x.id`,
      [place.projectId, codes],
    );
    const waivers = await tx.query<WaiverSql>(
      `select w.id, t.code as permit_type_code, w.valid_until::text as valid_until
         from machvon.permit_gate_waiver w join machvon.permit_type t on t.tenant_id = w.tenant_id and t.id = w.permit_type_id
        where w.project_id = $1::uuid and w.gate_code = $2 and w.status = 'ACTIVE' and w.valid_until >= $3::date and (w.approved_at at time zone 'Asia/Ho_Chi_Minh')::date <= $3::date
          and t.code = any($4::text[]) order by w.valid_until desc, w.id`,
      [place.projectId, gate, day, codes],
    );
    const verdicts: RuleVerdict[] = rules.map((rule) => {
      const own = permits.filter((permit) => permit.permit_type_code === rule.permitTypeCode);
      const found = satisfying(rule.requirement, own, day);
      const waiver = found === undefined ? waivers.find((candidate) => candidate.permit_type_code === rule.permitTypeCode) : undefined;
      return {
        ruleId: rule.id,
        revision: rule.revision,
        projectMilestoneCode: rule.projectMilestoneCode,
        permitTypeCode: rule.permitTypeCode,
        requirement: rule.requirement,
        legalBasis: rule.legalBasis,
        effectiveFrom: rule.effectiveFrom,
        effectiveUntil: rule.effectiveUntil,
        outcome: found !== undefined ? 'SATISFIED' : waiver !== undefined ? 'WAIVED' : 'BLOCKING',
        permit: found === undefined ? null : { id: found.id, permitNo: found.permit_no, status: found.status, validUntil: found.valid_until },
        waiver: waiver === undefined ? null : { id: waiver.id, validUntil: waiver.valid_until },
      };
    });
    const status: GateStatus = verdicts.some((verdict) => verdict.outcome === 'BLOCKING') ? 'BLOCKED' : verdicts.some((verdict) => verdict.outcome === 'WAIVED') ? 'PASSED_WITH_WAIVER' : 'PASSED';
    return { projectId: place.projectId, gateCode: gate, asOf: day, status, verdicts };
  }

  /**
   * The port the commands of the other modules call in their own transaction: the evaluation of the gate on a day (today by default), refused with
   * PERMIT_GATE_BLOCKED (409) when it is BLOCKED, naming the rules that block with their legal basis. A project that does not exist is 404.
   */
  async assertPasses(tx: TenantTx, projectId: string, gateCode: string, asOf?: string): Promise<GateEvaluation> {
    const evaluation = await this.evaluate(tx, projectId, gateCode, asOf);
    if (evaluation === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (evaluation.status === 'BLOCKED') {
      const blocking = evaluation.verdicts
        .filter((verdict) => verdict.outcome === 'BLOCKING')
        .map((verdict) => ({ rule_id: verdict.ruleId, permit_type_code: verdict.permitTypeCode, requirement: verdict.requirement, legal_basis: verdict.legalBasis, project_milestone_code: verdict.projectMilestoneCode }));
      throw new DomainError('PERMIT_GATE_BLOCKED', 409, 'gate_code', { extensions: { gate_code: evaluation.gateCode, as_of: evaluation.asOf, blocking } });
    }
    return evaluation;
  }
}
