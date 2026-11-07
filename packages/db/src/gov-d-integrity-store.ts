import { randomUUID } from 'node:crypto';
import {
  DomainError,
  PAYMENT_INTEGRITY_CODE,
  PAYMENT_INTEGRITY_TYPE,
  acceptedCeilingFinding,
  contractCeilingFinding,
  coverageRange,
  diaryFindings,
  duplicateFindings,
  judgeIntegrity,
  normalizedNumber,
  parsePaymentIntegrityParams,
  paymentIntegrityFallback,
  planCeilingFinding,
  unitPriceFindings,
} from '@machvon/kernel';
import type { ClaimIdentity, DiaryPeriod, IntegrityFinding, IntegrityOutcome, IntegritySource, IntegrityVerdict, LiveException, PaymentIntegrityParams, PriceLine } from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM } from './ctr-contract-store.ts';
import type { ContractScopes } from './ctr-contract-store.ts';
import { resolveGovD } from './gov-d-policy.ts';
import { QmsDiaryCoverageReads } from './qms-diary-coverage.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** Runs of the checks, by trigger and outcome (a counter). */
export const PAY_INTEGRITY_RUN_METRIC = 'pay_integrity_run_total';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most that another request can be matched against in one run: the checks look at the closest ones, a request with more than this many look-alikes is blocked long before. */
const PEER_LIMIT = 200;
const PRICE_PEER_LIMIT = 200;
/** A request in one of these states no longer asks for money: it is not a twin of anything. */
const DEAD_STATES = "('RETURNED', 'CANCELLED', 'REVERSED')";

export type IntegrityTrigger = 'SUBMIT' | 'PREVIEW';

export interface IntegrityFindingView {
  id: string;
  code: string;
  kind: 'INVARIANT' | 'SIGNAL';
  severity: 'BLOCK' | 'WARN';
  excused: boolean;
  exceptionId: string | null;
  subject: Record<string, unknown>;
  params: Record<string, unknown>;
}

/** A run as the approver and the auditor read it: what rule decided (version, source, whether its numbers are confirmed), the day, what was found and what could not be read. */
export interface IntegrityRunView {
  id: string;
  paymentRequestId: string;
  contractId: string;
  trigger: IntegrityTrigger;
  outcome: IntegrityOutcome;
  ruleVersion: number;
  ruleSource: 'RULE' | 'DEFAULT';
  ruleUnverified: boolean;
  ruleParams: Record<string, unknown>;
  asOf: string;
  invariantCount: number;
  signalCount: number;
  excusedCount: number;
  unavailable: string[];
  figures: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  findings: IntegrityFindingView[];
}

export interface IntegrityEvaluation {
  run: IntegrityRunView;
  verdict: IntegrityVerdict;
  /** What the exception for the capital plan line lets the request go over by; the sending applies it to the check of the line (undefined when none was used). */
  planWaiverVnd: string | undefined;
  /** The exceptions this run used up (only when the request was sent and not blocked). */
  consumedExceptionIds: string[];
  requestVersion: number;
}

export interface IntegrityEvaluateInput {
  trigger: IntegrityTrigger;
  actor: string;
  today: string;
  scopes: ContractScopes;
  /** The version the caller saw; a request that is no longer at it, or no longer a draft, is left to the command that sends it (it refuses in its own words). */
  expectedVersion?: number | undefined;
  /** Write the run and its findings (the default); `false` only computes (asking for an exception checks a ceiling stands). */
  persist?: boolean;
}

interface RequestSql {
  id: string;
  request_no: string | null;
  request_kind: 'ADVANCE' | 'INTERIM' | 'FINAL';
  status: string;
  version: string;
  contract_id: string;
  project_id: string;
  acceptance_id: string | null;
  allocation_line_id: string | null;
  gross_vnd: string;
  advance_recovery_vnd: string;
  net_vnd: string;
  claims_acceptance: boolean;
  contractor_id: string;
  contract_value_vnd: string;
  requested_total_vnd: string;
  paid_total_vnd: string;
  advance_paid_vnd: string;
  advance_recovered_vnd: string;
}

const REQUEST_SELECT = `select pr.id, pr.request_no, pr.request_kind, pr.status, pr.version::text as version, pr.contract_id, pr.project_id, pr.acceptance_id, pr.allocation_line_id, pr.gross_vnd::text as gross_vnd,
       pr.advance_recovery_vnd::text as advance_recovery_vnd, pr.net_vnd::text as net_vnd, pr.claims_acceptance, c.contractor_id, c.contract_value_vnd::text as contract_value_vnd, c.requested_total_vnd::text as requested_total_vnd,
       c.paid_total_vnd::text as paid_total_vnd, c.advance_paid_vnd::text as advance_paid_vnd, c.advance_recovered_vnd::text as advance_recovered_vnd
  from machvon.payment_request pr
  join machvon.contract c on c.tenant_id = pr.tenant_id and c.id = pr.contract_id`;

/** What the table gave for a finding or a run in the words of the view. */
interface FindingSql {
  id: string;
  run_id: string;
  payment_request_id: string;
  contract_id: string;
  code: string;
  kind: 'INVARIANT' | 'SIGNAL';
  severity: 'BLOCK' | 'WARN';
  excused: boolean;
  exception_id: string | null;
  subject: Record<string, unknown>;
  params: Record<string, unknown>;
  created_at: string;
}
interface RunSql {
  id: string;
  payment_request_id: string;
  contract_id: string;
  trigger_kind: IntegrityTrigger;
  outcome: IntegrityOutcome;
  rule_version: number;
  rule_source: 'RULE' | 'DEFAULT';
  rule_unverified: boolean;
  rule_params: Record<string, unknown>;
  as_of: string;
  invariant_count: number;
  signal_count: number;
  excused_count: number;
  unavailable: string[];
  figures: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

const TIMESTAMP = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const RUN_COLUMNS = `r.id, r.payment_request_id, r.contract_id, r.trigger_kind, r.outcome, r.rule_version, r.rule_source, r.rule_unverified, r.rule_params, r.as_of::text as as_of, r.invariant_count, r.signal_count, r.excused_count,
  r.unavailable, r.figures, r.created_by, ${TIMESTAMP('r.created_at')} as created_at`;
const FINDING_COLUMNS = `f.id, f.run_id, f.payment_request_id, f.contract_id, f.code, f.kind, f.severity, f.excused, f.exception_id, f.subject, f.params, ${TIMESTAMP('f.created_at')} as created_at`;

const findingView = (row: FindingSql): IntegrityFindingView => ({ id: row.id, code: row.code, kind: row.kind, severity: row.severity, excused: row.excused, exceptionId: row.exception_id, subject: row.subject, params: row.params });
const runView = (row: RunSql, findings: IntegrityFindingView[]): IntegrityRunView => ({
  id: row.id,
  paymentRequestId: row.payment_request_id,
  contractId: row.contract_id,
  trigger: row.trigger_kind,
  outcome: row.outcome,
  ruleVersion: row.rule_version,
  ruleSource: row.rule_source,
  ruleUnverified: row.rule_unverified,
  ruleParams: row.rule_params,
  asOf: row.as_of,
  invariantCount: row.invariant_count,
  signalCount: row.signal_count,
  excusedCount: row.excused_count,
  unavailable: row.unavailable,
  figures: row.figures,
  createdBy: row.created_by,
  createdAt: row.created_at,
  findings,
});

export interface IntegrityFindingFilter {
  code?: string | undefined;
  kind?: 'INVARIANT' | 'SIGNAL' | undefined;
  contractId?: string | undefined;
  /** Business days (`YYYY-MM-DD`) of the run, inclusive, in Vietnamese time. */
  from?: string | undefined;
  to?: string | undefined;
}

export interface IntegrityFindingLine extends IntegrityFindingView {
  runId: string;
  paymentRequestId: string;
  requestNo: string | null;
  contractId: string;
  contractCode: string;
  projectCode: string;
  trigger: IntegrityTrigger;
  outcome: IntegrityOutcome;
  ruleVersion: number;
  createdAt: string;
}

/** Runs a read that feeds a signal inside a savepoint: when it fails the source is told as unavailable and the transaction goes on (a source that cannot be read is never "nothing found"). */
async function soft<T>(tx: TenantTx, source: IntegritySource, gaps: IntegritySource[], work: () => Promise<T>, empty: T): Promise<T> {
  const name = `integrity_${source.toLowerCase()}`;
  await tx.query(`savepoint ${name}`);
  try {
    const value = await work();
    await tx.query(`release savepoint ${name}`);
    return value;
  } catch {
    await tx.query(`rollback to savepoint ${name}`);
    await tx.query(`release savepoint ${name}`);
    gaps.push(source);
    return empty;
  }
}

/**
 * The checks of a payment request before money goes out (G4-2 and the ceilings of G4-5, lane D). It reads the facts of the request (one query per source), asks the kernel for the findings under the rule PAYMENT_INTEGRITY in force on the
 * day (`resolveGovD`: an approved version of the tenant, else the built-in default that says it is unconfirmed), lets an approved exception cover a ceiling it names, and writes the run and its findings (append-only) for the approver
 * and the auditor. Duplicates and ceilings are read without a net: when they cannot be read the command fails, never passes. Prices and the diary feed signals only: when they cannot be read the run says so (`PARTIAL`), never PASSED.
 * It builds on the money control: the position of the contract is `contractAvailability`, the capital line is the one `PayClaimStore` checks when sending, and the diary is `QmsDiaryCoverageReads`.
 */
export class PayIntegrityStore {
  private readonly contracts = new CtrContractStore();
  private readonly diaries = new QmsDiaryCoverageReads();

  /**
   * Checks a request. With `SUBMIT` the contract is locked first (the order of the locks of sending), and a request that is not a draft at the version the caller saw is answered with `undefined`: the command that sends it
   * refuses in its own words (409). With `PREVIEW` the request is read within the read scope and is any state. A request outside the scope is 404.
   */
  async evaluate(tx: TenantTx, requestId: string, input: IntegrityEvaluateInput): Promise<IntegrityEvaluation | undefined> {
    if (!UUID.test(requestId)) throw new DomainError('VALIDATION_FAILED', 422, 'id');
    const id = requestId.toLowerCase();
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.payment_request where id = $1::uuid', [id]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (input.trigger === 'SUBMIT') await this.contracts.lock(tx, peek[0].contract_id, input.scopes);
    else await this.assertReadable(tx, peek[0].contract_id, input.scopes.read);
    const [request] = await tx.query<RequestSql>(`${REQUEST_SELECT} where pr.id = $1::uuid`, [id]);
    if (request === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (input.trigger === 'SUBMIT' && (request.status !== 'DRAFT' || (input.expectedVersion !== undefined && Number(request.version) !== input.expectedVersion))) return undefined;

    const rule = await resolveGovD(tx, PAYMENT_INTEGRITY_TYPE, PAYMENT_INTEGRITY_CODE, input.today, paymentIntegrityFallback());
    // A rule that cannot be understood is never half applied: the parser of the kernel refuses it (422 GOVERNANCE_RULE_PARAMS_INVALID).
    const params = parsePaymentIntegrityParams(rule.params);
    const onBooks = request.status !== 'DRAFT';
    const gaps: IntegritySource[] = [];
    const found: IntegrityFinding[] = [];

    // 1. The twins of the request (read without a net).
    const identity = await this.identityOf(tx, request);
    found.push(...duplicateFindings(identity, await this.twins(tx, request, identity, params, input.today), params.duplicate));
    // 2. The ceilings (read without a net).
    const ceilings = await this.ceilings(tx, request, params, onBooks);
    found.push(...ceilings.findings);
    // 3. The unit prices and 4. the diary of the site (signals: unreadable means told, not passed).
    found.push(...(await soft<IntegrityFinding[]>(tx, 'PRICES', gaps, async () => unitPriceFindings(await this.priceLines(tx, request, params, input.today), params.unit_price), [])));
    found.push(...(await soft<IntegrityFinding[]>(tx, 'DIARY', gaps, async () => diaryFindings(await this.diaryPeriods(tx, request, input.today), params.diary), [])));

    const exceptions = await this.liveExceptions(tx, id, input.today, input.persist !== false && input.trigger === 'SUBMIT');
    const verdict = judgeIntegrity(found, exceptions, gaps, input.today);
    const figures = { gross_vnd: request.gross_vnd, net_vnd: request.net_vnd, advance_recovery_vnd: request.advance_recovery_vnd, request_kind: request.request_kind, request_status: request.status, ...ceilings.figures };
    const planWaiver = verdict.findings.find((one) => one.code === 'EXCEEDS_PLAN' && one.excusedBy !== null);
    const stored = input.persist === false ? undefined : await this.write(tx, request, input, rule, params, verdict, figures);
    const run = stored ?? this.unsaved(request, input, rule, params, verdict, figures);
    const consumes = input.persist !== false && input.trigger === 'SUBMIT' && verdict.outcome !== 'BLOCKED';
    const consumedExceptionIds = consumes ? [...new Set(verdict.findings.flatMap((one) => (one.excusedBy === null ? [] : [one.excusedBy])))] : [];
    for (const exceptionId of consumedExceptionIds) {
      await tx.query("update machvon.disbursement_exception set status = 'USED', used_at = now(), used_run_id = $2::uuid, updated_at = now(), version = version + 1 where id = $1::uuid and status = 'APPROVED'", [exceptionId, run.id]);
    }
    return {
      run,
      verdict,
      planWaiverVnd: consumes && planWaiver !== undefined ? exceptions.find((one) => one.id === planWaiver.excusedBy)?.allowedAmountVnd : undefined,
      consumedExceptionIds,
      requestVersion: Number(request.version),
    };
  }

  /** The latest run of a request within the read scope; undefined when it was never checked; a request outside the scope is 404. */
  async latestRun(tx: TenantTx, requestId: string, read: ScopeBuilder): Promise<{ run: IntegrityRunView | undefined; requestStatus: string }> {
    if (!UUID.test(requestId)) throw new DomainError('VALIDATION_FAILED', 422, 'id');
    const id = requestId.toLowerCase();
    const [request] = await tx.query<{ contract_id: string; status: string }>('select contract_id, status from machvon.payment_request where id = $1::uuid', [id]);
    if (request === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.assertReadable(tx, request.contract_id, read);
    const [row] = await tx.query<RunSql>(`select ${RUN_COLUMNS} from machvon.payment_integrity_run r where r.payment_request_id = $1::uuid order by r.created_at desc, r.id desc limit 1`, [id]);
    if (row === undefined) return { run: undefined, requestStatus: request.status };
    const findings = await tx.query<FindingSql>(`select ${FINDING_COLUMNS} from machvon.payment_integrity_finding f where f.run_id = $1::uuid order by f.kind, f.code, f.created_at, f.id`, [row.id]);
    return { run: runView(row, await this.withoutHiddenTwins(tx, findings.map(findingView), read)), requestStatus: request.status };
  }

  /** The findings of all runs in the scope of the auditor, newest first; keyset by (created_at, id). */
  async listFindings(tx: TenantTx, read: ScopeBuilder, filter: IntegrityFindingFilter, limit: number, after: { createdAt: string; id: string } | undefined): Promise<IntegrityFindingLine[]> {
    const params: unknown[] = [];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (filter.code !== undefined) where.push(`f.code = ${add(filter.code)}`);
    if (filter.kind !== undefined) where.push(`f.kind = ${add(filter.kind)}`);
    if (filter.contractId !== undefined) where.push(`f.contract_id = ${add(filter.contractId)}::uuid`);
    if (filter.from !== undefined) where.push(`(f.created_at at time zone 'Asia/Ho_Chi_Minh')::date >= ${add(filter.from)}::date`);
    if (filter.to !== undefined) where.push(`(f.created_at at time zone 'Asia/Ho_Chi_Minh')::date <= ${add(filter.to)}::date`);
    if (after !== undefined) where.push(`(f.created_at, f.id) < (${add(after.createdAt)}::timestamptz, ${add(after.id)}::uuid)`);
    const first = params.length + 1;
    const predicate = read(first);
    params.push(...predicate.params);
    const rows = await tx.query<FindingSql & { request_no: string | null; contract_code: string; project_code: string; trigger_kind: IntegrityTrigger; outcome: IntegrityOutcome; rule_version: number }>(
      `select ${FINDING_COLUMNS}, pr.request_no, c.code as contract_code, p.code as project_code, r.trigger_kind, r.outcome, r.rule_version
         from machvon.payment_integrity_finding f
         join machvon.payment_integrity_run r on r.tenant_id = f.tenant_id and r.id = f.run_id
         join machvon.payment_request pr on pr.tenant_id = f.tenant_id and pr.id = f.payment_request_id
         join machvon.contract c on c.tenant_id = f.tenant_id and c.id = f.contract_id
         join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where ${[...where, predicate.sql].join(' and ')}
        order by f.created_at desc, f.id desc limit ${add(limit)}`,
      params,
    );
    const shown = await this.withoutHiddenTwins(tx, rows.map(findingView), read);
    return rows.map((row, at) => ({
      ...(shown[at] as IntegrityFindingView),
      runId: row.run_id,
      paymentRequestId: row.payment_request_id,
      requestNo: row.request_no,
      contractId: row.contract_id,
      contractCode: row.contract_code,
      projectCode: row.project_code,
      trigger: row.trigger_kind,
      outcome: row.outcome,
      ruleVersion: row.rule_version,
      createdAt: row.created_at,
    }));
  }

  /** The other request of a duplicate is named only to a reader who may read it: otherwise the finding says a twin exists (`other_hidden`) and nothing else about it. */
  private async withoutHiddenTwins(tx: TenantTx, findings: IntegrityFindingView[], read: ScopeBuilder): Promise<IntegrityFindingView[]> {
    const ids = [...new Set(findings.flatMap((one) => (typeof one.subject.other_request_id === 'string' ? [one.subject.other_request_id] : [])))];
    if (ids.length === 0) return findings;
    const predicate = read(2);
    const visible = new Set(
      (
        await tx.query<{ id: string }>(
          `select pr.id from machvon.payment_request pr join machvon.contract c on c.tenant_id = pr.tenant_id and c.id = pr.contract_id
             join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
             join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
             left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
            where pr.id = any($1::uuid[]) and ${predicate.sql}`,
          [ids, ...predicate.params],
        )
      ).map((row) => row.id),
    );
    return findings.map((one) => {
      const other = one.subject.other_request_id;
      if (typeof other !== 'string' || visible.has(other)) return one;
      const rest = Object.fromEntries(Object.entries(one.subject).filter(([name]) => name !== 'other_request_id'));
      return { ...one, subject: { ...rest, other_hidden: true } };
    });
  }

  // ---- the facts --------------------------------------------------------------------------------------------------------------

  private async assertReadable(tx: TenantTx, contractId: string, read: ScopeBuilder): Promise<void> {
    const predicate = read(2);
    const seen = await tx.query<{ id: string }>(`select c.id from ${SCOPE_FROM} where c.id = $1::uuid and ${predicate.sql}`, [contractId, ...predicate.params]);
    if (seen[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  }

  private async identityOf(tx: TenantTx, request: RequestSql): Promise<ClaimIdentity> {
    const documents = await tx.query<{ invoice_no: string | null; invoice_date: string | null }>(
      "select invoice_no, invoice_date::text as invoice_date from machvon.payment_document where payment_request_id = $1::uuid and doc_kind = 'INVOICE'",
      [request.id],
    );
    return {
      id: request.id,
      numbers: [...(request.request_no === null ? [] : [request.request_no]), ...documents.flatMap((row) => (row.invoice_no === null ? [] : [row.invoice_no]))],
      supplierId: request.contractor_id,
      grossVnd: request.gross_vnd,
      invoiceDates: documents.flatMap((row) => (row.invoice_date === null ? [] : [row.invoice_date])),
    };
  }

  /** The other requests that could be the same claim: the same supplier and amount, or a number in common, within the look-back, not given back, cancelled or reversed. */
  private async twins(tx: TenantTx, request: RequestSql, identity: ClaimIdentity, params: PaymentIntegrityParams, today: string): Promise<ClaimIdentity[]> {
    const numbers = [...new Set(identity.numbers.map(normalizedNumber).filter((number) => number !== ''))];
    const rows = await tx.query<{ id: string; request_no: string | null; gross_vnd: string; contractor_id: string; invoice_nos: string[]; invoice_dates: string[] }>(
      `select pr.id, pr.request_no, pr.gross_vnd::text as gross_vnd, c.contractor_id,
              coalesce(array_agg(d.invoice_no) filter (where d.invoice_no is not null), '{}') as invoice_nos,
              coalesce(array_agg(distinct d.invoice_date::text) filter (where d.invoice_date is not null), '{}') as invoice_dates
         from machvon.payment_request pr
         join machvon.contract c on c.tenant_id = pr.tenant_id and c.id = pr.contract_id
         left join machvon.payment_document d on d.tenant_id = pr.tenant_id and d.payment_request_id = pr.id and d.doc_kind = 'INVOICE'
        where pr.id <> $1::uuid and pr.status not in ${DEAD_STATES} and pr.created_at >= ($2::date - $3::int)
          and ((c.contractor_id = $4::uuid and pr.gross_vnd = $5::numeric)
               or upper(regexp_replace(coalesce(pr.request_no, ''), '[^A-Za-z0-9]', '', 'g')) = any($6::text[])
               or exists (select 1 from machvon.payment_document x where x.tenant_id = pr.tenant_id and x.payment_request_id = pr.id and x.doc_kind = 'INVOICE'
                             and upper(regexp_replace(coalesce(x.invoice_no, ''), '[^A-Za-z0-9]', '', 'g')) = any($6::text[])))
        group by pr.tenant_id, pr.id, c.contractor_id
        order by pr.created_at desc, pr.id limit ${PEER_LIMIT}`,
      [request.id, today, params.duplicate.lookback_days, request.contractor_id, request.gross_vnd, numbers],
    );
    return rows.map((row) => ({ id: row.id, numbers: [...(row.request_no === null ? [] : [row.request_no]), ...row.invoice_nos], supplierId: row.contractor_id, grossVnd: row.gross_vnd, invoiceDates: row.invoice_dates }));
  }

  private async ceilings(tx: TenantTx, request: RequestSql, params: PaymentIntegrityParams, onBooks: boolean): Promise<{ findings: IntegrityFinding[]; figures: Record<string, unknown> }> {
    const findings: IntegrityFinding[] = [];
    const figures: Record<string, unknown> = {};
    const price = contractCeilingFinding(
      {
        currentPriceVnd: request.contract_value_vnd,
        originalPriceVnd: request.contract_value_vnd,
        requestedTotalVnd: request.requested_total_vnd,
        paidTotalVnd: request.paid_total_vnd,
        advancePaidVnd: request.advance_paid_vnd,
        advanceRecoveredVnd: request.advance_recovered_vnd,
        pendingIncreaseVnd: '0',
        requestKind: request.request_kind,
        grossVnd: request.gross_vnd,
        advanceRecoveryVnd: request.advance_recovery_vnd,
        onBooks,
      },
      params.ceilings.contract,
    );
    figures.contract_price_vnd = request.contract_value_vnd;
    if (price !== undefined) findings.push(price);
    if (request.allocation_line_id !== null) {
      const [balance] = await tx.query<{ allocated: string; disbursed: string }>('select allocated_vnd::text as allocated, disbursed_vnd::text as disbursed from machvon.allocation_balance where allocation_line_id = $1::uuid', [request.allocation_line_id]);
      if (balance !== undefined) {
        const [flight] = await tx.query<{ net: string }>(
          "select coalesce(sum(net_vnd), 0)::text as net from machvon.payment_request where allocation_line_id = $1::uuid and id <> $2::uuid and status in ('SUBMITTED', 'VERIFIED', 'SENT_TREASURY')",
          [request.allocation_line_id, request.id],
        );
        figures.plan_allocated_vnd = balance.allocated;
        figures.plan_disbursed_vnd = balance.disbursed;
        const plan = planCeilingFinding({ allocatedVnd: balance.allocated, disbursedVnd: balance.disbursed, inFlightVnd: flight?.net ?? '0', netVnd: request.net_vnd }, params.ceilings.plan);
        if (plan !== undefined) findings.push(plan);
      }
    }
    if (request.acceptance_id !== null && request.request_kind !== 'ADVANCE') {
      const [acceptance] = await tx.query<{ accepted: string }>('select a.accepted_amount_vnd::text as accepted from machvon.acceptance a where a.id = $1::uuid', [request.acceptance_id]);
      if (acceptance !== undefined) {
        figures.accepted_vnd = acceptance.accepted;
        // Another request that holds the same acceptance is not counted here: one claim per acceptance is kept by the claim itself (409 ACCEPTANCE_ALREADY_CLAIMED), which has its own answer.
        const accepted = acceptedCeilingFinding({ acceptedVnd: acceptance.accepted, claimedByOthersVnd: '0', grossVnd: request.gross_vnd }, params.ceilings.accepted);
        if (accepted !== undefined) findings.push(accepted);
      }
    }
    return { findings, figures };
  }

  private async priceLines(tx: TenantTx, request: RequestSql, params: PaymentIntegrityParams, today: string): Promise<PriceLine[]> {
    const lines = await tx.query<{ line_id: string; business_key: string; description: string; unit_code: string; unit_price: string; contract_price: string | null }>(
      `select prl.id as line_id, bi.business_key, bi.description, bi.unit_code, al.unit_price_snapshot::text as unit_price,
              (select bl.unit_price::text from machvon.boq_line bl
                where bl.tenant_id = al.tenant_id and bl.boq_item_id = al.boq_item_id and bl.contract_revision_id = coalesce(c.current_revision_id, al.contract_revision_id) limit 1) as contract_price
         from machvon.payment_request_line prl
         join machvon.acceptance_line al on al.tenant_id = prl.tenant_id and al.id = prl.acceptance_line_id
         join machvon.boq_item bi on bi.tenant_id = prl.tenant_id and bi.id = prl.boq_item_id
         join machvon.contract c on c.tenant_id = al.tenant_id and c.id = bi.contract_id
        where prl.payment_request_id = $1::uuid order by prl.id`,
      [request.id],
    );
    const out: PriceLine[] = [];
    for (const line of lines) {
      const peers = await tx.query<{ unit_price: string }>(
        `select al.unit_price_snapshot::text as unit_price
           from machvon.acceptance_line al
           join machvon.boq_item bi on bi.tenant_id = al.tenant_id and bi.id = al.boq_item_id
          where lower(btrim(bi.description)) = lower(btrim($1)) and bi.unit_code = $2 and al.active and al.acceptance_id is distinct from $3::uuid and al.created_at >= ($4::date - $5::int)
          order by al.created_at desc, al.id limit ${PRICE_PEER_LIMIT}`,
        [line.description, line.unit_code, request.acceptance_id, today, params.duplicate.lookback_days],
      );
      out.push({ lineId: line.line_id, boqKey: line.business_key, unitCode: line.unit_code, unitPrice: line.unit_price, contractUnitPrice: line.contract_price, peerPrices: peers.map((row) => row.unit_price) });
    }
    return out;
  }

  /**
   * The measured period of the request against the diary of the site: per period of the measurements behind the acceptance, the working days and the days with a diary (`QmsDiaryCoverageReads`, the calendar WORKDAY_VN) and, for the items
   * whose diaries record a quantity (`content.work_done[]` of `{boq_key, quantity}`), the quantity measured against the quantity recorded.
   */
  private async diaryPeriods(tx: TenantTx, request: RequestSql, today: string): Promise<DiaryPeriod[]> {
    const measured = await tx.query<{ period_id: string; start_date: string; end_date: string; business_key: string; quantity: string }>(
      `select m.period_id, rp.start_date::text as start_date, rp.end_date::text as end_date, bi.business_key, sum(m.quantity_period)::text as quantity
         from machvon.payment_request_line prl
         join machvon.acceptance_line al on al.tenant_id = prl.tenant_id and al.id = prl.acceptance_line_id
         join machvon.measurement m on m.tenant_id = al.tenant_id and m.id = al.measurement_id
         join machvon.reporting_period rp on rp.tenant_id = m.tenant_id and rp.id = m.period_id
         join machvon.boq_item bi on bi.tenant_id = al.tenant_id and bi.id = al.boq_item_id
        where prl.payment_request_id = $1::uuid
        group by m.period_id, rp.start_date, rp.end_date, bi.business_key
        order by rp.start_date, bi.business_key`,
      [request.id],
    );
    const periods = new Map<string, { from: string; to: string; items: Array<{ key: string; quantity: string }> }>();
    for (const row of measured) {
      const known = periods.get(row.period_id) ?? { from: row.start_date, to: row.end_date, items: [] };
      known.items.push({ key: row.business_key, quantity: row.quantity });
      periods.set(row.period_id, known);
    }
    const out: DiaryPeriod[] = [];
    for (const period of periods.values()) {
      const coverage = await this.diaries.coverage(tx, request.contract_id, coverageRange(period.from, period.to, today));
      const recorded = await tx.query<{ key: string; quantity: string }>(
        `select e.value ->> 'boq_key' as key, sum((e.value ->> 'quantity')::numeric)::text as quantity
           from machvon.site_diary d
           cross join lateral jsonb_array_elements(case when jsonb_typeof(d.content -> 'work_done') = 'array' then d.content -> 'work_done' else '[]'::jsonb end) as e(value)
          where d.contract_id = $1::uuid and d.record_date between $2::date and $3::date and d.conflict_of_id is null and d.status <> 'SUPERSEDED' and (d.correction_of_id is null or d.status = 'LOCKED')
            and e.value ->> 'boq_key' is not null and (e.value ->> 'quantity') ~ '^[0-9]+(\\.[0-9]{1,6})?$'
          group by 1`,
        [request.contract_id, period.from, period.to],
      );
      const byKey = new Map(recorded.map((row) => [row.key, row.quantity]));
      out.push({
        periodFrom: period.from,
        periodTo: period.to,
        workingDays: coverage.totals.workingDays,
        withDiary: coverage.totals.withDiary,
        quantities: period.items.map((item) => ({ boqKey: item.key, measured: item.quantity, recorded: byKey.get(item.key) ?? null })),
      });
    }
    return out;
  }

  private async liveExceptions(tx: TenantTx, requestId: string, today: string, lock: boolean): Promise<LiveException[]> {
    const rows = await tx.query<{ id: string; ceiling: 'EXCEEDS_PLAN' | 'EXCEEDS_CONTRACT'; allowed: string; valid_to: string }>(
      `select id, ceiling, allowed_amount_vnd::text as allowed, valid_to::text as valid_to from machvon.disbursement_exception
        where payment_request_id = $1::uuid and status = 'APPROVED' and valid_to >= $2::date order by valid_to, id ${lock ? 'for update' : ''}`,
      [requestId, today],
    );
    return rows.map((row) => ({ id: row.id, ceiling: row.ceiling, allowedAmountVnd: row.allowed, validTo: row.valid_to }));
  }

  // ---- the record -------------------------------------------------------------------------------------------------------------

  private unsaved(request: RequestSql, input: IntegrityEvaluateInput, rule: Awaited<ReturnType<typeof resolveGovD>>, params: PaymentIntegrityParams, verdict: IntegrityVerdict, figures: Record<string, unknown>): IntegrityRunView {
    return {
      id: randomUUID(),
      paymentRequestId: request.id,
      contractId: request.contract_id,
      trigger: input.trigger,
      outcome: verdict.outcome,
      ruleVersion: rule.version,
      ruleSource: rule.source,
      ruleUnverified: rule.unverified,
      ruleParams: params as unknown as Record<string, unknown>,
      asOf: input.today,
      invariantCount: verdict.invariantCount,
      signalCount: verdict.signalCount,
      excusedCount: verdict.excusedCount,
      unavailable: verdict.unavailable,
      figures,
      createdBy: input.actor,
      createdAt: new Date().toISOString(),
      findings: verdict.findings.map((one) => ({ id: randomUUID(), code: one.code, kind: one.kind, severity: one.severity, excused: one.excusedBy !== null, exceptionId: one.excusedBy, subject: one.subject, params: one.params })),
    };
  }

  private async write(tx: TenantTx, request: RequestSql, input: IntegrityEvaluateInput, rule: Awaited<ReturnType<typeof resolveGovD>>, params: PaymentIntegrityParams, verdict: IntegrityVerdict, figures: Record<string, unknown>): Promise<IntegrityRunView> {
    const runId = randomUUID();
    await tx.query(
      `insert into machvon.payment_integrity_run (tenant_id, id, payment_request_id, contract_id, project_id, trigger_kind, outcome, rule_version, rule_source, rule_unverified, rule_params, as_of, invariant_count, signal_count, excused_count, unavailable, figures, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10::jsonb, $11::date, $12, $13, $14, $15::jsonb, $16::jsonb, $17::uuid)`,
      [runId, request.id, request.contract_id, request.project_id, input.trigger, verdict.outcome, rule.version, rule.source, rule.unverified, JSON.stringify(params), input.today, verdict.invariantCount, verdict.signalCount, verdict.excusedCount, JSON.stringify(verdict.unavailable), JSON.stringify(figures), input.actor],
    );
    for (const one of verdict.findings) {
      await tx.query(
        `insert into machvon.payment_integrity_finding (tenant_id, id, run_id, payment_request_id, contract_id, code, kind, severity, excused, exception_id, subject, params)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::uuid, $10::jsonb, $11::jsonb)`,
        [randomUUID(), runId, request.id, request.contract_id, one.code, one.kind, one.severity, one.excusedBy !== null, one.excusedBy, JSON.stringify(one.subject), JSON.stringify(one.params)],
      );
    }
    const [row] = await tx.query<RunSql>(`select ${RUN_COLUMNS} from machvon.payment_integrity_run r where r.id = $1::uuid`, [runId]);
    const findings = await tx.query<FindingSql>(`select ${FINDING_COLUMNS} from machvon.payment_integrity_finding f where f.run_id = $1::uuid order by f.kind, f.code, f.created_at, f.id`, [runId]);
    if (row === undefined) throw new Error('payment integrity run was not written');
    return runView(row, findings.map(findingView));
  }
}
