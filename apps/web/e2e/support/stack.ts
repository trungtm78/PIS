import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import fixtures from './e2e-fixtures.json' with { type: 'json' };
import { STACK_INFO_PATH } from './stack-paths.ts';

/** What the API stack writes about itself once it is ready (apps/api/test/e2e-stack/serve.stack.ts). */
export interface StackInfo {
  apiPort: number;
  /** A superuser connection: the tests use it to look at rows the screens changed (it bypasses row-level security). */
  adminUrl: string;
  /** A and B are Active; C is Suspended (a read-only session). */
  tenants: { A: string; B: string; C: string };
  /** The published STANDARD plan a tenant request names. */
  planVersionId: string;
  units: Record<'A' | 'B' | 'C', Record<string, string>>;
  /** The test identity provider: the issuer address the web application signs in at. */
  idpIssuer: string;
  /** Outgoing documents of tenant A: two the visual cases read (one waits for the leader, one for a number) and one the signing flow changes. */
  documents: { visualSubmitted: string; flowSubmitted: string; visualSigned: string };
}

export function stackInfo(): StackInfo {
  return JSON.parse(readFileSync(STACK_INFO_PATH, 'utf8')) as StackInfo;
}

export const RECIPIENT_MEMBERSHIP = fixtures.recipientMembershipId;

/** The membership of a fixture user by key (`owner`, `unitAdmin`, `auditor`, `nobody`). */
export function membershipOf(key: string): string {
  const user = fixtures.users.find((candidate) => candidate.key === key);
  if (user === undefined) throw new Error(`fixture user ${key} is missing`);
  return user.membershipId;
}

/** Reads rows straight from the database the API writes to. */
export async function sql<T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/**
 * Puts the permit types, and the gate rules on them, that earlier tests published or ended for a later day (their codes start with E2E_) behind a window of one day long past (three days apart, so that no two overlap): a
 * project's dossier plans one permit for each type in force that applies to it, and its readiness and the gates count them all, so a test that
 * reads either starts from the types and rules it seeds itself. The rows are written with the triggers of a published row off (the connection
 * is a superuser's): a published row cannot be ended before the day it began through the application.
 */
export async function retireTestPermitTypes(): Promise<void> {
  await sql(
    `begin;
     set local session_replication_role = replica;
     update machvon.permit_gate_rule set status = 'RETIRED', effective_from = date '2000-01-01' + (abs(hashtext(id::text)) % 3000) * 3, updated_at = now(),
            effective_until = date '2000-01-02' + (abs(hashtext(id::text)) % 3000) * 3
      where status in ('PUBLISHED', 'RETIRED') and (effective_until is null or effective_until >= current_date)
        and permit_type_id in (select id from machvon.permit_type where left(code, 4) = 'E2E_');
     update machvon.permit_type set status = 'RETIRED', effective_from = date '2000-01-01' + (abs(hashtext(id::text)) % 3000) * 3, updated_at = now(),
            effective_until = date '2000-01-02' + (abs(hashtext(id::text)) % 3000) * 3
      where status in ('PUBLISHED', 'RETIRED') and left(code, 4) = 'E2E_' and (effective_until is null or effective_until >= current_date);
     commit`,
  );
}
