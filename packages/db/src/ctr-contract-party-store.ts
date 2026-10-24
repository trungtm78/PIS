import { randomUUID } from 'node:crypto';
import { DomainError, addDecimal, compareDecimal, versionConflict } from '@machvon/kernel';
import { CtrContractStore, calendarDate, partiesCheck, wholeAmount } from './ctr-contract-store.ts';
import type { ContractScopes, PartiesCheck, PartyRow } from './ctr-contract-store.ts';
import type { TenantTx } from './tenant-database.ts';

const MAX_PARTIES = 20;
const MIN_PARTIES = 2;
const SHARE = /^(?:100(?:\.0{1,4})?|[1-9]?\d(?:\.\d{1,4})?)$/;
const ROLES: readonly string[] = ['LEAD', 'MEMBER'];
const KEYS: readonly string[] = ['contractor_id', 'role', 'share_pct', 'work_value_vnd', 'valid_from', 'valid_until'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_SHARE = '100';

/** One member of a joint venture as the request gives it: the shares are decimal strings, so no figure passes through a float. */
export interface PartyInput {
  contractorId: string;
  role: 'LEAD' | 'MEMBER';
  sharePct: string;
  workValueVnd: string;
  validFrom?: string | undefined;
  validUntil?: string | undefined;
}

export interface PartiesReplaced {
  version: number;
  status: 'DRAFT';
  parties: PartyRow[];
  check: PartiesCheck;
  /** False when the members were already as asked: nothing was written and the version is the one it was. */
  changed: boolean;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The share as the four digits after the point it is stored with. */
function normalizedShare(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(4, '0')}`;
}

/**
 * Reads the members out of the body of the command. The contract leaves the items open, so the allowlist is enforced here: a field that
 * is not one of the six is a fault of the request (FIELD_NOT_ALLOWED), as on every other command, and a value of the wrong shape names its place.
 */
export function readParties(raw: readonly unknown[]): PartyInput[] {
  if (raw.length < MIN_PARTIES || raw.length > MAX_PARTIES) throw invalid('parties');
  return raw.map((item, index) => {
    const at = (key: string): string => `parties.${index}.${key}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw invalid(`parties.${index}`);
    const record = item as Record<string, unknown>;
    const extra = Object.keys(record).find((key) => !KEYS.includes(key));
    if (extra !== undefined) throw new DomainError('FIELD_NOT_ALLOWED', 400, at(extra));
    const text = (key: string, required: boolean): string | undefined => {
      const value = record[key];
      if (value === undefined && !required) return undefined;
      if (typeof value !== 'string') throw invalid(at(key));
      return value;
    };
    const contractorId = text('contractor_id', true) as string;
    const role = text('role', true) as string;
    const sharePct = text('share_pct', true) as string;
    const validFrom = text('valid_from', false);
    const validUntil = text('valid_until', false);
    if (!UUID.test(contractorId)) throw invalid(at('contractor_id'));
    if (!ROLES.includes(role)) throw invalid(at('role'));
    if (!SHARE.test(sharePct) || compareDecimal(sharePct, '0') === 0) throw invalid(at('share_pct'));
    const workValueVnd = wholeAmount(text('work_value_vnd', true) as string, at('work_value_vnd'));
    return {
      contractorId: contractorId.toLowerCase(),
      role: role as PartyInput['role'],
      sharePct: normalizedShare(sharePct),
      workValueVnd,
      validFrom: validFrom === undefined ? undefined : calendarDate(validFrom, at('valid_from')),
      validUntil: validUntil === undefined ? undefined : calendarDate(validUntil, at('valid_until')),
    };
  });
}

/**
 * The members of a joint venture (ST-CTR-001, CTR 3.1 step 2, BR-CTR-08): all of them are replaced together while the contract is a draft.
 * The shares add up to exactly 100 percent and the work they take to the value of the contract, one member leads and is the contractor the
 * contract was awarded to, and every member is a verified contractor free of restrictions. A member that leaves is withdrawn, not deleted,
 * so what refers to it stays whole. At commit the database judges the same sums once more (the deferred trigger of the members).
 */
export class CtrContractPartyStore {
  private readonly contracts: CtrContractStore;

  constructor(contracts: CtrContractStore = new CtrContractStore()) {
    this.contracts = contracts;
  }

  async replace(tx: TenantTx, contractId: string, expectedVersion: number, parties: readonly PartyInput[], actor: string, scopes: ContractScopes, today: string): Promise<PartiesReplaced> {
    const locked = await this.contracts.lock(tx, contractId, scopes);
    if (locked.version !== expectedVersion) throw versionConflict(locked.version);
    if (locked.status !== 'DRAFT') throw new DomainError('CONTRACT_STATE_INVALID', 409);
    // Members belong to a joint venture: a contract of one contractor has no one else to share it with.
    if (!locked.isJointVenture) throw invalid('parties');
    this.assertShape(parties, locked.contractorId);
    // A member that takes no start begins on the day of the replacement; its validity cannot end before it begins.
    for (const [index, party] of parties.entries()) if (party.validUntil !== undefined && party.validUntil < (party.validFrom ?? today)) throw invalid(`parties.${index}.valid_until`);
    for (const [index, party] of parties.entries()) await this.contracts.assertContractorMayContract(tx, party.contractorId, today, `parties.${index}.contractor_id`);
    const share = parties.reduce((total, party) => addDecimal(total, party.sharePct), '0');
    if (compareDecimal(share, FULL_SHARE) !== 0) throw new DomainError('JV_SHARE_NOT_100', 422, 'parties', { extensions: { share_total: share } });
    const work = parties.reduce((total, party) => addDecimal(total, party.workValueVnd), '0');
    if (compareDecimal(work, locked.contractValueVnd) !== 0) {
      throw new DomainError('BOQ_TOTAL_MISMATCH', 422, 'parties', { extensions: { work_value_total_vnd: work, contract_value_vnd: locked.contractValueVnd } });
    }
    const before = await this.contracts.partiesOf(tx, contractId);
    if (this.same(before, parties)) {
      return { version: locked.version, status: 'DRAFT', parties: before, check: partiesCheck(before, locked.contractValueVnd), changed: false };
    }
    // Everyone is withdrawn first and the new set is written over them, so the one-lead index never sees two leads and a returning member keeps its row.
    await tx.query(`update machvon.contract_party set status = 'WITHDRAWN', updated_at = now(), updated_by = $2::uuid, version = version + 1 where contract_id = $1::uuid and status = 'ACTIVE'`, [contractId, actor]);
    for (const party of parties) {
      await tx.query(
        `insert into machvon.contract_party
           (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, valid_until, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::numeric, 'ACTIVE', coalesce($7::date, $10::date), $8::date, $9::uuid, $9::uuid)
         on conflict (tenant_id, contract_id, contractor_id) do update
           set role = excluded.role, share_pct = excluded.share_pct, work_value_vnd = excluded.work_value_vnd, status = 'ACTIVE',
               valid_from = coalesce($7::date, machvon.contract_party.valid_from), valid_until = excluded.valid_until, updated_at = now(), updated_by = excluded.updated_by,
               version = machvon.contract_party.version + 1`,
        [randomUUID(), contractId, party.contractorId, party.role, party.sharePct, party.workValueVnd, party.validFrom ?? null, party.validUntil ?? null, actor, today],
      );
    }
    await this.contracts.touch(tx, contractId, actor);
    const after = await this.contracts.partiesOf(tx, contractId);
    return { version: locked.version + 1, status: 'DRAFT', parties: after, check: partiesCheck(after, locked.contractValueVnd), changed: true };
  }

  private assertShape(parties: readonly PartyInput[], leadContractorId: string): void {
    const leads = parties.filter((party) => party.role === 'LEAD');
    if (leads.length !== 1) throw invalid('parties');
    const duplicate = parties.findIndex((party, index) => parties.findIndex((other) => other.contractorId === party.contractorId) !== index);
    if (duplicate >= 0) throw invalid(`parties.${duplicate}.contractor_id`);
    // The contract was awarded to the lead of the venture: the contractor on the contract is the one that leads.
    if (leads[0]?.contractorId !== leadContractorId) throw invalid('parties');
  }

  private same(current: readonly PartyRow[], asked: readonly PartyInput[]): boolean {
    if (current.length !== asked.length) return false;
    return asked.every((party) => {
      const held = current.find((row) => row.contractorId === party.contractorId);
      return (
        held !== undefined &&
        held.role === party.role &&
        held.sharePct === party.sharePct &&
        held.workValueVnd === party.workValueVnd &&
        (party.validFrom === undefined || held.validFrom === party.validFrom) &&
        held.validUntil === (party.validUntil ?? null)
      );
    });
  }
}
