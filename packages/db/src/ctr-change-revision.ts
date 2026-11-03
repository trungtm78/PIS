import { randomUUID } from 'node:crypto';
import { DomainError, compareDecimal } from '@machvon/kernel';
import { CtrBoqStore } from './ctr-boq-store.ts';
import type { BoqImportResult } from './ctr-boq-store.ts';
import { reconciliationOf, totalMismatch } from './ctr-boq-lines.ts';
import type { ChangeRow } from './ctr-change-chain-store.ts';
import type { ContractScopes } from './ctr-contract-store.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;

/** The revision a change follows: the latest one in force or waiting for its day. */
export interface RevisionHead {
  id: string;
  revision: number;
  amount_vnd: string;
  valid_from: string;
  status: string;
}

export interface NewRevisionResult {
  id: string;
  revision: number;
  amountVnd: string;
  validFrom: string;
  status: 'PENDING_EFFECTIVE';
  supersedesId: string;
  version: number;
  boqLineCount: number;
  boqTotalVnd: string;
  /** The import that put the lines of the change order in, when the decision carried them. */
  boqImport: BoqImportResult | undefined;
}

export interface NewRevisionValues {
  head: RevisionHead;
  contractId: string;
  row: ChangeRow;
  value: string;
  validFrom: string;
  documentVersionId: string;
  actor: string;
  boqLines: unknown;
  scopes: ContractScopes;
  /** True for the revision a retroactive adjustment makes (ST-CTR-016): the flag of the revision says that its change order reaches back before its first day. */
  retroactive: boolean;
}

/** The ledger of a contract as the floor of its value is judged on. */
export interface ContractFigures {
  acceptedTotalVnd: string;
  advancePaidVnd: string;
  paidTotalVnd: string;
  advanceRecoveredVnd: string;
}

/**
 * What the decision of a change order and its retroactive adjustment share (ST-CTR-007, ST-CTR-016): the people whose work the decision approves, the revision a change follows and the
 * revision it makes, with the BOQ of that revision.
 */
export class CtrChangeRevisions {
  private readonly boq = new CtrBoqStore();

  /** The revision the change follows: the latest one in force or waiting for its day. A contract that is being performed always has one. */
  async head(tx: TenantTx, contractId: string): Promise<RevisionHead> {
    const rows = await tx.query<RevisionHead>(
      `select id, revision, amount_vnd::text as amount_vnd, valid_from::text as valid_from, status
         from machvon.contract_revision where contract_id = $1::uuid and status in ('PENDING_EFFECTIVE', 'EFFECTIVE') order by revision desc limit 1`,
      [contractId],
    );
    const head = rows[0];
    if (head === undefined) throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { reason: 'NO_REVISION_IN_FORCE' } });
    return head;
  }

  /** Whoever raised or promoted a request of the chain and whoever assessed the request: the people whose work the decision approves. */
  async makersOf(tx: TenantTx, row: ChangeRow): Promise<string[]> {
    const rows = await tx.query<{ submitted_by: string | null; evaluated_by: string | null }>(
      `with recursive chain as (
         select id, parent_id, submitted_by, evaluated_by from machvon.change_request where id = $1::uuid
         union all
         select r.id, r.parent_id, r.submitted_by, r.evaluated_by from machvon.change_request r join chain c on r.id = c.parent_id
       ) select submitted_by, evaluated_by from chain`,
      [row.id],
    );
    return rows.flatMap((each) => [each.submitted_by, each.evaluated_by].filter((who): who is string => who !== null));
  }

  async figuresOf(tx: TenantTx, contractId: string): Promise<ContractFigures> {
    const rows = await tx.query<{ accepted_total_vnd: string; advance_paid_vnd: string; paid_total_vnd: string; advance_recovered_vnd: string }>(
      'select accepted_total_vnd::text, advance_paid_vnd::text, paid_total_vnd::text, advance_recovered_vnd::text from machvon.contract where id = $1::uuid',
      [contractId],
    );
    const figures = rows[0];
    if (figures === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { acceptedTotalVnd: figures.accepted_total_vnd, advancePaidVnd: figures.advance_paid_vnd, paidTotalVnd: figures.paid_total_vnd, advanceRecoveredVnd: figures.advance_recovered_vnd };
  }

  /**
   * Writes the next revision of the contract for an approved change order: PENDING_EFFECTIVE, from the first day the change takes effect, with the value the change gives. Its BOQ is the
   * lines sent with the decision, or a copy of the BOQ of the revision it follows (which then has to fit the value); a pending revision can still be put right by an import before its day.
   */
  async make(tx: TenantTx, values: NewRevisionValues): Promise<NewRevisionResult> {
    const { head, contractId, row, actor } = values;
    const numbers = await tx.query<{ next: number }>('select coalesce(max(revision), 0) + 1 as next from machvon.contract_revision where contract_id = $1::uuid', [contractId]);
    const revision = numbers[0]?.next ?? head.revision + 1;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contract_revision
         (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, change_request_id, supersedes_id, retroactive, decided_by, decided_at, version, created_by, updated_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4::numeric, $5::uuid, $6::date, 'PENDING_EFFECTIVE', 'CHANGE_ORDER', $7::uuid, $8::uuid, $10, $9::uuid, now(), 1, $9::uuid, $9::uuid)`,
      [id, contractId, revision, values.value, values.documentVersionId, values.validFrom, row.id, head.id, actor, values.retroactive],
    );
    let boqImport: BoqImportResult | undefined;
    if (values.boqLines === undefined) await this.copyLines(tx, head.id, id, actor);
    else boqImport = await this.boq.importLines(tx, id, 1, { mode: 'REPLACE', lines: values.boqLines }, actor, values.scopes);
    const totals = await tx.query<{ total: string; n: number }>('select coalesce(sum(amount_vnd), 0)::text as total, count(*)::int as n from machvon.boq_line where contract_revision_id = $1::uuid', [id]);
    // The lines never add up to more than the value of their revision: a change that takes from the contract has to say which lines shrink.
    if (compareDecimal(totals[0]?.total ?? '0', values.value) > 0) throw totalMismatch(reconciliationOf(values.value, totals[0]?.total ?? '0', totals[0]?.n ?? 0));
    return {
      id,
      revision,
      amountVnd: values.value,
      validFrom: values.validFrom,
      status: 'PENDING_EFFECTIVE',
      supersedesId: head.id,
      version: boqImport?.version ?? 1,
      boqLineCount: totals[0]?.n ?? 0,
      boqTotalVnd: totals[0]?.total ?? '0',
      boqImport,
    };
  }

  private async copyLines(tx: TenantTx, fromRevisionId: string, toRevisionId: string, actor: string): Promise<void> {
    await tx.query(
      `insert into machvon.boq_line
         (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd,
          retention_pct, milestone_code, milestone_due_on, party_id, created_by)
       select tenant_id, gen_random_uuid(), $2::uuid, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd,
              retention_pct, milestone_code, milestone_due_on, party_id, $3::uuid
         from machvon.boq_line where contract_revision_id = $1::uuid`,
      [fromRevisionId, toRevisionId, actor],
    );
  }
}

/** The size of a signed amount without its sign: the delegation limit judges how much is changed, not which way. */
export function absoluteVnd(amount: string): string {
  return amount.startsWith('-') ? amount.slice(1) : amount;
}
