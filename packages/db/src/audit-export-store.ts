import { DomainError, canonicalJson, safeDiff } from '@machvon/kernel';
import { AUDIT_ROW_COLUMNS, leafOf } from './audit-seal-job.ts';
import type { AuditRow } from './audit-seal-job.ts';
import { EXPORT_FORMAT_VERSION, headerLine, renderRecord } from './audit-export-format.ts';
import type { ExportEvent, ExportFormat, ExportLeaf, ExportManifest, ExportRecord, ExportSeal } from './audit-export-format.ts';
import type { TenantTx } from './tenant-database.ts';

const PAGE_ROWS = 2000;

export interface AuditExportRequest {
  tenantId: string;
  /** Start of the period, inclusive. */
  from: Date;
  /** End of the period, exclusive. */
  to: Date;
  /** Only rows of these resource types are exported as events; undefined: every type. */
  resourceTypes: readonly string[] | undefined;
  format: ExportFormat;
  /** The file may not grow past this many bytes (422 EXPORT_RANGE_TOO_LARGE). */
  maxBytes: number;
  generatedAt: Date;
}

export interface AuditExportFile {
  text: string;
  bytes: Buffer;
  events: number;
  leafOnly: number;
  seals: number;
  unsealedEvents: number;
}

interface SealRow {
  id: string;
  from_seq: string;
  to_seq: string;
  merkle_root: string;
  prev_seal_hash: string | null;
  seal_hash: string;
  sealed_at: string;
}

type PageRow = AuditRow & { in_export: boolean };

const tooLarge = (): DomainError => new DomainError('EXPORT_RANGE_TOO_LARGE', 422, 'to');

/** Whether the row is one the request asks for; the same condition decides the bounds and, row by row, EVENT or LEAF. */
const IN_EXPORT = 'occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz and ($3::text[] is null or resource_type = any($3::text[]))';

/**
 * Builds the sealed export of the audit trail of the tenant of the transaction (ST-ADM-016). The caller decides who may export; this
 * reads the whole tenant, so it must be given only to a grant on the whole tenant. A row of a seal window that is not in the request
 * is written as its leaf hash alone, which proves the window complete without showing the row.
 */
export class AuditExportStore {
  async build(tx: TenantTx, request: AuditExportRequest): Promise<AuditExportFile> {
    const params = [request.from.toISOString(), request.to.toISOString(), request.resourceTypes === undefined ? null : [...request.resourceTypes]];
    const [bounds] = await tx.query<{ first_seq: string | null; last_seq: string | null }>(
      `select min(seq)::text as first_seq, max(seq)::text as last_seq from machvon.audit_event where ${IN_EXPORT}`,
      params,
    );
    const first = bounds?.first_seq == null ? undefined : Number(bounds.first_seq);
    const last = bounds?.last_seq == null ? undefined : Number(bounds.last_seq);
    const seals = first === undefined || last === undefined ? [] : await this.sealsOver(tx, first, last);
    const lines: string[] = [];
    let size = 0;
    const append = (record: ExportRecord): void => {
      const line = renderRecord(record, request.format);
      size += Buffer.byteLength(line) + 1;
      if (size > request.maxBytes) throw tooLarge();
      lines.push(line);
    };

    let events = 0;
    let leafOnly = 0;
    let unsealedEvents = 0;
    if (first !== undefined && last !== undefined) {
      const low = Math.min(first, seals[0] === undefined ? first : Number(seals[0].from_seq));
      const high = Math.max(last, seals.length === 0 ? last : Number((seals[seals.length - 1] as SealRow).to_seq));
      for (const seal of seals) append(sealRecord(seal));
      let after = low - 1;
      let cursor = 0;
      for (;;) {
        const page = await tx.query<PageRow>(
          `select ${AUDIT_ROW_COLUMNS}, (${IN_EXPORT}) as in_export from machvon.audit_event where seq > $4::bigint and seq <= $5::bigint order by seq limit $6`,
          [...params, after, high, PAGE_ROWS],
        );
        for (const { in_export: inExport, ...row } of page) {
          const seq = Number(row.seq);
          while (cursor < seals.length && Number((seals[cursor] as SealRow).to_seq) < seq) cursor += 1;
          const seal = seals[cursor];
          const sealId = seal !== undefined && Number(seal.from_seq) <= seq ? seal.id : null;
          if (inExport) {
            append(eventRecord(row, sealId));
            events += 1;
            if (sealId === null) unsealedEvents += 1;
          } else if (sealId !== null) {
            append(leafRecord(row));
            leafOnly += 1;
          }
        }
        const lastRow = page[page.length - 1];
        if (lastRow === undefined || page.length < PAGE_ROWS) break;
        after = Number(lastRow.seq);
      }
    }

    const manifest: ExportManifest = {
      record_type: 'MANIFEST',
      format_version: EXPORT_FORMAT_VERSION,
      tenant_id: request.tenantId,
      generated_at: request.generatedAt.toISOString(),
      period_from: request.from.toISOString(),
      period_to: request.to.toISOString(),
      resource_types: request.resourceTypes === undefined ? null : [...request.resourceTypes],
      first_seq: first ?? null,
      last_seq: last ?? null,
      events,
      leaf_only: leafOnly,
      seals: seals.length,
      unsealed_events: unsealedEvents,
    };
    const header = headerLine(request.format);
    const body = [...(header === undefined ? [] : [header]), renderRecord(manifest, request.format), ...lines];
    const text = `${body.join('\n')}\n`;
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > request.maxBytes) throw tooLarge();
    return { text, bytes, events, leafOnly, seals: seals.length, unsealedEvents };
  }

  /** The seals whose window touches the sequence range, oldest first. */
  private sealsOver(tx: TenantTx, first: number, last: number): Promise<SealRow[]> {
    return tx.query<SealRow>(
      `select s.id, s.from_seq::text as from_seq, s.to_seq::text as to_seq, s.merkle_root, s.prev_seal_hash, s.seal_hash,
              to_char(s.sealed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sealed_at
         from machvon.audit_seal s where s.to_seq >= $1::bigint and s.from_seq <= $2::bigint order by s.to_seq`,
      [first, last],
    );
  }
}

function sealRecord(seal: SealRow): ExportSeal {
  return {
    record_type: 'SEAL',
    id: seal.id,
    from_seq: Number(seal.from_seq),
    to_seq: Number(seal.to_seq),
    merkle_root: seal.merkle_root,
    prev_seal_hash: seal.prev_seal_hash,
    seal_hash: seal.seal_hash,
    sealed_at: seal.sealed_at,
  };
}

function leafRecord(row: AuditRow): ExportLeaf {
  return { record_type: 'LEAF', seq: Number(row.seq), leaf_hash: leafOf(row) };
}

function eventRecord(row: AuditRow, sealId: string | null): ExportEvent {
  const stored = row.safe_diff;
  // The writer redacts before it stores, so this changes nothing in the normal case; a value a writer forgot to list stays out of the export.
  const shown = safeDiff(stored as Record<string, unknown>);
  return {
    record_type: 'EVENT',
    id: row.id,
    seq: Number(row.seq),
    actor_id: row.actor_id as string,
    action: row.action as string,
    resource_type: row.resource_type as string,
    resource_id: row.resource_id as string,
    safe_diff: shown,
    reason: row.reason as string | null,
    correlation_id: row.correlation_id as string,
    request_id: row.request_id as string,
    outcome: row.outcome as string,
    classification: row.classification as string,
    impersonator_id: row.impersonator_id as string | null,
    on_behalf_of_id: row.on_behalf_of_id as string | null,
    ip_hash: row.ip_hash as string | null,
    schema_version: row.schema_version as number,
    occurred_at: row.occurred_at as string,
    leaf_hash: leafOf(row),
    seal_id: sealId,
    redacted: canonicalJson(shown) !== canonicalJson(stored),
  };
}
