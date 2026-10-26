import { randomUUID } from 'node:crypto';
import { DomainError, INVENTORY_ITEM_KINDS, assertFourEyes, inventoryAmountVnd, normalizeQuantity, normalizeUnitPrice, versionConflict } from '@machvon/kernel';
import type { InventoryItemKind, InventoryStatus } from '@machvon/kernel';
import { enterScope } from './lnd-household-store.ts';
import type { ScopeUnits } from './lnd-household-store.ts';
import { LndLandSource } from './lnd-land-source.ts';
import { dateOf, lowerId, textOf } from './lnd-values.ts';
import { MasterRules } from './master-rules.ts';
import type { TenantTx } from './tenant-database.ts';

/** The type of the master data of the decisions on land prices (`master_record.master_type`): the key is the reference of the decision, the dates of a version say when it is in force. */
export const PRICE_DECISION_TYPE = 'LND_PRICE_DECISION';
const MAX_UNIT_CODE = 50;
const MAX_DESCRIPTION = 2000;
const MAX_REFERENCE = 100;
const MAX_PAGE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What a household answers when its assets are shown to it: it accepts the count, or it objects. */
export const INVENTORY_OUTCOMES = ['CONFIRMED', 'DISPUTED'] as const;
export type InventoryOutcome = (typeof INVENTORY_OUTCOMES)[number];

export interface NewInventory {
  householdId: string;
  parcelId: string;
  itemKind: string;
  description: string;
  quantity: string;
  unitCode: string;
  unitPriceVnd: string;
  priceDecisionRef: string;
  surveyedOn: string;
  evidencePhotoId?: string | undefined;
  documentVersionId?: string | undefined;
}

/** What recording a record did: ids and the values that are not personal, which is all the audit row and the event may carry (not the description). */
export interface RecordedInventory {
  id: string;
  householdId: string;
  parcelId: string;
  projectId: string;
  ownerUnitId: string;
  itemKind: InventoryItemKind;
  quantity: string;
  unitCode: string;
  unitPriceVnd: string;
  amountVnd: string;
  priceDecisionRef: string;
  priceDecisionVersionId: string;
  priceDecisionRevision: number;
  surveyedOn: string;
  status: 'DRAFT';
  version: number;
}

export interface InventoryAnswer {
  outcome: string;
  householdConfirmedOn: string;
  note?: string | undefined;
}

/** What the answer of the household did to the record and to the household and the parcel it concerns. */
export interface ConfirmedInventory {
  id: string;
  householdId: string;
  parcelId: string;
  projectId: string;
  ownerUnitId: string;
  outcome: InventoryOutcome;
  status: InventoryStatus;
  amountVnd: string;
  householdConfirmedOn: string;
  /** The status of the household after the answer, and whether the answer moved it. */
  householdStatus: string;
  householdMoved: boolean;
  parcelMoved: boolean;
  version: number;
}

export interface InventoryFilter {
  householdId: string;
  status?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/** A record as the screen reads it. The description names what is counted at a household, so it is read only inside the unit of the household. */
export interface InventoryLine {
  id: string;
  householdId: string;
  householdCode: string;
  parcelId: string;
  parcelCode: string;
  ownerUnitId: string;
  itemKind: InventoryItemKind;
  description: string;
  quantity: string;
  unitCode: string;
  unitPriceVnd: string;
  amountVnd: string;
  priceDecisionRef: string;
  priceDecisionRevision: number | null;
  surveyedOn: string;
  surveyedBy: string;
  householdConfirmedOn: string | null;
  householdDispute: boolean;
  confirmedBy: string | null;
  note: string | null;
  evidencePhotoId: string | null;
  documentVersionId: string | null;
  status: InventoryStatus;
  version: number;
}

interface LineSql {
  id: string;
  household_id: string;
  household_code: string;
  parcel_id: string;
  parcel_code: string;
  owner_unit_id: string;
  item_kind: InventoryItemKind;
  description: string;
  quantity: string;
  unit_code: string;
  unit_price_vnd: string;
  amount_vnd: string;
  price_decision_ref: string;
  price_decision_revision: number | null;
  surveyed_on: string;
  surveyed_by: string;
  household_confirmed_on: string | null;
  household_dispute: boolean;
  confirmed_by: string | null;
  note: string | null;
  evidence_photo_id: string | null;
  document_version_id: string | null;
  status: InventoryStatus;
  version: string;
}

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });

/**
 * The inventory of the assets of the affected households (ST-LND-004, LND 3.2, BR-LND-04, UAT-AC382, UAT-PLAN-29). A record counts one kind of asset of a household on a parcel the household holds a right on,
 * at the unit price of a decision on land prices that was in force on the day of the survey (422 `PRICE_DECISION_NOT_EFFECTIVE`); the version of that decision is kept. It is a DRAFT until the household
 * answers it and someone other than the person who counted records the answer (403 `SELF_APPROVAL_DENIED`): confirmed, or disputed, which moves the household to DISPUTED. Only a confirmed record may
 * support a plan. A record belongs to the unit of its household and is seen from inside that unit alone.
 */
export class LndInventoryStore {
  private readonly rules: MasterRules;
  private readonly source: LndLandSource;

  constructor(rules: MasterRules = new MasterRules(), source: LndLandSource = new LndLandSource()) {
    this.rules = rules;
    this.source = source;
  }

  async record(tx: TenantTx, input: NewInventory, actor: string, units: ScopeUnits, today: string): Promise<RecordedInventory> {
    const householdId = lowerId(input.householdId);
    const parcelId = lowerId(input.parcelId);
    const itemKind = INVENTORY_ITEM_KINDS.find((candidate) => candidate === input.itemKind) ?? this.badField('item_kind');
    const description = textOf(input.description, 'description', 1, MAX_DESCRIPTION);
    const quantity = normalizeQuantity(input.quantity);
    const unitCode = textOf(input.unitCode, 'unit_code', 1, MAX_UNIT_CODE);
    const unitPrice = normalizeUnitPrice(input.unitPriceVnd);
    const priceDecisionRef = textOf(input.priceDecisionRef, 'price_decision_ref', 1, MAX_REFERENCE);
    const surveyedOn = dateOf(input.surveyedOn, 'surveyed_on');
    const photoId = input.evidencePhotoId === undefined ? null : lowerId(input.evidencePhotoId);
    const documentId = input.documentVersionId === undefined ? null : lowerId(input.documentVersionId);
    if (photoId !== null && !UUID.test(photoId)) throw invalid('evidence_photo_id');
    if (documentId !== null && !UUID.test(documentId)) throw invalid('document_version_id');
    const amount = inventoryAmountVnd(quantity, unitPrice);
    await enterScope(tx, units);
    // A household outside the scope of the caller is not there for them.
    const household = (await tx.query<{ owner_unit_id: string; project_id: string }>('select owner_unit_id, project_id from machvon.affected_household where id = $1::uuid for update', [householdId]))[0];
    if (household === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const linked = await tx.query('select 1 from machvon.household_parcel where household_id = $1::uuid and parcel_id = $2::uuid', [householdId, parcelId]);
    if (linked.length === 0) throw new DomainError('HOUSEHOLD_PARCEL_NOT_LINKED', 422, 'parcel_id');
    if (surveyedOn > today) throw invalid('surveyed_on', 'IN_THE_FUTURE');
    const decision = await this.rules.read(tx, PRICE_DECISION_TYPE, priceDecisionRef, surveyedOn);
    if (decision === undefined) throw new DomainError('PRICE_DECISION_NOT_EFFECTIVE', 422, 'price_decision_ref');
    if (documentId !== null) await this.source.assertCleanDocumentVersion(tx, documentId, 'document_version_id');
    if (photoId !== null && (await tx.query('select 1 from machvon.site_photo where id = $1::uuid', [photoId])).length === 0) throw invalid('evidence_photo_id', 'NOT_FOUND');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.land_inventory_record
         (tenant_id, id, household_id, parcel_id, owner_unit_id, item_kind, description, quantity, unit_code, unit_price_vnd, amount_vnd, price_decision_ref, price_decision_version_id, price_decision_revision,
          surveyed_on, surveyed_by, evidence_photo_id, document_version_id, status, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::numeric, $8, $9::numeric, $10::numeric, $11, $12::uuid, $13,
               $14::date, $15::uuid, $16::uuid, $17::uuid, 'DRAFT', $15::uuid, $15::uuid, 1)`,
      [id, householdId, parcelId, household.owner_unit_id, itemKind, description, quantity, unitCode, unitPrice, amount, priceDecisionRef, decision.versionId, decision.revision, surveyedOn, actor, photoId, documentId],
    );
    return {
      id,
      householdId,
      parcelId,
      projectId: household.project_id,
      ownerUnitId: household.owner_unit_id,
      itemKind,
      quantity,
      unitCode,
      unitPriceVnd: unitPrice,
      amountVnd: amount,
      priceDecisionRef,
      priceDecisionVersionId: decision.versionId,
      priceDecisionRevision: decision.revision,
      surveyedOn,
      status: 'DRAFT',
      version: 1,
    };
  }

  /**
   * Records the answer of the household to a record, under the version the caller saw (409 `VERSION_CONFLICT`), once (409 `INVENTORY_STATE_INVALID`) and by someone other than the person who counted
   * (403 `SELF_APPROVAL_DENIED`). A confirmation moves the household from REGISTERED to INVENTORIED (and back from DISPUTED when no other record is objected to) and the parcel from SURVEYED to
   * INVENTORIED; an objection needs its note and moves the household to DISPUTED.
   */
  async confirm(tx: TenantTx, id: string, answer: InventoryAnswer, expectedVersion: number, actor: string, units: ScopeUnits, today: string): Promise<ConfirmedInventory> {
    const recordId = lowerId(id);
    const outcome = INVENTORY_OUTCOMES.find((candidate) => candidate === answer.outcome) ?? this.badField('outcome');
    const answeredOn = dateOf(answer.householdConfirmedOn, 'household_confirmed_on');
    const note = answer.note === undefined ? null : textOf(answer.note, 'note', 1, MAX_DESCRIPTION);
    await enterScope(tx, units);
    const record = (
      await tx.query<{ household_id: string; parcel_id: string; owner_unit_id: string; amount_vnd: string; surveyed_on: string; surveyed_by: string; status: InventoryStatus; version: string; project_id: string }>(
        `select r.household_id, r.parcel_id, r.owner_unit_id, r.amount_vnd::text as amount_vnd, r.surveyed_on::text as surveyed_on, r.surveyed_by, r.status, r.version::text as version, h.project_id
           from machvon.land_inventory_record r join machvon.affected_household h on h.tenant_id = r.tenant_id and h.id = r.household_id
          where r.id = $1::uuid for update of r`,
        [recordId],
      )
    )[0];
    // A record outside the scope of the caller is not there for them.
    if (record === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(record.version) !== expectedVersion) throw versionConflict(Number(record.version));
    if (record.status !== 'DRAFT') throw new DomainError('INVENTORY_STATE_INVALID', 409, 'status', { extensions: { status: record.status } });
    assertFourEyes(record.surveyed_by, actor);
    if (answeredOn > today) throw invalid('household_confirmed_on', 'IN_THE_FUTURE');
    if (answeredOn < record.surveyed_on) throw invalid('household_confirmed_on', 'BEFORE_THE_SURVEY');
    if (outcome === 'DISPUTED' && note === null) throw invalid('note', 'REQUIRED_FOR_AN_OBJECTION');
    const version = Number(record.version) + 1;
    await tx.query(
      `update machvon.land_inventory_record
          set status = $2, household_dispute = $3, household_confirmed_on = $4::date, confirmed_by = $5::uuid, confirmed_at = now(), note = $6, updated_at = now(), updated_by = $5::uuid, version = $7
        where id = $1::uuid`,
      [recordId, outcome, outcome === 'DISPUTED', answeredOn, actor, note, version],
    );
    const household = await this.moveHousehold(tx, record.household_id, outcome, recordId, actor);
    const parcelMoved = outcome === 'CONFIRMED' && (await this.moveParcel(tx, record.parcel_id, actor));
    return {
      id: recordId,
      householdId: record.household_id,
      parcelId: record.parcel_id,
      projectId: record.project_id,
      ownerUnitId: record.owner_unit_id,
      outcome,
      status: outcome,
      amountVnd: record.amount_vnd,
      householdConfirmedOn: answeredOn,
      householdStatus: household.status,
      householdMoved: household.moved,
      parcelMoved,
      version,
    };
  }

  /** The records of a household, the lowest parcel code first, inside the scope of the caller. */
  async list(tx: TenantTx, units: ScopeUnits, filter: InventoryFilter): Promise<InventoryLine[]> {
    const householdId = lowerId(filter.householdId);
    if (!UUID.test(householdId)) throw invalid('household_id');
    const status = filter.status === undefined ? null : (['DRAFT', 'CONFIRMED', 'DISPUTED', 'SUPERSEDED'].find((candidate) => candidate === filter.status) ?? this.badField('status'));
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    await enterScope(tx, units);
    const rows = await tx.query<LineSql>(
      `select r.id, r.household_id, h.household_code, r.parcel_id, p.parcel_code, r.owner_unit_id, r.item_kind, r.description, r.quantity::text as quantity, r.unit_code, r.unit_price_vnd::text as unit_price_vnd,
              r.amount_vnd::text as amount_vnd, r.price_decision_ref, r.price_decision_revision, r.surveyed_on::text as surveyed_on, r.surveyed_by, r.household_confirmed_on::text as household_confirmed_on,
              r.household_dispute, r.confirmed_by, r.note, r.evidence_photo_id, r.document_version_id, r.status, r.version::text as version
         from machvon.land_inventory_record r
         join machvon.affected_household h on h.tenant_id = r.tenant_id and h.id = r.household_id
         join machvon.land_parcel p on p.tenant_id = r.tenant_id and p.id = r.parcel_id
        where r.household_id = $1::uuid and ($2::text is null or r.status = $2)
          and ($3::text is null or (p.parcel_code, r.id) > ($3::text, $4::uuid))
        order by p.parcel_code, r.id limit ${filter.limit}`,
      [householdId, status, filter.after?.code ?? null, filter.after?.id ?? null],
    );
    return rows.map((row) => ({
      id: row.id,
      householdId: row.household_id,
      householdCode: row.household_code,
      parcelId: row.parcel_id,
      parcelCode: row.parcel_code,
      ownerUnitId: row.owner_unit_id,
      itemKind: row.item_kind,
      description: row.description,
      quantity: row.quantity,
      unitCode: row.unit_code,
      unitPriceVnd: row.unit_price_vnd,
      amountVnd: row.amount_vnd,
      priceDecisionRef: row.price_decision_ref,
      priceDecisionRevision: row.price_decision_revision,
      surveyedOn: row.surveyed_on,
      surveyedBy: row.surveyed_by,
      householdConfirmedOn: row.household_confirmed_on,
      householdDispute: row.household_dispute,
      confirmedBy: row.confirmed_by,
      note: row.note,
      evidencePhotoId: row.evidence_photo_id,
      documentVersionId: row.document_version_id,
      status: row.status,
      version: Number(row.version),
    }));
  }

  /** The status of the household after the answer: confirmed moves a new household to INVENTORIED, and one that was disputed back when nothing else is; an objection moves it to DISPUTED. */
  private async moveHousehold(tx: TenantTx, householdId: string, outcome: InventoryOutcome, recordId: string, actor: string): Promise<{ status: string; moved: boolean }> {
    const current = (await tx.query<{ status: string }>('select status from machvon.affected_household where id = $1::uuid', [householdId]))[0]?.status ?? '';
    let target = current;
    if (outcome === 'DISPUTED' && ['REGISTERED', 'INVENTORIED', 'PLAN_LISTED'].includes(current)) target = 'DISPUTED';
    if (outcome === 'CONFIRMED' && current === 'REGISTERED') target = 'INVENTORIED';
    if (outcome === 'CONFIRMED' && current === 'DISPUTED') {
      const stillDisputed = await tx.query("select 1 from machvon.land_inventory_record where household_id = $1::uuid and status = 'DISPUTED' and id <> $2::uuid", [householdId, recordId]);
      if (stillDisputed.length === 0) target = 'INVENTORIED';
    }
    if (target === current) return { status: current, moved: false };
    await tx.query('update machvon.affected_household set status = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [householdId, target, actor]);
    return { status: target, moved: true };
  }

  /** A parcel whose first record is confirmed has been inventoried (LND state machine: SURVEYED to INVENTORIED). */
  private async moveParcel(tx: TenantTx, parcelId: string, actor: string): Promise<boolean> {
    const moved = await tx.query("update machvon.land_parcel set status = 'INVENTORIED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid and status = 'SURVEYED' returning id", [parcelId, actor]);
    return moved.length > 0;
  }

  private badField(field: string): never {
    throw invalid(field);
  }
}
