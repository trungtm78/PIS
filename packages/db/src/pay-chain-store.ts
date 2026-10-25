import { DomainError } from '@machvon/kernel';
import { normalizeUuid } from './file-import-item-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The most nodes of one type a chain shows: a project with more is shown cut, and says so. */
export const CHAIN_NODE_LIMIT = 500;
/** The most contracts a chain of a whole project shows. */
export const CHAIN_CONTRACT_LIMIT = 50;

export const CHAIN_NODE_TYPES = ['project', 'contract', 'measurement', 'acceptance', 'payment_request', 'treasury_transaction', 'settlement_revision'] as const;
export type ChainNodeType = (typeof CHAIN_NODE_TYPES)[number];

/** One node of the chain: the record, the version it stands at, and what a screen needs to name it. Nothing here names a person. */
export interface ChainNode {
  type: ChainNodeType;
  id: string;
  /** The version of the row (the counter of its optimistic lock); null for a row that has none (a Treasury transaction never changes but for its match). */
  version: number | null;
  /** The revision a record keeps beside its version: the revision of a contract, of a measurement or of a settlement. */
  revision: number | null;
  status: string | null;
  /** The code or number a person reads. */
  label: string;
  /** The contract the node belongs to, when it belongs to one. */
  contractId: string | null;
  /** The amount the node stands for, whole VND, when it has one. */
  amountVnd: string | null;
  /** True for a measurement or a settlement that a later revision replaced. */
  superseded: boolean;
  /** What else the node says (dates, kinds), by name: a closed set of plain facts. */
  facts: Record<string, string | number | boolean | null>;
}

export interface ChainEdge {
  from: string;
  to: string;
  relation: 'HAS_CONTRACT' | 'MEASURED_IN' | 'ACCEPTED_AS' | 'CLAIMED_BY' | 'PAID_BY' | 'SETTLED_IN' | 'CORRECTS';
}

export interface PaymentChain {
  projectId: string;
  /** The contract asked for, or null for all the contracts of the project. */
  contractId: string | null;
  nodes: ChainNode[];
  edges: ChainEdge[];
  /** The payment requests that count (sent, checked, with the Treasury or settled): how many and their gross, and the part that was settled. */
  totals: { countedRequests: number; countedGrossVnd: string; settledGrossVnd: string };
  /** The types of which more nodes exist than are shown. */
  truncated: ChainNodeType[];
}

interface ProjectRow {
  id: string;
  code: string;
  name: string;
  status: string;
  version: string;
  created_at: string;
}

interface ContractRow {
  id: string;
  code: string;
  status: string;
  version: string;
  revision: number | null;
  value_vnd: string | null;
  created_at: string;
}

interface MeasurementRow {
  id: string;
  contract_id: string;
  reference_no: string | null;
  revision: number;
  status: string;
  version: string;
  correction_of_id: string | null;
  quantity_period: string;
  created_at: string;
}

interface AcceptanceRow {
  id: string;
  contract_id: string;
  acceptance_no: string | null;
  status: string;
  version: string;
  accepted_amount_vnd: string;
  created_at: string;
}

interface PaymentRow {
  id: string;
  contract_id: string;
  acceptance_id: string | null;
  settlement_revision_id: string | null;
  request_no: string | null;
  request_kind: string;
  status: string;
  version: string;
  gross_vnd: string;
  net_vnd: string;
  treasury_paid_on: string | null;
  created_at: string;
}

interface TransactionRow {
  id: string;
  contract_id: string | null;
  payment_request_id: string;
  document_no: string | null;
  direction: string;
  amount_vnd: string;
  match_status: string;
  confirmed_at: string;
  created_at: string;
}

interface SettlementRow {
  id: string;
  contract_id: string | null;
  settlement_scope: string;
  fiscal_year: number | null;
  revision: number;
  status: string;
  version: string;
  settled_amount_vnd: string;
  created_at: string;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const ts = (column: string): string => `to_char(${column} at time zone 'UTC', ${ISO})`;
const COUNTED_STATUSES = ['SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'SETTLED'];

/**
 * The trace of a payment, from the project to its settlement (ST-PAY-010, PAY 3.4, UAT-AC67): the project, its contract with the revision in force, the measurements the acceptances rest on (every
 * revision of a measurement that was corrected, the one replaced marked as superseded), the acceptances, the payment requests drawn from them, the Treasury transactions matched to those and the
 * settlements of the project or of the contract, each node with its id and the version it stands at. Read only: nothing is computed or written. The project is looked for inside the scope of the
 * caller, so a project of another tenant, or one the caller may not reach, is a project that is not there.
 */
export class PayChainStore {
  /** The limits are the constants above; a test can take lower ones to see a chain cut. */
  private readonly limits: { nodes: number; contracts: number };

  constructor(limits: { nodes: number; contracts: number } = { nodes: CHAIN_NODE_LIMIT, contracts: CHAIN_CONTRACT_LIMIT }) {
    this.limits = limits;
  }

  async read(tx: TenantTx, scope: ScopeBuilder, input: { projectId: string; contractId?: string | undefined }): Promise<PaymentChain> {
    const projectId = normalizeUuid(input.projectId, 'project_id');
    const contractId = input.contractId === undefined ? null : normalizeUuid(input.contractId, 'contract_id');
    const predicate = scope(2);
    const [project] = await tx.query<ProjectRow>(
      `select p.id, p.code, p.name, p.status, p.version::text as version, ${ts('p.created_at')} as created_at from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`,
      [projectId, ...predicate.params],
    );
    // A project outside the scope of the caller is a project that is not there.
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);

    const contracts = await tx.query<ContractRow>(
      `select c.id, c.code, c.status, c.version::text as version, r.revision, r.amount_vnd::text as value_vnd, ${ts('c.created_at')} as created_at
         from machvon.contract c left join machvon.contract_revision r on r.tenant_id = c.tenant_id and r.id = c.current_revision_id
        where c.project_id = $1::uuid and ($2::uuid is null or c.id = $2::uuid) order by c.created_at, c.id limit ${this.limits.contracts + 1}`,
      [projectId, contractId],
    );
    if (contractId !== null && contracts.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const truncated = new Set<ChainNodeType>();
    if (contracts.length > this.limits.contracts) {
      contracts.pop();
      truncated.add('contract');
    }
    const contractIds = contracts.map((row) => row.id);

    const acceptances = await this.limited(
      truncated,
      'acceptance',
      tx.query<AcceptanceRow>(
        `select id, contract_id, acceptance_no, status, version::text as version, accepted_amount_vnd::text as accepted_amount_vnd, measurement_ids, ${ts('created_at')} as created_at
           from machvon.acceptance where contract_id = any($1::uuid[]) order by created_at, id limit ${this.limits.nodes + 1}`,
        [contractIds],
      ),
    );
    const measurements = await this.limited(
      truncated,
      'measurement',
      tx.query<MeasurementRow>(
        `with recursive used as (
           select m.id from machvon.measurement m
            where m.contract_id = any($1::uuid[]) and m.id in (select l.measurement_id from machvon.acceptance_line l join machvon.acceptance a on a.tenant_id = l.tenant_id and a.id = l.acceptance_id where a.contract_id = any($1::uuid[]))
         ), later as (
           select id from used
           union
           select m.id from machvon.measurement m join later l on m.correction_of_id = l.id
         ), earlier as (
           select m.id, m.correction_of_id from machvon.measurement m where m.id in (select id from used)
           union
           select m.id, m.correction_of_id from machvon.measurement m join earlier e on m.id = e.correction_of_id
         )
         select m.id, m.contract_id, m.reference_no, m.revision, m.status, m.version::text as version, m.correction_of_id, m.quantity_period::text as quantity_period, ${ts('m.created_at')} as created_at
           from machvon.measurement m where (m.id in (select id from later) or m.id in (select id from earlier)) and m.contract_id = any($1::uuid[]) order by m.created_at, m.revision, m.id limit ${this.limits.nodes + 1}`,
        [contractIds],
      ),
    );
    const lines = await tx.query<{ acceptance_id: string; measurement_id: string }>(
      'select distinct l.acceptance_id, l.measurement_id from machvon.acceptance_line l join machvon.acceptance a on a.tenant_id = l.tenant_id and a.id = l.acceptance_id where a.contract_id = any($1::uuid[])',
      [contractIds],
    );
    const payments = await this.limited(
      truncated,
      'payment_request',
      tx.query<PaymentRow>(
        `select id, contract_id, acceptance_id, settlement_revision_id, request_no, request_kind, status, version::text as version, gross_vnd::text as gross_vnd, net_vnd::text as net_vnd,
                treasury_paid_on::text as treasury_paid_on, ${ts('created_at')} as created_at
           from machvon.payment_request where contract_id = any($1::uuid[]) order by created_at, id limit ${this.limits.nodes + 1}`,
        [contractIds],
      ),
    );
    const transactions = await this.limited(
      truncated,
      'treasury_transaction',
      tx.query<TransactionRow>(
        `select id, contract_id, payment_request_id, document_no, direction, amount_vnd::text as amount_vnd, match_status, ${ts('confirmed_at')} as confirmed_at, ${ts('created_at')} as created_at
           from machvon.treasury_transaction where payment_request_id = any($1::uuid[]) order by confirmed_at, id limit ${this.limits.nodes + 1}`,
        [payments.map((row) => row.id)],
      ),
    );
    const settlements = await this.limited(
      truncated,
      'settlement_revision',
      tx.query<SettlementRow>(
        `select id, contract_id, settlement_scope, fiscal_year, revision, status, version::text as version, settled_amount_vnd::text as settled_amount_vnd, ${ts('created_at')} as created_at
           from machvon.settlement_revision where project_id = $1::uuid and (contract_id is null or contract_id = any($2::uuid[])) order by created_at, id limit ${this.limits.nodes + 1}`,
        [projectId, contractIds],
      ),
    );

    const nodes: ChainNode[] = [];
    const edges: ChainEdge[] = [];
    const ids = new Set<string>();
    const add = (node: ChainNode): void => {
      nodes.push(node);
      ids.add(node.id);
    };
    const link = (from: string, to: string, relation: ChainEdge['relation']): void => {
      if (ids.has(from) && ids.has(to)) edges.push({ from, to, relation });
    };

    add({ type: 'project', id: project.id, version: Number(project.version), revision: null, status: project.status, label: project.code, contractId: null, amountVnd: null, superseded: false, facts: { name: project.name, created_at: project.created_at } });
    for (const row of contracts) {
      add({ type: 'contract', id: row.id, version: Number(row.version), revision: row.revision, status: row.status, label: row.code, contractId: row.id, amountVnd: row.value_vnd, superseded: false, facts: { created_at: row.created_at } });
    }
    for (const row of measurements) {
      add({
        type: 'measurement',
        id: row.id,
        version: Number(row.version),
        revision: row.revision,
        status: row.status,
        label: row.reference_no ?? row.id,
        contractId: row.contract_id,
        amountVnd: null,
        superseded: row.status === 'SUPERSEDED',
        facts: { quantity_period: row.quantity_period, corrects: row.correction_of_id, created_at: row.created_at },
      });
    }
    for (const row of acceptances) {
      add({ type: 'acceptance', id: row.id, version: Number(row.version), revision: null, status: row.status, label: row.acceptance_no ?? row.id, contractId: row.contract_id, amountVnd: row.accepted_amount_vnd, superseded: false, facts: { created_at: row.created_at } });
    }
    for (const row of payments) {
      add({
        type: 'payment_request',
        id: row.id,
        version: Number(row.version),
        revision: null,
        status: row.status,
        label: row.request_no ?? row.id,
        contractId: row.contract_id,
        amountVnd: row.gross_vnd,
        superseded: false,
        facts: { request_kind: row.request_kind, net_vnd: row.net_vnd, treasury_paid_on: row.treasury_paid_on, created_at: row.created_at },
      });
    }
    for (const row of transactions) {
      add({
        type: 'treasury_transaction',
        id: row.id,
        version: null,
        revision: null,
        status: row.match_status,
        label: row.document_no ?? row.id,
        contractId: row.contract_id,
        amountVnd: row.amount_vnd,
        superseded: false,
        facts: { direction: row.direction, confirmed_at: row.confirmed_at, created_at: row.created_at },
      });
    }
    for (const row of settlements) {
      add({
        type: 'settlement_revision',
        id: row.id,
        version: Number(row.version),
        revision: row.revision,
        status: row.status,
        label: row.fiscal_year === null ? row.settlement_scope : `${row.settlement_scope} ${row.fiscal_year}`,
        contractId: row.contract_id,
        amountVnd: row.settled_amount_vnd,
        superseded: row.status === 'SUPERSEDED',
        facts: { settlement_scope: row.settlement_scope, fiscal_year: row.fiscal_year, created_at: row.created_at },
      });
    }

    for (const row of contracts) link(project.id, row.id, 'HAS_CONTRACT');
    for (const row of measurements) {
      link(row.contract_id, row.id, 'MEASURED_IN');
      if (row.correction_of_id !== null) link(row.id, row.correction_of_id, 'CORRECTS');
    }
    for (const row of lines) link(row.measurement_id, row.acceptance_id, 'ACCEPTED_AS');
    for (const row of payments) {
      link(row.acceptance_id ?? row.contract_id, row.id, 'CLAIMED_BY');
      if (row.settlement_revision_id !== null) link(row.id, row.settlement_revision_id, 'SETTLED_IN');
    }
    for (const row of transactions) link(row.payment_request_id, row.id, 'PAID_BY');
    for (const row of settlements) {
      if (!edges.some((edge) => edge.to === row.id)) link(row.contract_id ?? project.id, row.id, 'SETTLED_IN');
    }

    const counted = payments.filter((row) => COUNTED_STATUSES.includes(row.status));
    const sum = (rows: readonly PaymentRow[]): string => rows.reduce((total, row) => total + BigInt(row.gross_vnd), 0n).toString();
    return {
      projectId: project.id,
      contractId,
      nodes,
      edges,
      totals: { countedRequests: counted.length, countedGrossVnd: sum(counted), settledGrossVnd: sum(payments.filter((row) => row.status === 'SETTLED')) },
      truncated: CHAIN_NODE_TYPES.filter((type) => truncated.has(type)),
    };
  }

  /** The rows of a query that asked for one more than the limit: the extra one only tells that the chain was cut. */
  private async limited<Row>(truncated: Set<ChainNodeType>, type: ChainNodeType, query: Promise<Row[]>): Promise<Row[]> {
    const rows = await query;
    if (rows.length <= this.limits.nodes) return rows;
    truncated.add(type);
    return rows.slice(0, this.limits.nodes);
  }
}
