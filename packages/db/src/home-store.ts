import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The early warnings that still ask something of someone. */
export const HOME_OPEN_WARNING_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED'] as const;

export interface HomeCounts {
  openWarnings: number;
  /** Explanations that were asked for and not given by their day: marked overdue, or still requested or sent back with the day past. */
  overdueExplanations: number;
  /** Proposals to move capital from slow projects to fast ones that wait for a decision (CAP-19). */
  pendingReallocations: number;
}

export interface HomeCountInput {
  /** The projects the reader may read (aliases `p`, `ou`, `iu` of the register queries). */
  projectScope: ScopeBuilder;
  /** The units the reader may read (alias `u`). */
  unitScope: ScopeBuilder;
  /** Narrows to the units under this one. */
  unitId: string | undefined;
  now: Date;
}

const countOf = (rows: ReadonlyArray<{ n: string }>): number => Number(rows[0]?.n ?? 0);

/**
 * What the command center counts beside the rates (ST-HOME-001): the open warnings, the overdue explanations and the proposals of reallocation that wait, each in the scope of the reader and under the unit they
 * narrowed to. HOME owns no table: these are reads of the tables of DIS, PRJ and CAP, and the counts are not stored.
 */
export class HomeStore {
  async counts(tx: TenantTx, input: HomeCountInput): Promise<HomeCounts> {
    return {
      openWarnings: await this.openWarnings(tx, input),
      overdueExplanations: await this.overdueExplanations(tx, input),
      pendingReallocations: await this.pendingReallocations(tx, input),
    };
  }

  /** Whether the reader may read this unit (a unit that does not exist, or lies in another tenant, is not readable either, so the answer discloses nothing). */
  async unitReadable(tx: TenantTx, unitScope: ScopeBuilder, unitId: string): Promise<boolean> {
    const visible = unitScope(2);
    const rows = await tx.query<{ n: string }>(`select count(*)::text as n from machvon.organization_unit u where u.id = $1::uuid and ${visible.sql}`, [unitId, ...visible.params]);
    return countOf(rows) > 0;
  }

  /** Warnings of projects (by the project scope) and of units (by the unit scope). */
  private async openWarnings(tx: TenantTx, input: HomeCountInput): Promise<number> {
    const projects = input.projectScope(3);
    const projectRows = await tx.query<{ n: string }>(
      `select count(*)::text as n from machvon.early_warning w join ${SCOPE_FROM} on p.tenant_id = w.tenant_id and p.id = w.project_id
        where w.status = any($1::text[]) and ($2::uuid is null or exists (select 1 from machvon.organization_unit su where su.id = $2::uuid and starts_with(ou.path, su.path))) and ${projects.sql}`,
      [HOME_OPEN_WARNING_STATUSES, input.unitId ?? null, ...projects.params],
    );
    const units = input.unitScope(3);
    const unitRows = await tx.query<{ n: string }>(
      `select count(*)::text as n from machvon.early_warning w join machvon.organization_unit u on u.tenant_id = w.tenant_id and u.id = w.unit_id
        where w.project_id is null and w.status = any($1::text[]) and ($2::uuid is null or exists (select 1 from machvon.organization_unit su where su.id = $2::uuid and starts_with(u.path, su.path))) and ${units.sql}`,
      [HOME_OPEN_WARNING_STATUSES, input.unitId ?? null, ...units.params],
    );
    return countOf(projectRows) + countOf(unitRows);
  }

  private async overdueExplanations(tx: TenantTx, input: HomeCountInput): Promise<number> {
    const overdue = `(e.status = 'OVERDUE' or (e.status in ('REQUESTED', 'RETURNED') and e.due_at < $1::timestamptz))`;
    const projects = input.projectScope(3);
    const projectRows = await tx.query<{ n: string }>(
      `select count(*)::text as n from machvon.explanation_request e join ${SCOPE_FROM} on p.tenant_id = e.tenant_id and p.id = e.project_id
        where ${overdue} and ($2::uuid is null or exists (select 1 from machvon.organization_unit su where su.id = $2::uuid and starts_with(ou.path, su.path))) and ${projects.sql}`,
      [input.now.toISOString(), input.unitId ?? null, ...projects.params],
    );
    const units = input.unitScope(3);
    const unitRows = await tx.query<{ n: string }>(
      `select count(*)::text as n from machvon.explanation_request e join machvon.organization_unit u on u.tenant_id = e.tenant_id and u.id = e.unit_id
        where e.project_id is null and ${overdue} and ($2::uuid is null or exists (select 1 from machvon.organization_unit su where su.id = $2::uuid and starts_with(u.path, su.path))) and ${units.sql}`,
      [input.now.toISOString(), input.unitId ?? null, ...units.params],
    );
    return countOf(projectRows) + countOf(unitRows);
  }

  private async pendingReallocations(tx: TenantTx, input: HomeCountInput): Promise<number> {
    const units = input.unitScope(2);
    const rows = await tx.query<{ n: string }>(
      `select count(*)::text as n from machvon.reallocation_proposal r join machvon.organization_unit u on u.tenant_id = r.tenant_id and u.id = r.scope_unit_id
        where r.status = 'SUBMITTED' and ($1::uuid is null or exists (select 1 from machvon.organization_unit su where su.id = $1::uuid and starts_with(u.path, su.path))) and ${units.sql}`,
      [input.unitId ?? null, ...units.params],
    );
    return countOf(rows);
  }
}
