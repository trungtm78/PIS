import { DomainError, PERIOD_REPORT_RULE_TYPE, assertPeriodOpen, assertUnlock, periodReportDefaults, periodReportPolicyOf, versionConflict } from '@machvon/kernel';
import type { PeriodReportPolicy, SignatureProvider } from '@machvon/kernel';
import { ISO, readPolicy } from './gov12-policy.ts';
import type { PolicyReading } from './gov12-policy.ts';
import type { TenantTx } from './tenant-database.ts';

export interface IssueFacts {
  id: string;
  layoutCode: string;
  periodCode: string;
  revision: number;
  sha256: string;
  approvedBy: string;
  countsAsAccepted: boolean;
}

export interface LockRow {
  id: string;
  layoutCode: string;
  periodCode: string;
  issueId: string;
  digestSha256: string;
  lockedBy: string;
  lockedAt: string;
  unlockedBy: string | null;
  unlockedAt: string | null;
  unlockReason: string | null;
  version: number;
}

export interface SessionRow {
  id: string;
  issueId: string;
  provider: SignatureProvider;
  providerSessionId: string;
  certificateId: string;
  certificateFingerprint: string;
  digestSha256: string;
  state: 'OPEN' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
  startedBy: string;
  startedAt: string;
  expiresAt: string;
  version: number;
}

export interface SignatureRow {
  id: string;
  issueId: string;
  sessionId: string;
  digestSha256: string;
  provider: SignatureProvider;
  signerId: string;
  certificateFingerprint: string;
  cmsSha256: string;
  countsForDelivery: boolean;
  signedAt: string;
}

type Raw = Record<string, unknown>;

const LOCK_COLUMNS = `id, layout_code, period_code, issue_id, digest_sha256, locked_by, ${ISO('locked_at')} as locked_at, unlocked_by, ${ISO('unlocked_at')} as unlocked_at, unlock_reason, version`;
const toLock = (row: Raw): LockRow => ({
  id: row.id as string,
  layoutCode: row.layout_code as string,
  periodCode: row.period_code as string,
  issueId: row.issue_id as string,
  digestSha256: (row.digest_sha256 as string).trim(),
  lockedBy: row.locked_by as string,
  lockedAt: row.locked_at as string,
  unlockedBy: (row.unlocked_by as string | null) ?? null,
  unlockedAt: (row.unlocked_at as string | null) ?? null,
  unlockReason: (row.unlock_reason as string | null) ?? null,
  version: Number(row.version),
});

const SESSION_COLUMNS = `id, issue_id, provider, provider_session_ref, certificate_id, certificate_fingerprint, digest_sha256, state, started_by, ${ISO('started_at')} as started_at, ${ISO('expires_at')} as expires_at, version`;
const toSession = (row: Raw): SessionRow => ({
  id: row.id as string,
  issueId: row.issue_id as string,
  provider: row.provider as SignatureProvider,
  providerSessionId: row.provider_session_ref as string,
  certificateId: row.certificate_id as string,
  certificateFingerprint: (row.certificate_fingerprint as string).trim(),
  digestSha256: (row.digest_sha256 as string).trim(),
  state: row.state as SessionRow['state'],
  startedBy: row.started_by as string,
  startedAt: row.started_at as string,
  expiresAt: row.expires_at as string,
  version: Number(row.version),
});

const SIGNATURE_COLUMNS = `id, issue_id, session_id, digest_sha256, provider, signer_membership_id, certificate_fingerprint, cms_sha256, counts_for_delivery, ${ISO('signed_at')} as signed_at`;
const toSignature = (row: Raw): SignatureRow => ({
  id: row.id as string,
  issueId: row.issue_id as string,
  sessionId: row.session_id as string,
  digestSha256: (row.digest_sha256 as string).trim(),
  provider: row.provider as SignatureProvider,
  signerId: row.signer_membership_id as string,
  certificateFingerprint: (row.certificate_fingerprint as string).trim(),
  cmsSha256: (row.cms_sha256 as string).trim(),
  countsForDelivery: row.counts_for_delivery as boolean,
  signedAt: row.signed_at as string,
});

/**
 * The lock of a report period and the digital signature of an issued copy (G4-6). The report engine of RPT-1 makes the copies; this store keeps what the Ministry's rule adds: a copy is signed by its approver over its package
 * digest, the period is locked when the policy says so, the lock stops a new revision, and a second person with a reason releases it. Nothing is deleted.
 */
export class PeriodReportStore {
  policy(tx: TenantTx, today: string): Promise<PolicyReading<PeriodReportPolicy>> {
    return readPolicy(tx, PERIOD_REPORT_RULE_TYPE, today, periodReportPolicyOf, periodReportDefaults);
  }

  async issue(tx: TenantTx, id: string): Promise<IssueFacts | undefined> {
    const [row] = await tx.query<Raw>('select id, layout_code, period_code, revision, sha256, approved_by, counts_as_accepted from machvon.report_issue where id = $1::uuid', [id]);
    return row === undefined ? undefined : { id: row.id as string, layoutCode: row.layout_code as string, periodCode: row.period_code as string, revision: row.revision as number, sha256: (row.sha256 as string).trim(), approvedBy: row.approved_by as string, countsAsAccepted: row.counts_as_accepted as boolean };
  }

  /** The open lock of a series and period, or none. */
  async openLock(tx: TenantTx, layoutCode: string, periodCode: string): Promise<LockRow | undefined> {
    const [row] = await tx.query<Raw>(`select ${LOCK_COLUMNS} from machvon.report_period_lock where layout_code = $1 and period_code = $2 and unlocked_at is null`, [layoutCode, periodCode]);
    return row === undefined ? undefined : toLock(row);
  }

  /** Refuses with PERIOD_LOCKED when the period is locked: the engine calls this before it makes a new copy of a series. */
  async assertOpen(tx: TenantTx, layoutCode: string, periodCode: string): Promise<void> {
    const lock = await this.openLock(tx, layoutCode, periodCode);
    assertPeriodOpen(lock === undefined ? null : { lockedBy: lock.lockedBy, unlockedAt: null });
  }

  async locks(tx: TenantTx, filter: { layoutCode?: string | undefined; openOnly: boolean; limit: number; offset: number }): Promise<LockRow[]> {
    const rows = await tx.query<Raw>(
      `select ${LOCK_COLUMNS} from machvon.report_period_lock where ($1::text is null or layout_code = $1) and (not $2::boolean or unlocked_at is null) order by locked_at desc, id limit $3 offset $4`,
      [filter.layoutCode ?? null, filter.openOnly, filter.limit, filter.offset],
    );
    return rows.map(toLock);
  }

  async findLock(tx: TenantTx, id: string, lock = false): Promise<LockRow | undefined> {
    const [row] = await tx.query<Raw>(`select ${LOCK_COLUMNS} from machvon.report_period_lock where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return row === undefined ? undefined : toLock(row);
  }

  /** Locks the period of an issued copy. A second call for the same copy returns the lock it made; a copy whose period is locked by another copy is refused. */
  async lock(tx: TenantTx, copy: IssueFacts, actor: string): Promise<{ lock: LockRow; created: boolean }> {
    const open = await this.openLock(tx, copy.layoutCode, copy.periodCode);
    if (open !== undefined) {
      if (open.issueId === copy.id) return { lock: open, created: false };
      throw new DomainError('PERIOD_LOCKED', 409, 'period');
    }
    await tx.query(
      `insert into machvon.report_period_lock (tenant_id, layout_code, period_code, issue_id, digest_sha256, locked_by) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3::uuid, $4, $5::uuid)`,
      [copy.layoutCode, copy.periodCode, copy.id, copy.sha256, actor],
    );
    return { lock: (await this.openLock(tx, copy.layoutCode, copy.periodCode)) as LockRow, created: true };
  }

  async unlock(tx: TenantTx, id: string, expectedVersion: number, actor: string, reason: string, today: string): Promise<LockRow> {
    const lock = await this.findLock(tx, id, true);
    if (lock === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (lock.version !== expectedVersion) throw versionConflict(lock.version);
    const policy = (await this.policy(tx, today)).policy;
    assertUnlock({ lock: { lockedBy: lock.lockedBy, unlockedAt: lock.unlockedAt }, actorId: actor, reason }, policy);
    await tx.query('update machvon.report_period_lock set unlocked_by = $2::uuid, unlocked_at = now(), unlock_reason = $3, version = version + 1 where id = $1::uuid', [id, actor, reason.trim()]);
    return (await this.findLock(tx, id)) as LockRow;
  }

  async signatureOf(tx: TenantTx, issueId: string): Promise<SignatureRow | undefined> {
    const [row] = await tx.query<Raw>(`select ${SIGNATURE_COLUMNS} from machvon.report_issue_signature where issue_id = $1::uuid`, [issueId]);
    return row === undefined ? undefined : toSignature(row);
  }

  async signatures(tx: TenantTx, issueIds: readonly string[]): Promise<SignatureRow[]> {
    if (issueIds.length === 0) return [];
    const rows = await tx.query<Raw>(`select ${SIGNATURE_COLUMNS} from machvon.report_issue_signature where issue_id = any($1::uuid[])`, [issueIds]);
    return rows.map(toSignature);
  }

  async openSession(tx: TenantTx, issueId: string): Promise<SessionRow | undefined> {
    const [row] = await tx.query<Raw>(`select ${SESSION_COLUMNS} from machvon.report_signature_session where issue_id = $1::uuid and state = 'OPEN'`, [issueId]);
    return row === undefined ? undefined : toSession(row);
  }

  async findSession(tx: TenantTx, id: string, lock = false): Promise<SessionRow | undefined> {
    const [row] = await tx.query<Raw>(`select ${SESSION_COLUMNS} from machvon.report_signature_session where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return row === undefined ? undefined : toSession(row);
  }

  async createSession(tx: TenantTx, input: { issueId: string; provider: SignatureProvider; providerSessionId: string; certificateId: string; certificateFingerprint: string; digestSha256: string; startedBy: string; expiresAt: Date }): Promise<SessionRow> {
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.report_signature_session (tenant_id, issue_id, provider, provider_session_ref, certificate_id, certificate_fingerprint, digest_sha256, started_by, expires_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5, $6, $7::uuid, $8::timestamptz) returning id`,
      [input.issueId, input.provider, input.providerSessionId, input.certificateId, input.certificateFingerprint, input.digestSha256, input.startedBy, input.expiresAt.toISOString()],
    );
    return (await this.findSession(tx, (inserted[0] as { id: string }).id)) as SessionRow;
  }

  async closeSession(tx: TenantTx, id: string, state: 'COMPLETED' | 'CANCELLED' | 'EXPIRED'): Promise<void> {
    await tx.query(`update machvon.report_signature_session set state = $2, version = version + 1 where id = $1::uuid and state = 'OPEN'`, [id, state]);
  }

  /** Stores the signature that the provider returned. The database checks that the digest is the copy's own and that the signer is its approver. */
  async storeSignature(tx: TenantTx, input: { issueId: string; sessionId: string; digestSha256: string; provider: SignatureProvider; signerId: string; certificateFingerprint: string; cms: Uint8Array; cmsSha256: string }): Promise<SignatureRow> {
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.report_issue_signature (tenant_id, issue_id, session_id, digest_sha256, provider, signer_membership_id, certificate_fingerprint, cms, cms_sha256, counts_for_delivery)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8, $9) returning id`,
      [input.issueId, input.sessionId, input.digestSha256, input.provider, input.signerId, input.certificateFingerprint, Buffer.from(input.cms), input.cmsSha256, input.provider !== 'MOCK'],
    );
    const [row] = await tx.query<Raw>(`select ${SIGNATURE_COLUMNS} from machvon.report_issue_signature where id = $1::uuid`, [(inserted[0] as { id: string }).id]);
    return toSignature(row as Raw);
  }

  /** The bytes of a stored signature, for the download and the check. */
  async signatureBytes(tx: TenantTx, issueId: string): Promise<{ cms: Buffer; row: SignatureRow } | undefined> {
    const [row] = await tx.query<Raw & { cms: Buffer }>(`select ${SIGNATURE_COLUMNS}, cms from machvon.report_issue_signature where issue_id = $1::uuid`, [issueId]);
    return row === undefined ? undefined : { cms: row.cms, row: toSignature(row) };
  }
}
