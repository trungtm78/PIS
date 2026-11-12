import { AuditSealJob } from '@machvon/db';
import type { Client } from 'pg';
import { MEMBERSHIP, TENANT_A, appendEntries, contextOf, ownerSession, recorder, startAuditHarness } from '../../../../packages/db/test/support/audit-fixtures';
import type { AuditHarness, Recorded } from '../../../../packages/db/test/support/audit-fixtures';
import { expectCheckFails } from '../uat/uat-kit';

/**
 * UAT case of the audit trail (NFR-SECURITY-11): the application role can only add rows to the audit table, and a row the owner role changed on purpose is found by the job that
 * checks the chain of hashes, which raises AUDIT_CHAIN_BROKEN.
 */
describe('the audit trail of the platform fixture is append-only and tamper-evident (NFR-SECURITY-11)', () => {
  let harness: AuditHarness;
  let owner: Client;
  let seen: Recorded;
  let job: AuditSealJob;

  beforeAll(async () => {
    harness = await startAuditHarness();
    owner = await ownerSession(harness, TENANT_A);
    seen = recorder();
    // The seal job closes a window every ten rows, so thirty rows are three seals and the 25th row is inside the third.
    job = new AuditSealJob(harness.tenantDatabase, { windowRows: 10, ...seen.sinks });
  }, 180_000);

  afterAll(async () => {
    if (owner) await owner.end();
    if (harness) await harness.stop();
  }, 60_000);

  it('UAT-NFR-SECURITY-11: UPDATE and DELETE by the application role are permission denied, and a payload the owner changed in row 25 is reported as a hash mismatch with AUDIT_CHAIN_BROKEN', async () => {
    const { seqs } = await appendEntries(harness, TENANT_A, 30);
    expect(seqs).toHaveLength(30);
    await job.seal(contextOf(TENANT_A));

    const as = <T>(work: (tx: Parameters<Parameters<typeof harness.tenantDatabase.withTenant>[1]>[0]) => Promise<T>): Promise<T> => harness.tenantDatabase.withTenant(contextOf(TENANT_A), work);
    await expect(as((tx) => tx.query('update machvon.audit_event set actor_id = $1 where seq = $2', [MEMBERSHIP, seqs[24]]))).rejects.toThrow(/permission denied/);
    await expect(as((tx) => tx.query('delete from machvon.audit_event where seq = $1', [seqs[24]]))).rejects.toThrow(/permission denied/);
    expect(await job.verify(contextOf(TENANT_A))).toEqual({ ok: true, seals: 3 });
    expect(seen.alerts).toEqual([]);

    // The owner role is the way a drill plays the intruder: the payload of row 25 is changed.
    await owner.query("update machvon.audit_event set safe_diff = '{\"index\": 999}'::jsonb where seq = $1", [seqs[24]]);
    const outcome = await job.verify(contextOf(TENANT_A));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a broken chain');
    expect(outcome.brokenAt.reason).toBe('ROOT_MISMATCH');
    expect(outcome.brokenAt.fromSeq).toBeLessThanOrEqual(seqs[24] as number);
    expect(outcome.brokenAt.toSeq).toBeGreaterThanOrEqual(seqs[24] as number);
    expect(seen.alerts).toEqual([{ code: 'AUDIT_CHAIN_BROKEN', context: { tenantId: TENANT_A, ...outcome.brokenAt } }]);
    expect(seen.metrics).toEqual([{ name: 'audit_seal_failures_total', labels: { tenant_id: TENANT_A } }]);
  });

  it('the checks of this suite can go red: a check fed the wrong answer throws', () => {
    expectCheckFails(() => expect([]).toEqual([{ code: 'AUDIT_CHAIN_BROKEN' }]));
    expectCheckFails(() => expect({ ok: true, seals: 3 }).toEqual({ ok: false }));
  });
});
