import { plainDecimal } from './ctr-boq-lines.ts';
import type { TenantTx } from './tenant-database.ts';

/** The revision that prices the work on a day. */
export interface PricingRevision {
  id: string;
  revision: number;
  kind: string;
  validFrom: string;
  /** The first day of the revision that took over (exclusive end); null for the revision in force. */
  validUntil: string | null;
}

/** The price of a BOQ item on a day, and the revision it was priced under. */
export interface DatedPrice {
  revision: PricingRevision;
  boqItemId: string;
  businessKey: string;
  unitCode: string;
  unitPrice: string;
  roundingRule: string;
}

interface RevisionSql {
  id: string;
  revision: number;
  kind: string;
  valid_from: string;
  valid_until: string | null;
}

const toRevision = (row: RevisionSql): PricingRevision => ({ id: row.id, revision: row.revision, kind: row.kind, validFrom: row.valid_from, validUntil: row.valid_until });

/**
 * Which revision of a contract prices the work on a day (BR-CTR-03, ST-CTR-007): the one in force that day, or the one that was, never one that is still pending; a revision is in force
 * from its first day up to, and not including, the first day of the next one. The acceptance of a quantity takes its price from here, so a change order that has not taken effect changes
 * no price, and one that has does not reach back to what was accepted before it (that goes through the adjustment of its own).
 */
export class CtrRevisionStore {
  async pricingRevisionAt(tx: TenantTx, contractId: string, day: string): Promise<PricingRevision | undefined> {
    const rows = await tx.query<RevisionSql>(
      `select id, revision, kind, valid_from::text as valid_from, valid_until::text as valid_until
         from machvon.contract_revision
        where contract_id = $1::uuid and status in ('EFFECTIVE', 'SUPERSEDED') and valid_from <= $2::date and (valid_until is null or $2::date < valid_until)
        order by revision desc limit 1`,
      [contractId, day],
    );
    return rows[0] === undefined ? undefined : toRevision(rows[0]);
  }

  /** The unit price of the item (by its business key) in the revision that prices the work on the day; undefined when no revision prices that day or the revision does not price the item. */
  async unitPriceAt(tx: TenantTx, contractId: string, businessKey: string, day: string): Promise<DatedPrice | undefined> {
    const revision = await this.pricingRevisionAt(tx, contractId, day);
    if (revision === undefined) return undefined;
    const rows = await tx.query<{ boq_item_id: string; business_key: string; unit_code: string; unit_price: string; rounding_rule: string }>(
      'select boq_item_id, business_key, unit_code, unit_price::text as unit_price, rounding_rule from machvon.boq_line where contract_revision_id = $1::uuid and business_key = $2',
      [revision.id, businessKey],
    );
    const line = rows[0];
    return line === undefined ? undefined : { revision, boqItemId: line.boq_item_id, businessKey: line.business_key, unitCode: line.unit_code, unitPrice: plainDecimal(line.unit_price), roundingRule: line.rounding_rule };
  }
}

