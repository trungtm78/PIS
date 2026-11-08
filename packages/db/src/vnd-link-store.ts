import { buildLinks, clustersOf, taxHeadOf } from '@machvon/kernel';
import type { LinkCluster, LinkPolicy, LinkSet, PartyKeys, PartyLink } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

export interface LinkRow {
  aId: string;
  bId: string;
  strength: number;
  status: 'ACTIVE' | 'STALE';
  evidence: Array<{ kind: string; fingerprint: string; weight: number }>;
}

export interface LinkSnapshot {
  parties: PartyKeys[];
  set: LinkSet;
  clusters: LinkCluster[];
  /** Every connected group of two or more, whatever its score: the lead of a new company of a banned party is looked for in these. */
  components: LinkCluster[];
}

/**
 * The projection of the related-party graph (VND-3, V6): the keys of the register of contractors (VND-1) and of the traces of the submissions are read, the kernel builds the links and the clusters with the rule in force, and the
 * links are written as a projection that a scan recomputes. A link that a scan no longer finds becomes STALE; nothing is deleted. Auditors only (the portal path is refused these tables by the database).
 */
export class VendorLinkStore {
  /** The keys of every contractor of the tenant that are compared: the register keys and the keys of the traces of its proposals. */
  async parties(tx: TenantTx): Promise<PartyKeys[]> {
    const contractors = await tx.query<{ id: string; tax_identifier: string; legal_rep_key: string | null; address_key: string | null; phone_key: string | null; email_key: string | null }>(
      'select id, tax_identifier, legal_rep_key, address_key, phone_key, email_key from machvon.contractor order by id',
    );
    const accounts = await tx.query<{ contractor_id: string; account_no_key: string }>("select contractor_id, account_no_key from machvon.contractor_bank_account where state in ('ACTIVE', 'SUPERSEDED')");
    const owners = await tx.query<{ contractor_id: string; name_key: string; identity_key: string | null }>('select contractor_id, name_key, identity_key from machvon.contractor_owner where ended_on is null');
    const traces = await tx.query<{ contractor_id: string; origin_key: string | null; device_key: string | null }>('select contractor_id, origin_key, device_key from machvon.proposal_submission_trace');
    const files = await tx.query<{ contractor_id: string; file_key: string }>('select t.contractor_id, f.file_key from machvon.proposal_submission_file f join machvon.proposal_submission_trace t on t.tenant_id = f.tenant_id and t.id = f.trace_id');
    const group = <T extends { contractor_id: string }>(rows: T[], pick: (row: T) => Array<string | null>): Map<string, string[]> => {
      const out = new Map<string, string[]>();
      for (const row of rows) {
        const list = out.get(row.contractor_id) ?? [];
        for (const key of pick(row)) if (key !== null && !list.includes(key)) list.push(key);
        out.set(row.contractor_id, list);
      }
      return out;
    };
    const bank = group(accounts, (row) => [row.account_no_key]);
    const owner = group(owners, (row) => [row.name_key, row.identity_key]);
    const origin = group(traces, (row) => [row.origin_key]);
    const device = group(traces, (row) => [row.device_key]);
    const file = group(files, (row) => [row.file_key]);
    return contractors.map((row) => ({
      contractorId: row.id,
      taxHead: taxHeadOf(row.tax_identifier),
      bankAccountKeys: bank.get(row.id) ?? [],
      legalRepKey: row.legal_rep_key,
      ownerKeys: owner.get(row.id) ?? [],
      addressKey: row.address_key,
      phoneKey: row.phone_key,
      emailKey: row.email_key,
      originKeys: origin.get(row.id) ?? [],
      deviceKeys: device.get(row.id) ?? [],
      fileAuthorKeys: file.get(row.id) ?? [],
    }));
  }

  async snapshot(tx: TenantTx, policy: LinkPolicy): Promise<LinkSnapshot> {
    const parties = await this.parties(tx);
    const set = buildLinks(parties, policy);
    return { parties, set, clusters: clustersOf(set.links, policy), components: clustersOf(set.links, { cluster_from: 1 }) };
  }

  /** Writes the links of a scan and marks the ones the scan did not find as STALE; returns how many links are active now. */
  async replace(tx: TenantTx, scanId: string, links: readonly PartyLink[], now: Date): Promise<number> {
    for (const link of links) {
      await tx.query(
        `insert into machvon.contractor_party_link (tenant_id, contractor_a_id, contractor_b_id, strength, evidence, status, scan_id, first_seen_at, last_seen_at)
         values (${TENANT}, $1::uuid, $2::uuid, $3, $4::jsonb, 'ACTIVE', $5::uuid, $6::timestamptz, $6::timestamptz)
         on conflict (tenant_id, contractor_a_id, contractor_b_id)
         do update set strength = excluded.strength, evidence = excluded.evidence, status = 'ACTIVE', scan_id = excluded.scan_id, last_seen_at = excluded.last_seen_at`,
        [link.a, link.b, link.strength, JSON.stringify(link.evidence), scanId, now.toISOString()],
      );
    }
    await tx.query("update machvon.contractor_party_link set status = 'STALE' where status = 'ACTIVE' and scan_id <> $1::uuid", [scanId]);
    return links.length;
  }

  /** The links stored that touch any of the contractors (both ends among them for a cluster; one end for the neighbourhood of one contractor). */
  async linksOf(tx: TenantTx, contractorIds: readonly string[], both: boolean): Promise<LinkRow[]> {
    const rows = await tx.query<{ contractor_a_id: string; contractor_b_id: string; strength: number; status: 'ACTIVE' | 'STALE'; evidence: LinkRow['evidence'] }>(
      `select contractor_a_id, contractor_b_id, strength, status, evidence from machvon.contractor_party_link
        where ${both ? 'contractor_a_id = any($1::uuid[]) and contractor_b_id = any($1::uuid[])' : '(contractor_a_id = any($1::uuid[]) or contractor_b_id = any($1::uuid[]))'}
        order by status, strength desc, contractor_a_id, contractor_b_id`,
      [[...contractorIds]],
    );
    return rows.map((row) => ({ aId: row.contractor_a_id, bId: row.contractor_b_id, strength: row.strength, status: row.status, evidence: row.evidence }));
  }

  /** The contractors with a restriction in force on the day. */
  async restricted(tx: TenantTx, today: string): Promise<Set<string>> {
    const rows = await tx.query<{ contractor_id: string }>(
      'select distinct contractor_id from machvon.contractor_restriction where lifted_at is null and effective_from <= $1::date and (effective_until is null or effective_until >= $1::date)',
      [today],
    );
    return new Set(rows.map((row) => row.contractor_id));
  }

  async contractors(tx: TenantTx, ids: readonly string[], today: string): Promise<Array<{ id: string; name: string; taxIdentifier: string; restricted: boolean }>> {
    if (ids.length === 0) return [];
    const rows = await tx.query<{ id: string; legal_name: string; tax_identifier: string; restricted: boolean }>(
      `select c.id, c.legal_name, c.tax_identifier,
              exists (select 1 from machvon.contractor_restriction r where r.tenant_id = c.tenant_id and r.contractor_id = c.id and r.lifted_at is null and r.effective_from <= $2::date and (r.effective_until is null or r.effective_until >= $2::date)) as restricted
         from machvon.contractor c where c.id = any($1::uuid[]) order by c.legal_name, c.id`,
      [[...ids], today],
    );
    return rows.map((row) => ({ id: row.id, name: row.legal_name, taxIdentifier: row.tax_identifier, restricted: row.restricted }));
  }

  /** The latest scan, for the figures and for the graph. */
  async lastScan(tx: TenantTx): Promise<{ id: string; finishedAt: string; parties: number; links: number; clusters: number; packages: number; leadsNew: number } | undefined> {
    const [row] = await tx.query<{ id: string; finished_at: string; parties: number; links: number; clusters: number; packages: number; leads_new: number }>(
      'select id, finished_at::text as finished_at, parties, links, clusters, packages, leads_new from machvon.vendor_link_scan order by finished_at desc, id desc limit 1',
    );
    return row === undefined ? undefined : { id: row.id, finishedAt: new Date(row.finished_at).toISOString(), parties: row.parties, links: row.links, clusters: row.clusters, packages: row.packages, leadsNew: row.leads_new };
  }
}
