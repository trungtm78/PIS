import { FEED_FORMATS, FEED_LAYOUT_VERSION, FEED_POSITIONS } from '@machvon/kernel';
import type { Difference, FeedKind, FeedProjectRecord, FeedRecord, FileImportFormat, SourceRow } from '@machvon/kernel';
import { resolveEgpSubject } from './egp-store.ts';
import { FeedMappingStore } from './finance-feed-mapping-store.ts';
import { FeedRecordStore } from './finance-feed-store.ts';
import type { ApplyContext, ImportEntry } from './file-import-store.ts';
import type { PreviewableAdapter } from './file-import-preview.ts';
import type { TenantTx } from './tenant-database.ts';

/** The differences an import opens when the mapping a record asks for cannot be made. */
export const FEED_DIFFERENCE_CODES = {
  OUR_CODE_UNKNOWN: 'FEED_OUR_CODE_UNKNOWN',
  EXTERNAL_CODE_TAKEN: 'FEED_EXTERNAL_CODE_TAKEN',
  SUBJECT_HAS_OTHER_CODE: 'FEED_SUBJECT_HAS_OTHER_CODE',
} as const;

/** What the apply of a valid row does (the dry run says it): only the record, or the record and a mapping proposed for a person to approve, or the record and a difference for a person to settle. */
export type FeedRowOutcome = 'RECORD' | 'RECORD_AND_PROPOSE' | 'RECORD_AND_DIFFERENCE';

export interface FeedImportContext {
  actor: string;
  now: Date;
}

/**
 * One kind of file of the Finance Department for the file import framework (FEED-1, `docs/finance-feed.md`): the layout and the judgement of a row are the pure formats of the kernel (`FEED_FORMATS`, layout
 * `WORKING-ASSUMPTION-FIN-2026.1`); this half writes what the store holds. The apply of a row, once per business key ever (the framework claims the key):
 *  1. keeps what the file said as a record (`finance_feed_record`, append-only, channel FILE, under the import);
 *  2. for a project record that names one of our codes, proposes the exact mapping on `master_crosswalk` (the loader is the maker; another person approves on FEED-03), or opens a difference when it cannot.
 * No call leaves the machine. A valid row is never refused for what the register holds: what cannot be matched is a difference, not a rejection of what the Finance Department said.
 */
export class FeedImportAdapter implements PreviewableAdapter<FeedRecord> {
  readonly connectorCode: string;
  readonly formatVersion: string = FEED_LAYOUT_VERSION;
  /** What the apply wrote, for the audit rows and events of the command. */
  readonly written = { records: 0, proposals: 0, differences: 0, asOfLatest: null as string | null };

  private readonly kind: FeedKind;
  private readonly context: FeedImportContext;
  private readonly format: FileImportFormat<FeedRecord>;
  private readonly mappings = new FeedMappingStore();
  private readonly records = new FeedRecordStore();

  constructor(kind: FeedKind, context: FeedImportContext) {
    this.kind = kind;
    this.context = context;
    this.connectorCode = FEED_POSITIONS[kind];
    this.format = FEED_FORMATS[kind] as FileImportFormat<FeedRecord>;
  }

  parse = (bytes: Uint8Array): SourceRow[] => this.format.parse(bytes);
  judge = (row: SourceRow): ReturnType<FileImportFormat<FeedRecord>['judge']> => this.format.judge(row);
  mask = (values: Readonly<Record<string, string>>): Record<string, string> => (this.format.mask === undefined ? {} : this.format.mask(values));

  private ourCodeOf(entry: FeedRecord): { feedProjectCode: string; ourCode: string } | null {
    if (this.kind !== 'PROJECT') return null;
    const project = entry.record as FeedProjectRecord;
    return project.ourProjectCode === null ? null : { feedProjectCode: project.feedProjectCode, ourCode: project.ourProjectCode };
  }

  /** What the apply would do with the row (the dry run says it). */
  async outcomeOf(tx: TenantTx, entry: ImportEntry<FeedRecord>): Promise<FeedRowOutcome> {
    const planned = await this.plan(tx, entry.record);
    return planned === 'PROPOSE' ? 'RECORD_AND_PROPOSE' : planned === 'DIFFERENCE' ? 'RECORD_AND_DIFFERENCE' : 'RECORD';
  }

  private async plan(tx: TenantTx, record: FeedRecord): Promise<'NONE' | 'PROPOSE' | 'DIFFERENCE'> {
    const named = this.ourCodeOf(record);
    if (named === null) return 'NONE';
    const lookup = await resolveEgpSubject(tx, 'PROJECT', named.ourCode, null);
    if ('missing' in lookup) return 'DIFFERENCE';
    const outcome = await this.mappings.outcomeOf(tx, lookup.found.id, named.feedProjectCode);
    if (outcome.outcome === 'ALREADY_ACTIVE') return 'NONE';
    if (outcome.outcome !== 'CREATE') return 'DIFFERENCE';
    return (await this.mappings.waiting(tx, lookup.found.id, named.feedProjectCode)) ? 'NONE' : 'PROPOSE';
  }

  async apply(tx: TenantTx, entry: ImportEntry<FeedRecord>, context: ApplyContext): Promise<readonly Difference[]> {
    await this.records.insert(tx, [entry.record], { channel: 'FILE', epoch: 0, runId: null, importId: context.importId, layoutVersion: this.formatVersion, actor: this.context.actor });
    this.written.records += 1;
    if (this.written.asOfLatest === null || entry.record.asOf > this.written.asOfLatest) this.written.asOfLatest = entry.record.asOf;
    const named = this.ourCodeOf(entry.record);
    if (named === null) return [];
    const done = await this.mappings.proposeFromRecord(
      tx,
      { feedProjectCode: named.feedProjectCode, ourCode: named.ourCode, importId: context.importId, reason: `File ${this.kind} (${this.connectorCode}) line ${context.line}, layout ${this.formatVersion}`, now: this.context.now },
      this.context.actor,
    );
    if (done.outcome === 'PROPOSED') this.written.proposals += 1;
    const label = `${named.feedProjectCode} -> ${named.ourCode}`;
    const found: Difference[] = [];
    if (done.outcome === 'OUR_CODE_UNKNOWN') found.push({ code: FEED_DIFFERENCE_CODES.OUR_CODE_UNKNOWN, expected: named.ourCode, actual: named.feedProjectCode, detail: label });
    else if (done.outcome === 'EXTERNAL_CODE_TAKEN') found.push({ code: FEED_DIFFERENCE_CODES.EXTERNAL_CODE_TAKEN, actual: named.ourCode, detail: label });
    else if (done.outcome === 'SUBJECT_HAS_OTHER_CODE') found.push({ code: FEED_DIFFERENCE_CODES.SUBJECT_HAS_OTHER_CODE, ...(done.heldCode === null ? {} : { expected: done.heldCode }), actual: named.feedProjectCode, detail: label });
    this.written.differences += found.length;
    return found;
  }

  /** The owner of a difference is the person who loaded the file (the fallback of the run): the register has no better answer for a code of the Finance Department. */
  async ownerFor(): Promise<string | undefined> {
    return undefined;
  }
}
