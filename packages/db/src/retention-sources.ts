import type { RetentionBasis } from '@machvon/kernel';

/** The Vietnam day of a timestamp column, as the retention periods of the law are counted in days of the country. */
const VIETNAM_DAY = (column: string): string => `(${column} at time zone 'Asia/Ho_Chi_Minh')::date`;

/**
 * Where the retention job finds the records of a business class. `resourceType` is what the legal hold check asks about; `candidates`
 * is a query of `(id uuid, basis_date date)` for a basis, or undefined when the class has no such basis. A class with a policy but no
 * source here is reported by the job as having none (the module that owns the records adds its source when its tables exist).
 */
export interface BusinessSource {
  resourceType: string;
  candidates(basis: Exclude<RetentionBasis, 'PERMANENT'>): string | undefined;
  /** Whether a hold contains the record; the default asks the legal hold service about (resourceType, id). */
  heldSql?: string;
}

/**
 * The project dossier is the project and what hangs from it. Created: the day the project was registered. Closed: the day it reached the
 * CLOSED status. Contract end: the last day of the last contract revision of the project's contracts.
 */
const PROJECT_DOSSIER: BusinessSource = {
  resourceType: 'project',
  candidates: (basis) => {
    switch (basis) {
      case 'FROM_CREATED':
        return `select p.id, ${VIETNAM_DAY('p.created_at')} as basis_date from machvon.project p`;
      case 'FROM_CLOSED':
        return `select p.id, ${VIETNAM_DAY('p.status_changed_at')} as basis_date from machvon.project p where p.status = 'CLOSED' and p.status_changed_at is not null`;
      case 'FROM_CONTRACT_END':
        return `select c.project_id as id, max(r.valid_until) as basis_date
                  from machvon.contract c join machvon.contract_revision r on r.contract_id = c.id
                 where r.valid_until is not null group by c.project_id`;
    }
  },
};

/**
 * The audit trail is listed by seal window, not row by row: a window is one thousand rows at most and is the unit that can be taken
 * out of the chain whole. A window is held as soon as one row in it is (a hold on a project holds the audit rows about it).
 */
const AUDIT_EVENT: BusinessSource = {
  resourceType: 'audit_seal',
  candidates: (basis) => (basis === 'FROM_CREATED' ? `select s.id, ${VIETNAM_DAY('s.sealed_at')} as basis_date from machvon.audit_seal s` : undefined),
  heldSql: `select exists (
      select 1 from machvon.audit_event e, machvon.audit_seal s
       where s.id = $1::uuid and e.seq between s.from_seq and s.to_seq and machvon.legal_hold_blocks(e.resource_type, e.resource_id)
    ) or machvon.legal_hold_blocks('audit_seal', $1::uuid) as held`,
};

/** The business classes that have records today. */
export const BUSINESS_SOURCES: Readonly<Record<string, BusinessSource>> = {
  project_dossier: PROJECT_DOSSIER,
  audit_event: AUDIT_EVENT,
};
