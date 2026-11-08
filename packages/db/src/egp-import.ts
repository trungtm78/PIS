import { randomUUID } from 'node:crypto';
import { EGP_FORMATS, EGP_LAYOUT_VERSION, EGP_POSITIONS, EGP_SOURCE_SYSTEM, egpAcceptance, egpMappingOutcome, egpMappingProposals, vietnamDateOf } from '@machvon/kernel';
import type { Difference, EgpIdMapping, EgpLayoutKind, EgpMappingProposal, EgpRecordByKind, EgpRestrictionRecord, FileImportFormat, SourceRow } from '@machvon/kernel';
import { EgpMappingStore, resolveEgpSubject } from './egp-store.ts';
import type { EgpSubject } from './egp-store.ts';
import type { ApplyContext, ImportEntry } from './file-import-store.ts';
import type { PreviewableAdapter } from './file-import-preview.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
/** The difference an import opens when a mapping it would propose cannot be, or when the register holds what the file cannot be matched to. */
export const EGP_DIFFERENCE_CODES = {
  EXTERNAL_CODE_TAKEN: 'EGP_EXTERNAL_CODE_TAKEN',
  SUBJECT_HAS_OTHER_CODE: 'EGP_SUBJECT_HAS_OTHER_CODE',
  OUR_CODE_UNKNOWN: 'EGP_OUR_CODE_UNKNOWN',
  OUR_CODE_AMBIGUOUS: 'EGP_OUR_CODE_AMBIGUOUS',
  RESTRICTION_FOR_REGISTERED_CONTRACTOR: 'EGP_RESTRICTION_FOR_REGISTERED_CONTRACTOR',
} as const;

/** What the apply of a valid row does (the dry run says it): only the record, the record and a mapping proposed for a person to approve, or the record and a difference for a person to settle. */
export type EgpRowOutcome = 'RECORD' | 'RECORD_AND_PROPOSE' | 'RECORD_AND_DIFFERENCE';

type AnyRecord = EgpRecordByKind[EgpLayoutKind];

type PlannedOutcome = 'CREATE' | 'UNCHANGED' | 'EXTERNAL_CODE_TAKEN' | 'SUBJECT_HAS_OTHER_CODE' | 'OUR_CODE_UNKNOWN' | 'OUR_CODE_AMBIGUOUS' | 'SKIP';

interface PlannedMapping {
  proposal: EgpMappingProposal;
  subject: EgpSubject | null;
  outcome: PlannedOutcome;
  /** The code the subject already holds, for SUBJECT_HAS_OTHER_CODE. */
  heldCode: string | null;
}

/** A legal restriction the apply wrote into the register of contractors, for the audit rows of the command. */
export interface EgpWrittenRestriction {
  restrictionId: string;
  contractorId: string;
  kind: string;
  restrictionCode: string;
  effectiveFrom: string;
  effectiveUntil: string;
}

export interface EgpImportContext {
  actor: string;
  now: Date;
}

/** The restriction kind of the register for the kind of the network's list. */
const REGISTER_KIND: Readonly<Record<string, 'DEBARMENT' | 'WARNING'>> = { DEBARMENT: 'DEBARMENT', REPUTATION_LISTED: 'WARNING' };

/**
 * One kind of file of the national procurement network for the file import framework (EGP-1 part 2, `docs/egp-connector.md`): the layout and the judgement of a row are the pure formats of the kernel
 * (`EGP_FORMATS`, layout `WORKING-ASSUMPTION-2026.2`); this half reads and writes what the register holds. No call goes to the network.
 *
 * The apply of a row, once per business key ever (the framework claims the key):
 *  1. keeps what the file said as a record (`egp_record`, append-only);
 *  2. proposes the mappings the row asks for on `master_crosswalk`, each PROPOSED (the loader is the maker; another person approves on BID-23). A mapping that would break "one code, one subject" or "one
 *     subject, one code" is not written: it becomes a difference with an owner. A row that names a code of ours that is not in the register, or names two rows, is a difference too;
 *  3. a restriction (debarment, reputation listing) for a contractor the register holds is written to the register of restrictions only when the layout is the official one; while it is a working
 *     assumption (PENDING-EXTERNAL) a person records it through BID-21 on its decision, and the difference tells them to.
 * It never links anything by name and never overwrites what the register holds. A valid row is never refused for what the register holds (no `examine`): what cannot be matched is a difference, not a
 * rejection of what the network said.
 */
export class EgpImportAdapter implements PreviewableAdapter<AnyRecord> {
  readonly connectorCode: string;
  readonly formatVersion: string = EGP_LAYOUT_VERSION;
  /** What the apply wrote, for the audit rows and events of the command. */
  readonly written = { records: 0, proposals: [] as string[], restrictions: [] as EgpWrittenRestriction[], differences: 0 };

  private readonly kind: EgpLayoutKind;
  private readonly context: EgpImportContext;
  private readonly format: FileImportFormat<AnyRecord>;
  private readonly mappings = new EgpMappingStore();

  constructor(kind: EgpLayoutKind, context: EgpImportContext) {
    this.kind = kind;
    this.context = context;
    this.connectorCode = EGP_POSITIONS[kind];
    this.format = EGP_FORMATS[kind] as FileImportFormat<AnyRecord>;
  }

  parse = (bytes: Uint8Array): SourceRow[] => this.format.parse(bytes);
  judge = (row: SourceRow): ReturnType<FileImportFormat<AnyRecord>['judge']> => this.format.judge(row);
  mask = (values: Readonly<Record<string, string>>): Record<string, string> => (this.format.mask === undefined ? {} : this.format.mask(values));

  /** Resolves what the row asks for against the register, writing nothing. */
  private async plan(tx: TenantTx, record: AnyRecord): Promise<PlannedMapping[]> {
    const today = vietnamDateOf(this.context.now);
    const planned: PlannedMapping[] = [];
    for (const proposal of egpMappingProposals(this.kind, record)) {
      if (proposal.ourCode === null) {
        planned.push({ proposal, subject: null, outcome: 'SKIP', heldCode: null });
        continue;
      }
      const lookup = await resolveEgpSubject(tx, proposal.subjectType, proposal.ourCode, proposal.ourProjectCode);
      if ('missing' in lookup) {
        // The network lists every contractor of the country: one we never registered is not a difference. A package or a project named by its code and not found is.
        const quiet = lookup.missing === 'NOT_FOUND' && proposal.subjectType === 'CONTRACTOR';
        planned.push({ proposal, subject: null, outcome: quiet ? 'SKIP' : lookup.missing === 'AMBIGUOUS' ? 'OUR_CODE_AMBIGUOUS' : 'OUR_CODE_UNKNOWN', heldCode: null });
        continue;
      }
      const around = await this.mappings.activeAround(tx, proposal.subjectType, lookup.found.id, proposal.externalType, proposal.externalCode);
      const candidate: EgpIdMapping = {
        subjectType: proposal.subjectType,
        subjectId: lookup.found.id,
        sourceSystem: EGP_SOURCE_SYSTEM,
        externalType: proposal.externalType,
        externalCode: proposal.externalCode,
        validFrom: today,
        validUntil: null,
        matchMethod: proposal.method,
        confidence: null,
        status: 'ACTIVE',
      };
      const outcome = egpMappingOutcome(around, candidate);
      if (outcome === 'CREATE') {
        const waiting = await this.mappings.waiting(tx, lookup.found.id, proposal.externalType, proposal.externalCode);
        planned.push({ proposal, subject: lookup.found, outcome: waiting === undefined ? 'CREATE' : 'UNCHANGED', heldCode: null });
      } else {
        const held = outcome === 'SUBJECT_HAS_OTHER_CODE' ? around.find((mapping) => mapping.subjectId === lookup.found.id && mapping.externalType === proposal.externalType) : undefined;
        planned.push({ proposal, subject: lookup.found, outcome, heldCode: held?.externalCode ?? null });
      }
    }
    return planned;
  }

  private differencesOf(planned: readonly PlannedMapping[]): Difference[] {
    const found: Difference[] = [];
    for (const item of planned) {
      const label = `${item.proposal.externalType} ${item.proposal.externalCode}`;
      switch (item.outcome) {
        case 'EXTERNAL_CODE_TAKEN':
          found.push({ code: EGP_DIFFERENCE_CODES.EXTERNAL_CODE_TAKEN, actual: item.proposal.ourCode ?? '', detail: label });
          break;
        case 'SUBJECT_HAS_OTHER_CODE':
          found.push({ code: EGP_DIFFERENCE_CODES.SUBJECT_HAS_OTHER_CODE, ...(item.heldCode === null ? {} : { expected: item.heldCode }), actual: item.proposal.externalCode, detail: `${item.proposal.externalType} ${item.proposal.ourCode ?? ''}` });
          break;
        case 'OUR_CODE_UNKNOWN':
          found.push({ code: EGP_DIFFERENCE_CODES.OUR_CODE_UNKNOWN, expected: item.proposal.ourCode ?? '', actual: item.proposal.externalCode, detail: label });
          break;
        case 'OUR_CODE_AMBIGUOUS':
          found.push({ code: EGP_DIFFERENCE_CODES.OUR_CODE_AMBIGUOUS, expected: item.proposal.ourCode ?? '', actual: item.proposal.externalCode, detail: label });
          break;
        default:
          break;
      }
    }
    // The framework keeps one open item for a row and a kind of difference (a difference met again is the same piece of work), so a row that meets one kind twice (its package and its plan are both unknown)
    // says so in one difference whose detail names both.
    const merged = new Map<string, Difference>();
    for (const difference of found) {
      const earlier = merged.get(difference.code);
      merged.set(difference.code, earlier === undefined ? difference : { ...earlier, detail: [earlier.detail, difference.detail].filter((part): part is string => part !== undefined && part !== '').join(' | ').slice(0, 500) });
    }
    return [...merged.values()];
  }

  /** The contractor of the register a restriction names (by tax id), when the register has exactly one. */
  private async registeredContractor(tx: TenantTx, record: EgpRestrictionRecord): Promise<EgpSubject | undefined> {
    const lookup = await resolveEgpSubject(tx, 'CONTRACTOR', record.contractorTaxCode, null);
    return 'found' in lookup ? lookup.found : undefined;
  }

  /** What the apply would do with the row (the dry run says it). */
  async outcomeOf(tx: TenantTx, entry: ImportEntry<AnyRecord>): Promise<EgpRowOutcome> {
    const planned = await this.plan(tx, entry.record);
    if (this.differencesOf(planned).length > 0) return 'RECORD_AND_DIFFERENCE';
    if (this.kind === 'RESTRICTION' && (await this.registeredContractor(tx, entry.record as EgpRestrictionRecord)) !== undefined) return egpAcceptance(this.formatVersion) === 'ACCEPTABLE' ? 'RECORD' : 'RECORD_AND_DIFFERENCE';
    return planned.some((item) => item.outcome === 'CREATE') ? 'RECORD_AND_PROPOSE' : 'RECORD';
  }

  async apply(tx: TenantTx, entry: ImportEntry<AnyRecord>, context: ApplyContext): Promise<readonly Difference[]> {
    await tx.query(
      `insert into machvon.egp_record (tenant_id, id, kind, business_key, layout_version, import_id, line, row_hash, record, applied_by)
       values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4::uuid, $5, $6, $7::jsonb, $8::uuid)`,
      [this.kind, entry.businessKey, this.formatVersion, context.importId, context.line, context.rowHash, JSON.stringify(entry.record), this.context.actor],
    );
    this.written.records += 1;
    const today = vietnamDateOf(this.context.now);
    const planned = await this.plan(tx, entry.record);
    for (const item of planned) {
      if (item.outcome !== 'CREATE' || item.subject === null) continue;
      const inserted = await this.mappings.insertProposed(
        tx,
        {
          subject: item.subject,
          subjectType: item.proposal.subjectType,
          externalCode: item.proposal.externalCode,
          validFrom: today,
          validUntil: null,
          method: item.proposal.method,
          confidence: null,
          reason: `File ${this.kind} (${this.connectorCode}) line ${context.line}, layout ${this.formatVersion}`,
          importId: context.importId,
        },
        this.context.actor,
      );
      if (inserted !== undefined) this.written.proposals.push(inserted.id);
    }
    const differences = this.differencesOf(planned);
    if (this.kind === 'RESTRICTION') {
      const record = entry.record as EgpRestrictionRecord;
      const contractor = await this.registeredContractor(tx, record);
      if (contractor !== undefined) {
        if (egpAcceptance(this.formatVersion) === 'ACCEPTABLE') {
          const id = randomUUID();
          await tx.query(
            `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, effective_until, note, created_by, updated_by)
             values (${TENANT}, $1::uuid, $2::uuid, $3, 'NATIONAL_E_PROCUREMENT_IMPORT', $4::date, $5::date, $6, $7::uuid, $7::uuid)`,
            // The column of the batch points at the batch of BID-17/19; this file's evidence is its import (`file_import`), which the note names.
            [id, contractor.id, REGISTER_KIND[record.restrictionKind] ?? 'WARNING', record.validFrom, record.validUntil, `EGP ${record.restrictionCode} ${record.decisionNo} import ${context.importId}`.slice(0, 500), this.context.actor],
          );
          this.written.restrictions.push({ restrictionId: id, contractorId: contractor.id, kind: REGISTER_KIND[record.restrictionKind] ?? 'WARNING', restrictionCode: record.restrictionCode, effectiveFrom: record.validFrom, effectiveUntil: record.validUntil });
        } else {
          differences.push({
            code: EGP_DIFFERENCE_CODES.RESTRICTION_FOR_REGISTERED_CONTRACTOR,
            expected: 'NO_RESTRICTION_RECORDED',
            actual: `${record.restrictionKind} ${record.validFrom}..${record.validUntil}`,
            detail: record.restrictionCode,
          });
        }
      }
    }
    this.written.differences += differences.length;
    return differences;
  }

  /** The owner of a difference is the person who loaded the file (the fallback of the run): the register has no better answer for a code of the network. */
  async ownerFor(): Promise<string | undefined> {
    return undefined;
  }
}
