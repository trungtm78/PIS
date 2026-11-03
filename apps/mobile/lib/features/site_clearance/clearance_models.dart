import '../read_support/wire.dart';

/// The kinds of asset an inventory counts (LND 3.2).
const List<String> itemKinds = <String>['LAND', 'HOUSE', 'STRUCTURE', 'CROP', 'TREE', 'GRAVE', 'BUSINESS_LOSS', 'OTHER'];

/// DRAFT waits for the answer of the household; the others are the answer or a later count.
const List<String> inventoryStatuses = <String>['DRAFT', 'CONFIRMED', 'DISPUTED', 'SUPERSEDED'];

const List<String> householdStatuses = <String>['REGISTERED', 'INVENTORIED', 'PLAN_LISTED', 'COMPENSATED', 'RESETTLED', 'CLOSED', 'DISPUTED'];
const List<String> legalBases = <String>['PUBLIC_TASK_LAND_LAW', 'LEGAL_OBLIGATION', 'CONSENT'];
const List<String> rightKinds = <String>['OWNER', 'USER', 'LESSEE', 'OCCUPANT_NO_TITLE'];

// ---- what the phone keeps of a household --------------------------------------------------------------------------------------
//
// A household is personal data (LND 3.5, BR-LND-07; MOB 6; NFR-PRIVACY-01/02). The server already masks the name, the identity
// number, the telephone and the address in a list, but even a masked name is not for a phone: the officer works with the
// household CODE, the parcels it holds a right on, how many people it counts and where its inventory stands. The reader below
// keeps those and nothing else, and it keeps them BEFORE the answer is copied for the offline view, so what is stored on the device
// is the reduced record: no name, no identity number, no telephone, no address, in any form. The identity is opened on the web by
// whoever holds `lnd.pii.read` (`revealHouseholdIdentity`); the phone never asks for it.

/// The parcels a household holds a right on, by their code (a code is a piece of land, not a person).
final class HouseholdParcel {
  const HouseholdParcel({required this.parcelId, required this.parcelCode, this.rightKind});

  final String parcelId;
  final String parcelCode;
  final String? rightKind;
}

/// A household as the phone knows it: a code and the facts the work needs. Nothing identifies a person.
final class Household {
  const Household({
    required this.id,
    required this.code,
    required this.status,
    required this.legalBasis,
    required this.hasConsentRecord,
    required this.restricted,
    required this.anonymised,
    required this.parcels,
    this.memberCount,
  });

  final String id;

  /// The code the unit gave the household (`HH-A-001`): the reference the officer speaks of it by.
  final String code;
  final String status;
  final String legalBasis;

  /// Whether the household's consent is on record (the reference itself is not kept).
  final bool hasConsentRecord;

  /// The household asked that its data not be processed: it is kept and not opened.
  final bool restricted;

  /// The personal data was erased at the request of the household.
  final bool anonymised;
  final List<HouseholdParcel> parcels;
  final int? memberCount;

  /// Whether the household may be worked on at all.
  bool get workable => !restricted && !anonymised;
}

/// The reduced record of a household, from the answer of the server: only the allowed members are copied, so everything else the
/// answer carried (the masked name, identity number, telephone and address among it) is dropped here and never stored.
Json? minimiseHousehold(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = filled(row?['household_code']);
  if (row == null || id == null || code == null) return null;
  return <String, Object?>{
    'id': id,
    'household_code': code,
    'status': row['status'],
    'legal_basis': row['legal_basis'],
    'has_consent_record': filled(row['consent_record_id']) != null,
    'processing_restricted': row['processing_restricted'] == true,
    'anonymised': row['anonymised'] == true,
    'member_count': row['member_count'],
    'parcels': <Object?>[
      for (final Object? parcel in listOf(row['parcels']))
        if (filled(asRecord(parcel)?['parcel_id']) != null && filled(asRecord(parcel)?['parcel_code']) != null)
          <String, Object?>{'parcel_id': asRecord(parcel)!['parcel_id'], 'parcel_code': asRecord(parcel)!['parcel_code'], 'right_kind': asRecord(parcel)!['right_kind']},
    ],
  };
}

Household? parseHousehold(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = filled(row?['household_code']);
  final String? status = householdStatuses.contains(row?['status']) ? row!['status'] as String : null;
  final String? basis = legalBases.contains(row?['legal_basis']) ? row!['legal_basis'] as String : null;
  if (row == null || id == null || code == null || status == null || basis == null) return null;
  return Household(
    id: id,
    code: code,
    status: status,
    legalBasis: basis,
    hasConsentRecord: row['has_consent_record'] == true,
    restricted: row['processing_restricted'] == true,
    anonymised: row['anonymised'] == true,
    memberCount: whole(row['member_count']),
    parcels: <HouseholdParcel>[
      for (final Object? item in listOf(row['parcels']))
        if (filled(asRecord(item)?['parcel_id']) != null && filled(asRecord(item)?['parcel_code']) != null)
          HouseholdParcel(parcelId: asRecord(item)!['parcel_id']! as String, parcelCode: asRecord(item)!['parcel_code']! as String, rightKind: filled(asRecord(item)?['right_kind'])),
    ],
  );
}

/// The households of a project in the scope of the officer.
final class HouseholdRegister {
  const HouseholdRegister({required this.households, required this.more, this.asOf});

  final List<Household> households;

  /// The register has more households than the pages that were read.
  final bool more;
  final String? asOf;

  Household? byId(String id) {
    for (final Household household in households) {
      if (household.id == id) return household;
    }
    return null;
  }
}

/// From `{items: [reduced household], next_cursor, as_of}`.
HouseholdRegister? parseHouseholdRegister(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  final List<Household> households = <Household>[for (final Object? item in listOf(body['items'])) ?parseHousehold(item)];
  households.sort((Household a, Household b) => a.code.compareTo(b.code));
  return HouseholdRegister(households: households, more: filled(body['next_cursor']) != null, asOf: filled(body['as_of']));
}

/// The register reduced: every household through [minimiseHousehold], the paging members kept.
Json minimiseRegister(Json page) => <String, Object?>{
      'items': <Object?>[for (final Object? item in listOf(page['items'])) ?minimiseHousehold(item)],
      'next_cursor': page['next_cursor'],
      'as_of': page['as_of'],
    };

// ---- the inventory --------------------------------------------------------------------------------------------------------------

/// One record of the inventory of a household (`listInventoryRecords`).
final class InventoryRecord {
  const InventoryRecord({
    required this.id,
    required this.version,
    required this.parcelCode,
    required this.itemKind,
    required this.description,
    required this.quantity,
    required this.unitCode,
    required this.unitPriceVnd,
    required this.amountVnd,
    required this.priceDecisionRef,
    required this.surveyedOn,
    required this.surveyedBy,
    required this.status,
    this.householdConfirmedOn,
    this.note,
  });

  final String id;

  /// The version the screen saw: the answer of the household is recorded under it.
  final int version;
  final String parcelCode;
  final String itemKind;
  final String description;
  final String quantity;
  final String unitCode;
  final String unitPriceVnd;

  /// The amount the server computed (`quantity × unit price`, half up to the dong); the phone shows it and never recomputes it.
  final String amountVnd;
  final String priceDecisionRef;
  final String surveyedOn;

  /// The officer who counted: the household's answer is recorded by somebody else.
  final String surveyedBy;
  final String status;
  final String? householdConfirmedOn;
  final String? note;

  bool get isDraft => status == 'DRAFT';
}

InventoryRecord? parseInventoryRecord(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final int? version = whole(row?['version']);
  final String? kind = itemKinds.contains(row?['item_kind']) ? row!['item_kind'] as String : null;
  final String? status = inventoryStatuses.contains(row?['status']) ? row!['status'] as String : null;
  final String? amount = unsignedDong(row?['amount_vnd']);
  final String? price = unsignedDong(row?['unit_price_vnd']);
  final String? surveyedOn = day(row?['surveyed_on']);
  if (row == null || id == null || version == null || kind == null || status == null || amount == null || price == null || surveyedOn == null) return null;
  return InventoryRecord(
    id: id,
    version: version,
    parcelCode: text(row['parcel_code']) ?? '',
    itemKind: kind,
    description: text(row['description']) ?? '',
    quantity: text(row['quantity']) ?? '',
    unitCode: text(row['unit_code']) ?? '',
    unitPriceVnd: price,
    amountVnd: amount,
    priceDecisionRef: text(row['price_decision_ref']) ?? '',
    surveyedOn: surveyedOn,
    surveyedBy: text(row['surveyed_by']) ?? '',
    status: status,
    householdConfirmedOn: day(row['household_confirmed_on']),
    note: filled(row['note']),
  );
}

/// The record reduced to what the task screen shows (the same rule as for a household: the answer is cut down before it is copied).
Json? minimiseRecord(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null) return null;
  const List<String> allowed = <String>[
    'id',
    'version',
    'parcel_code',
    'item_kind',
    'description',
    'quantity',
    'unit_code',
    'unit_price_vnd',
    'amount_vnd',
    'price_decision_ref',
    'surveyed_on',
    'surveyed_by',
    'household_confirmed_on',
    'note',
    'status',
  ];
  return <String, Object?>{for (final String key in allowed) key: row[key]};
}

/// The household with its inventory: what the task screen shows. `records` is read first and answers 404 for a household outside the
/// scope of the officer, so a task that is not theirs is never described.
final class HouseholdTask {
  const HouseholdTask({required this.household, required this.records, this.asOf});

  final Household household;
  final List<InventoryRecord> records;
  final String? asOf;
}

/// From `{household: <reduced household>, records: {items: [...]}, as_of}`.
HouseholdTask? parseHouseholdTask(Object? raw) {
  final Json? body = asRecord(raw);
  final Household? household = parseHousehold(body?['household']);
  final Json? records = asRecord(body?['records']);
  if (body == null || household == null || records == null || records['items'] is! List) return null;
  return HouseholdTask(
    household: household,
    records: <InventoryRecord>[for (final Object? item in listOf(records['items'])) ?parseInventoryRecord(item)],
    asOf: filled(body['as_of']),
  );
}
