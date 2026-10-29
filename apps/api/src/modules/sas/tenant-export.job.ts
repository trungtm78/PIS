import { createHash, randomUUID } from 'node:crypto';
import { TenantExportStore, enqueueOutbox } from '@machvon/db';
import type { ApprovalEffects, AuditWriter, ExportJobRow, ExportPassResult, ExportReady, TenantDatabase, TenantTx } from '@machvon/db';
import { UPLOAD_PURPOSES, attachmentKindInScope, buildManifest, bytesSha256, encryptForCustomer, manifestText, parseCustomerKey, parseObjectKey, splitColumns, tablesToExport } from '@machvon/kernel';
import type { ManifestFile, TenantContext } from '@machvon/kernel';
import type { FileService } from '../files/file.service';

/** The kind of the stored objects of the export (`tenants/{tenant}/tenant_export/{job}.{name}`). */
export const EXPORT_OBJECT_KIND = 'tenant_export';
/** Most objects the rows of a tenant may refer to that an export follows. */
const MAX_REFERENCES = 200_000;
/** Rows read for a file at a time. */
export const EXPORT_PAGE_ROWS = 1000;
/** The most an export holds (R1 keeps a file in memory while it is made): a tenant with more is made in parts by hand (TODOS.md). */
export const EXPORT_MAX_BYTES = 512 * 1024 * 1024;

class TooManyReferences extends Error {
  constructor() {
    super('the rows refer to more files than an export follows');
    this.name = 'TooManyReferences';
  }
}

class ExportTooLarge extends Error {
  constructor() {
    super('the export is larger than the limit');
    this.name = 'ExportTooLarge';
  }
}

/** The id of the stored object that holds the file of an export: the job and a hash of the path of the manifest, so it fits one plain path segment however long the path is. */
export const exportObjectId = (jobId: string, path: string): string => `${jobId}.${createHash('sha256').update(path).digest('hex').slice(0, 32)}`;

function valueOf(value: unknown): unknown {
  // bytea reaches JSON as base64 text; everything else (numbers, dates, jsonb, arrays) is what JSON.stringify makes of it.
  return Buffer.isBuffer(value) ? `base64:${value.toString('base64')}` : value;
}

const lineOf = (row: Record<string, unknown>): string => `${JSON.stringify(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, valueOf(value)])))}\n`;

/**
 * The job `tenant-export` (SAS.md 3.10): for the tenant it is given, the exports that wait are made, one at a time. The rows of every table of the tenant plane are read in ONE read-only REPEATABLE READ transaction (one
 * picture of the tenant), written as a JSON lines file for each table (the columns that hold a secret are left out and the manifest says which), the CLEAN files of the tenant are copied beside them, and the manifest lists every file with
 * its size and sha256 and the rows of each table. With the public key of the customer every file is encrypted before it is stored. The export is then Ready for 72 hours. A pass that fails ends the job as Failed, with the class of the
 * failure and never its message.
 */
export class TenantExportJob {
  private readonly store = new TenantExportStore();

  constructor(
    private readonly tenants: TenantDatabase,
    private readonly files: Pick<FileService, 'storeGenerated' | 'readStored' | 'listKind'>,
    private readonly audit: Pick<AuditWriter, 'recordInTx'>,
    /** The store of the document module (signed versions, verification reports): files the rows refer to that the file service does not hold. */
    private readonly documentFiles?: { get(key: string): Promise<{ bytes: Uint8Array } | undefined> },
    private readonly options: { maxBytes?: number; maxReferences?: number; clock?: () => Date } = {},
  ) {}

  /** How many exports wait or run for the tenant: counted by the scheduler before a pass makes any. */
  pending(ctx: TenantContext): Promise<number> {
    return this.tenants.withTenant(ctx, (tx) => this.store.pendingCount(tx));
  }

  async run(ctx: TenantContext, now: Date): Promise<ExportPassResult> {
    for (;;) {
      const job = await this.tenants.withTenant(ctx, (tx) => this.store.claim(tx));
      if (job === undefined) break;
      await this.make(ctx, job);
    }
    return this.tenants.withTenant(ctx, (tx) => this.store.sweep(tx, this.effects(tx, ctx.membershipId), now));
  }

  private effects(tx: TenantTx, actor: string): ApprovalEffects {
    const correlationId = randomUUID();
    return {
      actor,
      audit: (entry) => this.audit.recordInTx(tx, actor, { ...entry, correlationId, requestId: randomUUID() }),
      emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
    };
  }

  private async make(ctx: TenantContext, job: ExportJobRow): Promise<void> {
    try {
      const built = await this.tenants.withSnapshot(ctx, (tx) => this.build(tx, ctx, job));
      // The 72 hours start when the export is ready, not when the pass began: the pass visits the tenants one after the other and an export takes its time.
      await this.tenants.withTenant(ctx, (tx) => this.store.ready(tx, this.effects(tx, ctx.membershipId), job.id, built, (this.options.clock ?? (() => new Date()))()));
    } catch (error) {
      // Only the class of the failure is kept: the message may hold data of the tenant.
      const code = error instanceof Error ? error.name : 'UnknownError';
      await this.tenants.withTenant(ctx, (tx) => this.store.fail(tx, this.effects(tx, ctx.membershipId), job.id, code));
    }
  }

  // The file service first, then the store of the documents; undefined when neither holds the key.
  // A file of the file service that the antivirus has not passed is withheld, not exported and not looked for elsewhere.
  private async read(ctx: TenantContext, key: string): Promise<Uint8Array | 'withheld' | undefined> {
    const own = await this.files.readStored(ctx, key).catch(() => undefined);
    if (own !== undefined) return own.object.scanStatus === 'CLEAN' ? own.bytes : 'withheld';
    return (await this.documentFiles?.get(key))?.bytes;
  }

  private async build(tx: TenantTx, ctx: TenantContext, job: ExportJobRow): Promise<ExportReady> {
    const key = job.publicKeyPem === null ? undefined : parseCustomerKey(job.publicKeyPem);
    const [clock] = await tx.query<{ at: Date }>('select now() as at');
    const snapshotAt = clock?.at ?? new Date();
    // The state of the tenant in this very snapshot (the first query of it has been made): an archive counts only an export that saw the tenant Offboarding.
    const [runtime] = await tx.query<{ status: string }>("select status from machvon.tenant_runtime(nullif(current_setting('app.tenant_id', true), '')::uuid)");
    const entries: ManifestFile[] = [];
    const omitted: Record<string, string[]> = {};
    let total = 0;
    const limit = this.options.maxBytes ?? EXPORT_MAX_BYTES;
    // The objects that rows refer to (`tenants/{tenant}/{kind}/{id}`), found in the text of the lines as they are written.
    const referenced = new Set<string>();
    const reference = new RegExp(`tenants/${job.tenantId}/[a-z][a-z0-9_-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}`, 'g');
    const copied = new Set<string>();

    const keep = async (path: string, plain: Uint8Array, extra: Partial<ManifestFile>, contentType: string): Promise<void> => {
      total += plain.length;
      if (total > limit) throw new ExportTooLarge();
      const sealed = key === undefined ? undefined : encryptForCustomer(plain, key);
      const bytes = sealed === undefined ? plain : sealed.stored;
      const stored = sealed === undefined ? path : `${path}.enc`;
      await this.files.storeGenerated(ctx, EXPORT_OBJECT_KIND, exportObjectId(job.id, stored), bytes, sealed === undefined ? contentType : 'application/octet-stream');
      entries.push({ path: stored, bytes: bytes.length, sha256: bytesSha256(bytes), ...extra, ...(sealed === undefined ? {} : { encryption: sealed.encryption }) });
    };

    for (const table of tablesToExport(await this.store.tablesOf(tx), job.scope)) {
      const { kept, omitted: left } = splitColumns(await this.store.columnsOf(tx, table));
      if (left.length > 0) omitted[table] = left;
      // The size is counted as the pages are read, so a table larger than the limit stops the export before it is held in memory.
      const chunks: Buffer[] = [];
      let held = 0;
      let rows = 0;
      // A cursor over the table: every row is read once, whatever the size of the table, where a page by offset would read the table again for each page.
      await this.store.openRows(tx, table, kept);
      for (;;) {
        const page = await this.store.nextRows(tx, EXPORT_PAGE_ROWS);
        const text = page.map(lineOf).join('');
        held += Buffer.byteLength(text, 'utf8');
        if (total + held > limit) throw new ExportTooLarge();
        chunks.push(Buffer.from(text, 'utf8'));
        for (const found of text.match(reference) ?? []) {
          if (referenced.has(found)) continue;
          // A reference dropped would be a file missing from an export that looks whole: the export stops instead.
          if (referenced.size >= (this.options.maxReferences ?? MAX_REFERENCES)) throw new TooManyReferences();
          referenced.add(found);
        }
        rows += page.length;
        if (page.length < EXPORT_PAGE_ROWS) break;
      }
      await this.store.closeRows(tx);
      await keep(`tables/${table}.jsonl`, Buffer.concat(chunks), { table, rows }, 'application/x-ndjson');
    }

    // The files of the tenant (documents, imports, photos): the ones the antivirus passed, copied beside the tables.
    for (const kind of Object.keys(UPLOAD_PURPOSES).filter((candidate) => attachmentKindInScope(candidate, job.scope))) {
      for (const object of await this.files.listKind(ctx, kind)) {
        if (object.scanStatus !== 'CLEAN') continue;
        const id = object.key.split('/').pop() ?? '';
        const stored = await this.files.readStored(ctx, object.key);
        copied.add(object.key);
        await keep(`attachments/${kind}/${id}`, stored.bytes, {}, object.contentType);
      }
    }

    // The files that rows refer to and the sweep above did not reach (the signed versions of documents, the reports of their verification): read from the store that holds them. A reference nobody can read is named in the manifest.
    const missing: string[] = [];
    const withheld: string[] = [];
    for (const objectKeyOf of [...referenced].sort()) {
      if (copied.has(objectKeyOf)) continue;
      const parts = parseObjectKey(objectKeyOf);
      if (parts === undefined || parts.kind === EXPORT_OBJECT_KIND || !attachmentKindInScope(parts.kind, job.scope)) continue;
      const bytes = await this.read(ctx, objectKeyOf);
      if (bytes === 'withheld') withheld.push(objectKeyOf);
      else if (bytes === undefined) missing.push(objectKeyOf);
      else await keep(`attachments/${parts.kind}/${parts.id}`, bytes, {}, 'application/octet-stream');
      copied.add(objectKeyOf);
    }

    const manifest = buildManifest({ job_id: job.id, tenant_id: job.tenantId, scope: job.scope, snapshot_at: snapshotAt.toISOString(), files: entries, omitted_columns: omitted, missing_files: missing, withheld_files: withheld, unreadable_tables: tablesToExport(await this.store.unreadableTablesOf(tx), job.scope), encryption_key_fingerprint: key?.fingerprint ?? null });
    const text = Buffer.from(manifestText(manifest), 'utf8');
    const manifestKey = await this.files.storeGenerated(ctx, EXPORT_OBJECT_KIND, exportObjectId(job.id, 'manifest.json'), text, 'application/json');
    return { manifestStorageKey: manifestKey, manifestSha256: bytesSha256(text), fileCount: entries.length + 1, totalBytes: entries.reduce((sum, file) => sum + file.bytes, 0) + text.length, rowCounts: manifest.row_counts, snapshotAt, tenantStatus: runtime?.status ?? 'Unknown' };
  }
}
