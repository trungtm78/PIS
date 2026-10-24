import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/** A record of a business class whose period has run out and that waits for a person to decide (ST-ADM-017). */
export interface ReviewItemRow {
  id: string;
  recordClass: string;
  resourceType: string;
  resourceId: string;
  policyId: string;
  basisDate: string;
  dueOn: string;
  endAction: 'REVIEW_FOR_DESTRUCTION' | 'ARCHIVE_TRANSFER';
  status: 'PENDING_REVIEW';
  listedAt: string;
}

interface Row {
  id: string;
  record_class: string;
  resource_type: string;
  resource_id: string;
  policy_id: string;
  basis_date: string;
  due_on: string;
  end_action: ReviewItemRow['endAction'];
  status: 'PENDING_REVIEW';
  listed_at: string;
}

const COLUMNS = `id, record_class, resource_type, resource_id, policy_id, basis_date::text as basis_date, due_on::text as due_on, end_action, status,
  to_char(listed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as listed_at`;

const toRow = (row: Row): ReviewItemRow => ({
  id: row.id,
  recordClass: row.record_class,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  policyId: row.policy_id,
  basisDate: row.basis_date,
  dueOn: row.due_on,
  endAction: row.end_action,
  status: row.status,
  listedAt: row.listed_at,
});

/** The ordering key of the last row of a page: the day the item fell due, then its id. */
export interface ReviewPageAnchor {
  code: string;
  id: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The review list the nightly retention run fills (ST-ADM-017): read only here, a person's decision belongs to a later story. */
export class RetentionReviewStore {
  async find(tx: TenantTx, id: string): Promise<ReviewItemRow | undefined> {
    const rows = await tx.query<Row>(`select ${COLUMNS} from machvon.retention_review_item where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** Oldest due first, then by id. The caller asks for one more row than it shows. */
  async list(tx: TenantTx, request: { limit: number; after: ReviewPageAnchor | undefined }): Promise<ReviewItemRow[]> {
    if (request.after !== undefined && !DAY.test(request.after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from machvon.retention_review_item
        where ($1::date is null or (due_on, id) > ($1::date, $2::uuid))
        order by due_on, id limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }
}
