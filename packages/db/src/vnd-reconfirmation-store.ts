import { createHash, randomUUID } from 'node:crypto';
import { DomainError, nextReconfirmationDue, reconfirmationAlertFacet, reconfirmationState, vietnamDateOf } from '@machvon/kernel';
import type { ReconfirmationPolicy, ReconfirmationState } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { VendorPortalPolicyReader } from './vnd3-portal-policy.ts';
import type { PortalCaller } from './vnd-portal-store.ts';
import { VendorPortalStore } from './vnd-portal-store.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface ReconfirmationView {
  state: ReconfirmationState;
  dueOn: string | null;
  lastConfirmedAt: string | null;
  declarationVersion: string;
  declarationText: string;
  intervalMonths: number;
  policyVersion: string;
}

export interface ReconfirmationLine {
  contractorId: string;
  contractorName: string;
  taxIdentifier: string;
  state: ReconfirmationState;
  dueOn: string | null;
  lastConfirmedAt: string | null;
  declarationVersion: string | null;
}

export interface ReconfirmationDone {
  id: string;
  contractorId: string;
  confirmedOn: string;
  nextDueOn: string;
  declarationVersion: string;
}

/**
 * The yearly re-confirmation of the profile by the contractor (VND-3, V15; docs/vendor-investigation.md section 5). The day it falls due is the `next_review_due` of the contractor (the review day of VND-1); the state on a day
 * is the kernel `reconfirmationState` with the rule `VENDOR_RECONFIRMATION`. The contractor confirms on the portal and signs the declaration of integrity: the version it saw must be the one in force (409
 * `RECONFIRMATION_DECLARATION_STALE` otherwise, so nobody signs a text that was replaced under them). A confirmation is a row for good: the day it satisfied, the next day it falls due, the hash of the declaration text and
 * the hash of the profile as it was shown. A lapse is shown to staff and raises an alert, it never blocks a transaction.
 */
export class VendorReconfirmationStore {
  private readonly policies: VendorPortalPolicyReader;
  private readonly portal = new VendorPortalStore();

  constructor(policies: VendorPortalPolicyReader = new VendorPortalPolicyReader()) {
    this.policies = policies;
  }

  /** What the contractor sees: where its confirmation stands and the declaration text it would sign. */
  async current(tx: TenantTx, caller: PortalCaller, today: string): Promise<ReconfirmationView> {
    const rule = await this.policies.reconfirmation(tx, today);
    const [row] = await tx.query<{ due: string | null; last: string | null }>(
      `select c.next_review_due::text as due, (select ${timestampKey('max(r.confirmed_at)')} from machvon.contractor_reconfirmation r where r.contractor_id = c.id) as last from machvon.contractor c where c.id = $1::uuid`,
      [caller.contractorId],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return {
      state: reconfirmationState(row.due, today, rule.value),
      dueOn: row.due,
      lastConfirmedAt: row.last,
      declarationVersion: rule.value.declaration_version,
      declarationText: rule.value.declaration_text,
      intervalMonths: rule.value.interval_months,
      policyVersion: rule.version,
    };
  }

  /** The contractor confirms its profile and signs the declaration. */
  async confirm(tx: TenantTx, caller: PortalCaller, input: { declarationVersion: string; accepted: boolean; changesNote?: string | undefined }, now: Date): Promise<ReconfirmationDone> {
    const today = vietnamDateOf(now);
    if (!input.accepted) throw new DomainError('VALIDATION_FAILED', 422, 'accepted');
    const rule = await this.policies.reconfirmation(tx, today);
    if (input.declarationVersion !== rule.value.declaration_version) throw new DomainError('RECONFIRMATION_DECLARATION_STALE', 409, 'declaration_version');
    const note = input.changesNote === undefined ? null : input.changesNote.trim();
    if (note !== null && (note.length < 1 || note.length > 2000)) throw new DomainError('VALIDATION_FAILED', 422, 'changes_note');
    const profile = await this.portal.profile(tx, caller);
    const [current] = await tx.query<{ due: string | null }>('select next_review_due::text as due from machvon.contractor where id = $1::uuid for update', [caller.contractorId]);
    const nextDueOn = nextReconfirmationDue(today, rule.value);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contractor_reconfirmation (tenant_id, id, contractor_id, confirmed_by, confirmed_at, confirmed_on, satisfied_due_on, next_due_on, declaration_version, declaration_sha256, profile_sha256, changes_note)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::date, $6::date, $7::date, $8, $9, $10, $11)`,
      [id, caller.contractorId, caller.membershipId, now.toISOString(), today, current?.due ?? null, nextDueOn, rule.value.declaration_version, sha256(rule.value.declaration_text), sha256(JSON.stringify(profile)), note],
    );
    await tx.query('update machvon.contractor set profile_reviewed_at = $2::timestamptz, next_review_due = $3::date, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid', [caller.contractorId, now.toISOString(), nextDueOn, caller.membershipId]);
    return { id, contractorId: caller.contractorId, confirmedOn: today, nextDueOn, declarationVersion: rule.value.declaration_version };
  }

  /** The verified contractors with the state of their confirmation (a contractor that was not verified has no profile to confirm yet). */
  async list(tx: TenantTx, filter: { state?: ReconfirmationState | undefined; limit?: number | undefined }, today: string): Promise<{ items: ReconfirmationLine[]; counts: Record<'current' | 'dueSoon' | 'overdue' | 'lapsed' | 'never', number>; currentPct: number | null; policy: Awaited<ReturnType<VendorPortalPolicyReader['reconfirmation']>> }> {
    const policy = await this.policies.reconfirmation(tx, today);
    const rows = await tx.query<{ id: string; legal_name: string; tax_identifier: string; due: string | null; last: string | null; version: string | null }>(
      `select c.id, c.legal_name, c.tax_identifier, c.next_review_due::text as due,
              (select ${timestampKey('r.confirmed_at')} from machvon.contractor_reconfirmation r where r.contractor_id = c.id order by r.confirmed_at desc limit 1) as last,
              (select r.declaration_version from machvon.contractor_reconfirmation r where r.contractor_id = c.id order by r.confirmed_at desc limit 1) as version
         from machvon.contractor c where c.verification_status = 'VERIFIED' order by c.next_review_due nulls first, c.legal_name, c.id limit 2000`,
    );
    const all = rows.map((row): ReconfirmationLine => ({ contractorId: row.id, contractorName: row.legal_name, taxIdentifier: row.tax_identifier, state: reconfirmationState(row.due, today, policy.value), dueOn: row.due, lastConfirmedAt: row.last, declarationVersion: row.version }));
    const count = (state: ReconfirmationState): number => all.filter((line) => line.state === state).length;
    const counts = { current: count('CURRENT'), dueSoon: count('DUE_SOON'), overdue: count('OVERDUE'), lapsed: count('LAPSED'), never: count('NEVER') };
    const good = counts.current + counts.dueSoon;
    return {
      items: all.filter((line) => filter.state === undefined || line.state === filter.state).slice(0, filter.limit ?? 500),
      counts,
      currentPct: all.length === 0 ? null : Math.round((good * 1000) / all.length) / 10,
      policy,
    };
  }

  /** The contractors whose confirmation is due or past: the rows of the alert. */
  async alertable(tx: TenantTx, today: string, policy: Pick<ReconfirmationPolicy, 'remind_days' | 'grace_days'>): Promise<Array<ReconfirmationLine & { facet: 'DUE_SOON' | 'OVERDUE' }>> {
    const { items } = await this.list(tx, {}, today);
    const out: Array<ReconfirmationLine & { facet: 'DUE_SOON' | 'OVERDUE' }> = [];
    for (const line of items) {
      const facet = reconfirmationAlertFacet(reconfirmationState(line.dueOn, today, policy));
      if (facet !== null) out.push({ ...line, facet });
    }
    return out;
  }
}
