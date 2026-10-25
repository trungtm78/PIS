import { Client } from 'pg';

/**
 * Sets the stage of a non-conformance the way a test needs it, as the superuser with the triggers off: the guard of its status lets the commands of ST-QMS-006 move it one edge at a time, and a test of
 * something else (the acceptance that waits for it) only needs it to be open or closed.
 */
export async function ncrStatement(adminUrl: string, sql: string, params: unknown[] = []): Promise<void> {
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
  ncrStatement(
    adminUrl,
    "update machvon.quality_nonconformance set status = 'CLOSED', verified_by = $2::uuid, closed_by = $2::uuid, closed_at = now(), closure_note = 'closed for the test' where id = $1::uuid",
    [id, closer],
  );
