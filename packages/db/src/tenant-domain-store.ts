import { DomainError, assertHostnameAllowed, certificateEndsAt, challengeAnswered, challengeEndsAt, challengeRecordName, dueForRecheck, isReserved, needsRenewal, newChallenge, reservedUntil } from '@machvon/kernel';
import type { DomainKind } from '@machvon/kernel';
import type { ApprovalEffects } from './approval-store.ts';
import type { TenantTx } from './tenant-database.ts';

export const DOMAIN_VERIFIED_EVENT = 'sas.domain.verified.v1';
export const DOMAIN_REVOKED_EVENT = 'sas.domain.revoked.v1';
/** The gauge of the domains that failed (the proof gone, the certificate not issued), for the alert that watches them. */
/** The SQLSTATE of a unique index that refuses a second row. */
const UNIQUE_VIOLATION = '23505';

export const DOMAIN_FAILED_GAUGE = 'tenant_domain_failed_total';

const RESOURCE_TYPE = 'tenant_domain';
export type DomainStatus = 'PendingVerification' | 'Verified' | 'Active' | 'Failed' | 'Revoked';
export type TlsStatus = 'Pending' | 'Issued' | 'Renewing' | 'Failed';

export interface DomainRow {
  id: string;
  tenantId: string;
  hostname: string;
  kind: DomainKind;
  status: DomainStatus;
  tlsStatus: TlsStatus;
  tlsExpiresAt: Date | null;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  challengeExpiresAt: Date | null;
  revokedAt: Date | null;
  failureCode: string | null;
  createdAt: Date;
  version: number;
}

interface DomainDbRow {
  id: string;
  tenant_id: string;
  hostname: string;
  kind: DomainKind;
  status: DomainStatus;
  tls_status: TlsStatus;
  tls_expires_at: Date | null;
  verified_at: Date | null;
  last_checked_at: Date | null;
  challenge_expires_at: Date | null;
  revoked_at: Date | null;
  failure_code: string | null;
  created_at: Date;
  version: string;
}

const COLUMNS = 'id, tenant_id, hostname, kind, status, tls_status, tls_expires_at, verified_at, last_checked_at, challenge_expires_at, revoked_at, failure_code, created_at, version::text as version';

function domainOf(row: DomainDbRow): DomainRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    hostname: row.hostname,
    kind: row.kind,
    status: row.status,
    tlsStatus: row.tls_status,
    tlsExpiresAt: row.tls_expires_at,
    verifiedAt: row.verified_at,
    lastCheckedAt: row.last_checked_at,
    challengeExpiresAt: row.challenge_expires_at,
    revokedAt: row.revoked_at,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    version: Number(row.version),
  };
}

/** What the platform asks the DNS: the TXT values published at a name. A lookup that fails throws; a name with nothing is an empty list. MOCK until a resolver is bound. */
export interface DomainProofPort {
  txtRecords(name: string): Promise<string[]>;
}

/** What the platform asks for a certificate: it is issued for the hostname or the call throws. MOCK until an ACME client is bound. */
export interface CertificatePort {
  ensureCertificate(hostname: string): Promise<void>;
}

export interface DomainPorts {
  proof: DomainProofPort;
  certificates: CertificatePort;
}

export interface DomainAdd {
  tenantId: string;
  hostname: string;
  kind: DomainKind;
  platformDomain: string;
}

export interface DomainPassResult {
  /** Verified domains that got their certificate and became Active. */
  activated: string[];
  /** Domains whose proof was found gone, or whose certificate could not be issued: they are Failed or keep their failed certificate. */
  failed: string[];
  /** Certificates that were renewed. */
  renewed: string[];
  /** Domains of the tenant that are Failed after the pass. */
  failing: number;
}

/**
 * The domains of a tenant (ST-SAS-017, SAS.md 3.4, BR-SAS-06), written by the control plane acting as the tenant. A hostname belongs to one tenant on the whole platform (409 DOMAIN_TAKEN), and a hostname that was released is
 * held for 90 days (DOMAIN_TAKEN with the reason RESERVED). A custom domain is proved by a TXT record whose value is a token the platform keeps only the hash of; once proved it is Verified and the lifecycle pass gives it a
 * certificate and makes it Active; the pass looks at the proof again every week and renews the certificate before it ends. A domain chooses the tenant at sign-in (`tenant_of_domain`) while it is Verified or Active, and gives no membership.
 */
export class TenantDomainStore {
  /** Adds a domain. The token of a custom domain is returned once; only its hash is kept. A domain of this tenant that Failed is given a new challenge instead of being refused. */
  async add(tx: TenantTx, effects: ApprovalEffects, input: DomainAdd, now: Date): Promise<{ domain: DomainRow; token: string | undefined }> {
    const hostname = assertHostnameAllowed(input.hostname, input.kind, input.platformDomain);
    const [holder] = await tx.query<{ tenant_id: string; status: DomainStatus; revoked_at: Date | null }>('select tenant_id, status, revoked_at from machvon.tenant_domain_holder($1)', [hostname]);
    if (holder !== undefined && holder.status !== 'Revoked') {
      // Its own custom domain that failed, or that still waits for its proof (the answer with the token was lost), gets another challenge; anything else that holds the name is a refusal that names nobody.
      if (holder.tenant_id === input.tenantId && (holder.status === 'Failed' || holder.status === 'PendingVerification') && input.kind === 'CUSTOM') return this.rechallenge(tx, effects, hostname, now);
      throw new DomainError('DOMAIN_TAKEN', 409, 'hostname');
    }
    if (holder?.revoked_at != null && isReserved(holder.revoked_at, now)) throw new DomainError('DOMAIN_TAKEN', 409, 'hostname', { extensions: { reason: 'RESERVED', reserved_until: reservedUntil(holder.revoked_at).toISOString() } });
    const challenge = input.kind === 'CUSTOM' ? newChallenge() : undefined;
    // The platform owns the DNS of its own subdomains: nothing to prove, the certificate is the next step.
    // Two claims on a free name can both pass the lookup above: the unique index lets one in, and the other is told what a sequential request is told.
    const [row] = await tx
      .query<DomainDbRow>(
      `insert into machvon.tenant_domain (tenant_id, id, hostname, kind, txt_token_hash, status, tls_status, verified_at, challenge_expires_at, created_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4, 'Pending', $5::timestamptz, $6::timestamptz, $7::timestamptz)
       returning ${COLUMNS}`,
      [hostname, input.kind, challenge?.hash ?? null, challenge === undefined ? 'Verified' : 'PendingVerification', challenge === undefined ? now.toISOString() : null, challenge === undefined ? null : challengeEndsAt(now).toISOString(), now.toISOString()],
      )
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('DOMAIN_TAKEN', 409, 'hostname');
        throw error;
      });
    const domain = domainOf(row as DomainDbRow);
    await effects.audit({ action: 'tenant.domain_added', resourceType: RESOURCE_TYPE, resourceId: domain.id, diff: { hostname, kind: input.kind, status: domain.status } });
    return { domain, token: challenge?.value };
  }

  private async rechallenge(tx: TenantTx, effects: ApprovalEffects, hostname: string, now: Date): Promise<{ domain: DomainRow; token: string }> {
    const challenge = newChallenge();
    const [row] = await tx.query<DomainDbRow>(
      `update machvon.tenant_domain set txt_token_hash = $2, challenge_expires_at = $3::timestamptz, status = 'PendingVerification', failure_code = null, version = version + 1
        where lower(hostname) = lower($1) and status in ('Failed', 'PendingVerification') and kind = 'CUSTOM' returning ${COLUMNS}`,
      [hostname, challenge.hash, challengeEndsAt(now).toISOString()],
    );
    // The domain changed between the lookup and this update (another request re-added it, or it was released): the name is no longer this request's to give a new challenge.
    if (row === undefined) throw new DomainError('DOMAIN_TAKEN', 409, 'hostname');
    const domain = domainOf(row);
    await effects.audit({ action: 'tenant.domain_added', resourceType: RESOURCE_TYPE, resourceId: domain.id, diff: { hostname, kind: domain.kind, status: domain.status, rechallenged: true } });
    return { domain, token: challenge.value };
  }

  /**
   * Asks the DNS for the proof. Found: the domain is Verified (and the event is told); not found, or the challenge is over: it stays as it is with the time of the check, and the answer is `verified: false`, which the
   * command turns into 422 DOMAIN_UNVERIFIED after what was written is committed. A domain that is Verified or Active already is answered as it is.
   */
  async verify(tx: TenantTx, effects: ApprovalEffects, domainId: string, expectedVersion: number | undefined, ports: Pick<DomainPorts, 'proof'>, now: Date): Promise<{ domain: DomainRow; verified: boolean }> {
    const [locked] = await tx.query<DomainDbRow & { txt_token_hash: string | null }>(`select ${COLUMNS}, txt_token_hash from machvon.tenant_domain where id = $1::uuid for update`, [domainId]);
    if (locked === undefined || locked.status === 'Revoked') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const current = domainOf(locked);
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: current.version } });
    if (current.status === 'Verified' || current.status === 'Active') {
      await effects.audit({ action: 'tenant.domain_verified', resourceType: RESOURCE_TYPE, resourceId: domainId, diff: { hostname: current.hostname, already: true } });
      return { domain: current, verified: true };
    }
    if (locked.txt_token_hash === null) throw new DomainError('DOMAIN_UNVERIFIED', 422);
    const over = current.challengeExpiresAt !== null && current.challengeExpiresAt.getTime() <= now.getTime();
    const found = over ? false : challengeAnswered(await ports.proof.txtRecords(challengeRecordName(current.hostname)).catch(() => []), locked.txt_token_hash);
    if (!found) {
      const [row] = await tx.query<DomainDbRow>(
        `update machvon.tenant_domain set last_checked_at = $2::timestamptz, failure_code = $3, status = case when $4::boolean then 'Failed' else status end, version = version + 1 where id = $1::uuid returning ${COLUMNS}`,
        [domainId, now.toISOString(), over ? 'CHALLENGE_EXPIRED' : 'TXT_NOT_FOUND', over],
      );
      await effects.audit({ action: 'tenant.domain_unverified', resourceType: RESOURCE_TYPE, resourceId: domainId, diff: { hostname: current.hostname, reason: over ? 'CHALLENGE_EXPIRED' : 'TXT_NOT_FOUND' } });
      return { domain: domainOf(row as DomainDbRow), verified: false };
    }
    const [row] = await tx.query<DomainDbRow>(
      `update machvon.tenant_domain set status = 'Verified', verified_at = $2::timestamptz, last_checked_at = $2::timestamptz, failure_code = null, version = version + 1 where id = $1::uuid returning ${COLUMNS}`,
      [domainId, now.toISOString()],
    );
    const domain = domainOf(row as DomainDbRow);
    await effects.audit({ action: 'tenant.domain_verified', resourceType: RESOURCE_TYPE, resourceId: domainId, diff: { hostname: domain.hostname } });
    await effects.emit({ aggregateType: RESOURCE_TYPE, aggregateId: domainId, aggregateVersion: domain.version, eventKey: `tenant_domain:${domainId}:verified:${domain.version}`, type: DOMAIN_VERIFIED_EVENT, schemaVersion: 1, payload: { domain_id: domainId, hostname: domain.hostname, kind: domain.kind } });
    return { domain, verified: true };
  }

  /** Releases a domain: it stops choosing the tenant at once, and the hostname is held for 90 days. */
  async remove(tx: TenantTx, effects: ApprovalEffects, domainId: string, reason: string, expectedVersion: number | undefined, now: Date): Promise<DomainRow> {
    const [locked] = await tx.query<DomainDbRow>(`select ${COLUMNS} from machvon.tenant_domain where id = $1::uuid for update`, [domainId]);
    if (locked === undefined || locked.status === 'Revoked') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (expectedVersion !== undefined && Number(locked.version) !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: Number(locked.version) } });
    const [row] = await tx.query<DomainDbRow>(`update machvon.tenant_domain set status = 'Revoked', revoked_at = $2::timestamptz, version = version + 1 where id = $1::uuid returning ${COLUMNS}`, [domainId, now.toISOString()]);
    const domain = domainOf(row as DomainDbRow);
    await effects.audit({ action: 'tenant.domain_removed', resourceType: RESOURCE_TYPE, resourceId: domainId, reason, diff: { hostname: domain.hostname, was: locked.status, reserved_until: reservedUntil(now).toISOString() } });
    await effects.emit({ aggregateType: RESOURCE_TYPE, aggregateId: domainId, aggregateVersion: domain.version, eventKey: `tenant_domain:${domainId}:revoked`, type: DOMAIN_REVOKED_EVENT, schemaVersion: 1, payload: { domain_id: domainId, hostname: domain.hostname } });
    return domain;
  }

  /**
   * The pass of the lifecycle job for the tenant. A Verified domain gets its certificate and becomes Active (a certificate that cannot be issued leaves it Verified with a failed certificate, tried again next pass). An Active
   * custom domain is looked at again when its week is up: the proof gone makes it Failed, so that it no longer chooses the tenant. A certificate that has 14 days left is renewed.
   */
  async sweep(tx: TenantTx, effects: ApprovalEffects, ports: DomainPorts, now: Date): Promise<DomainPassResult> {
    const result: DomainPassResult = { activated: [], failed: [], renewed: [], failing: 0 };
    const live = await tx.query<DomainDbRow & { txt_token_hash: string | null }>(`select ${COLUMNS}, txt_token_hash from machvon.tenant_domain where status in ('Verified', 'Active') order by id for update`);
    for (const row of live) {
      const domain = domainOf(row);
      if ((domain.status === 'Active' || domain.status === 'Verified') && domain.kind === 'CUSTOM' && dueForRecheck(domain.lastCheckedAt, now) && row.txt_token_hash !== null) {
        // A resolver that did not answer says nothing about the proof: the domain keeps its state and its time of last check, so the next pass looks again.
        const records = await ports.proof.txtRecords(challengeRecordName(domain.hostname)).then((answer) => answer, () => undefined);
        const found = records === undefined ? true : challengeAnswered(records, row.txt_token_hash);
        if (!found) {
          await tx.query(`update machvon.tenant_domain set status = 'Failed', failure_code = 'TXT_NOT_FOUND', last_checked_at = $2::timestamptz, version = version + 1 where id = $1::uuid`, [domain.id, now.toISOString()]);
          await effects.audit({ action: 'tenant.domain_failed', resourceType: RESOURCE_TYPE, resourceId: domain.id, diff: { hostname: domain.hostname, reason: 'TXT_NOT_FOUND' } });
          result.failed.push(domain.id);
          continue;
        }
        if (records !== undefined) await tx.query('update machvon.tenant_domain set last_checked_at = $2::timestamptz, version = version + 1 where id = $1::uuid', [domain.id, now.toISOString()]);
      }
      // A domain the provisioning registered is Active with a certificate and no end on record: it is brought into the lifecycle by a pass that records one.
      const issuing = domain.status === 'Verified' || domain.tlsStatus === 'Failed' || domain.tlsStatus === 'Pending' || domain.tlsExpiresAt === null;
      const renewing = domain.status === 'Active' && needsRenewal(domain.tlsExpiresAt, now);
      if (!issuing && !renewing) continue;
      try {
        await ports.certificates.ensureCertificate(domain.hostname);
        await tx.query(`update machvon.tenant_domain set status = 'Active', tls_status = 'Issued', tls_expires_at = $2::timestamptz, failure_code = null, version = version + 1 where id = $1::uuid`, [domain.id, certificateEndsAt(now).toISOString()]);
        (renewing ? result.renewed : result.activated).push(domain.id);
        await effects.audit({ action: renewing ? 'tenant.domain_certificate_renewed' : 'tenant.domain_activated', resourceType: RESOURCE_TYPE, resourceId: domain.id, diff: { hostname: domain.hostname } });
      } catch {
        // The class of the failure is all that is kept: the message may name the provider's account.
        await tx.query(`update machvon.tenant_domain set tls_status = 'Failed', failure_code = 'TLS_FAILED', version = version + 1 where id = $1::uuid`, [domain.id]);
        await effects.audit({ action: 'tenant.domain_certificate_failed', resourceType: RESOURCE_TYPE, resourceId: domain.id, diff: { hostname: domain.hostname } });
        result.failed.push(domain.id);
      }
    }
    const [failing] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.tenant_domain where status <> 'Revoked' and (status = 'Failed' or tls_status = 'Failed')");
    result.failing = Number(failing?.n ?? 0);
    return result;
  }

  async find(tx: TenantTx, id: string): Promise<DomainRow | undefined> {
    const [row] = await tx.query<DomainDbRow>(`select ${COLUMNS} from machvon.tenant_domain where id = $1::uuid`, [id]);
    return row === undefined ? undefined : domainOf(row);
  }

  /** The domains of the tenant, the live ones first, a page at a time. */
  async list(tx: TenantTx, filter: { limit: number; after?: { createdAt: string; id: string } }): Promise<DomainRow[]> {
    const rows = await tx.query<DomainDbRow>(
      // The cursor carries milliseconds (an ISO time), so rows are ordered and compared at that precision: a row made in the same millisecond as the last of a page is never skipped.
      `select ${COLUMNS} from machvon.tenant_domain where ($2::timestamptz is null or (date_trunc('milliseconds', created_at), id) < ($2::timestamptz, $3::uuid)) order by date_trunc('milliseconds', created_at) desc, id desc limit $1::int`,
      [filter.limit, filter.after?.createdAt ?? null, filter.after?.id ?? null],
    );
    return rows.map(domainOf);
  }
}

/** The tenant that a hostname chooses at sign-in, or undefined: a hostname nobody has proved chooses nobody. */
export async function tenantOfDomain(tx: TenantTx, hostname: string): Promise<string | undefined> {
  const [row] = await tx.query<{ tenant_id: string | null }>('select machvon.tenant_of_domain($1) as tenant_id', [hostname]);
  return row?.tenant_id ?? undefined;
}

/** The tenant a domain belongs to, for the commands that name only the domain. */
export async function tenantOfDomainId(tx: TenantTx, domainId: string): Promise<string | undefined> {
  const [row] = await tx.query<{ tenant_id: string | null }>('select machvon.tenant_domain_tenant_of($1::uuid) as tenant_id', [domainId]);
  return row?.tenant_id ?? undefined;
}
