import { Client } from 'pg';

/**
 * Sets the stage the way a test needs it, as the superuser with the triggers and the foreign keys off: the guards of the statuses (a non-conformance moves one edge at a time) and the
 * records that a test of something else leans on (the acceptance that waits for a non-conformance, the contract that waits for a measurement) are written as they must be, not as the
 * commands of other stories would have made them.
 */
export async function asSuperuser(adminUrl: string, sql: string, params: unknown[] = []): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/** A non-conformance that was verified and closed by the member (who is not the owner of its action). */
export const closeNcr = (adminUrl: string, id: string, closer: string): Promise<void> =>
  asSuperuser(
    adminUrl,
    "update machvon.quality_nonconformance set status = 'CLOSED', verified_by = $2::uuid, closed_by = $2::uuid, closed_at = now(), closure_note = 'closed for the test' where id = $1::uuid",
    [id, closer],
  );
