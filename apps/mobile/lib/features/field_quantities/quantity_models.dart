import '../../core/offline/drafts/decimal.dart';
import '../field_evidence/evidence_photos.dart';
import '../field_evidence/field_place.dart';
import '../read_support/wire.dart';
import '../site_diary/contract_models.dart';

/// The command type the queue sends a recorded quantity as (docs/mob-sync.md).
const String kMeasurementRecordCommand = 'measurement.record';

/// What the local draft of a quantity is called in the draft store.
const String kQuantityDraftKind = 'measurement';

const int kQuantityTextMax = 2000;

/// A line of the bill of quantities of the revision in force: the item a quantity is recorded against. `boq_item_id` is shown only
/// to a reader who may record (the server leaves it out for one who may not).
final class BoqItem {
  const BoqItem({required this.lineId, required this.revisionId, required this.businessKey, required this.description, required this.unitCode, required this.quantity, this.itemId});

  final String lineId;
  final String revisionId;
  final String businessKey;
  final String description;
  final String unitCode;

  /// The quantity of the item in the revision, exact decimal text.
  final String quantity;
  final String? itemId;

  String get label => description.isEmpty ? businessKey : '$businessKey · $description';
}

BoqItem? parseBoqItem(Object? raw) {
  final Json? row = asRecord(raw);
  final String? lineId = filled(row?['id']);
  final String? revisionId = filled(row?['contract_revision_id']);
  final String? key = filled(row?['business_key']);
  final String? quantity = filled(row?['quantity']);
  // Only the lines of the revision in force take a quantity.
  if (row == null || lineId == null || revisionId == null || key == null || quantity == null || Decimal.tryParse(quantity) == null || row['revision_status'] != 'EFFECTIVE') return null;
  return BoqItem(
    lineId: lineId,
    revisionId: revisionId,
    businessKey: key,
    description: filled(row['description']) ?? '',
    unitCode: filled(row['unit_code']) ?? '',
    quantity: quantity,
    itemId: filled(row['boq_item_id']),
  );
}

/// A reporting period a quantity belongs to.
final class MeasurePeriod {
  const MeasurePeriod({required this.id, required this.code});

  final String id;
  final String code;
}

MeasurePeriod? parsePeriod(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = filled(row?['code']);
  return id == null || code == null ? null : MeasurePeriod(id: id, code: code);
}

const List<String> kMeasurementStatuses = <String>['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUPERSEDED'];

/// A quantity that was recorded, as the server shows it to the reader.
final class Measurement {
  const Measurement({
    required this.id,
    required this.itemKey,
    required this.periodCode,
    required this.quantityPeriod,
    required this.status,
    required this.version,
    required this.canSubmit,
    required this.remainingQuantity,
    this.itemDescription = '',
    this.unitCode = '',
    this.referenceNo,
    this.evidenceCount = 0,
  });

  final String id;
  final String itemKey;
  final String itemDescription;
  final String unitCode;
  final String periodCode;
  final String quantityPeriod;
  final String status;
  final int version;
  final bool canSubmit;

  /// What is left of the quantity of the item after everything recorded for it.
  final String remainingQuantity;
  final String? referenceNo;
  final int evidenceCount;
}

Measurement? parseMeasurement(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final Json? item = asRecord(row?['boq_item']);
  final String? key = filled(item?['business_key']);
  final String? status = filled(row?['status']);
  final int? version = whole(row?['version']);
  final String? quantity = filled(row?['quantity_period']);
  if (row == null || id == null || key == null || status == null || !kMeasurementStatuses.contains(status) || version == null || quantity == null) return null;
  return Measurement(
    id: id,
    itemKey: key,
    itemDescription: filled(item?['description']) ?? '',
    unitCode: filled(item?['unit_code']) ?? '',
    periodCode: filled(asRecord(row['period'])?['code']) ?? '',
    quantityPeriod: quantity,
    status: status,
    version: version,
    canSubmit: asRecord(row['actions'])?['submit'] == true,
    remainingQuantity: filled(row['remaining_quantity']) ?? '0',
    referenceNo: filled(row['reference_no']),
    evidenceCount: listOf(row['evidence_refs']).length,
  );
}

/// What MOB-63 needs of the server: the contract, the items that take a quantity, the periods (null when the reader may not read
/// them, and then the period is typed as an identifier, as on the web), and the quantities recorded so far.
final class QuantityContext {
  const QuantityContext({required this.contract, required this.items, required this.measurements, this.periods});

  final ContractLine contract;
  final List<BoqItem> items;
  final List<MeasurePeriod>? periods;
  final List<Measurement> measurements;

  /// What is left of the quantity of an item: the figure the server gave on a recorded quantity of it, else the whole quantity.
  String remainingOf(BoqItem item) {
    for (final Measurement measurement in measurements) {
      if (measurement.itemKey == item.businessKey) return measurement.remainingQuantity;
    }
    return item.quantity;
  }
}

QuantityContext? parseQuantityContext(Object? raw) {
  final Json? body = asRecord(raw);
  final ContractLine? contract = parseContract(body?['contract']);
  if (body == null || contract == null || body['lines'] is! List || body['measurements'] is! List) return null;
  final Object? periods = body['periods'];
  return QuantityContext(
    contract: contract,
    items: <BoqItem>[for (final Object? item in listOf(body['lines'])) if (parseBoqItem(item) case final BoqItem line) line],
    periods: periods is List ? <MeasurePeriod>[for (final Object? item in periods) if (parsePeriod(item) case final MeasurePeriod period) period] : null,
    measurements: <Measurement>[for (final Object? item in listOf(body['measurements'])) if (parseMeasurement(item) case final Measurement measurement) measurement],
  );
}

// ------------------------------------------------------------------------------------------------------------- the form

final RegExp _quantityShape = RegExp(r'^(0|[1-9]\d{0,17})(\.\d{1,6})?$');
final RegExp _uuid = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', caseSensitive: false);

/// What the person writes for a quantity. Strings, as typed.
final class QuantityForm {
  const QuantityForm({this.itemLineId = '', this.periodId = '', this.quantity = '', this.referenceNo = '', this.overrideReason = ''});

  final String itemLineId;
  final String periodId;
  final String quantity;
  final String referenceNo;

  /// Said only when the number of the record is already used in the contract.
  final String overrideReason;

  QuantityForm copyWith({String? itemLineId, String? periodId, String? quantity, String? referenceNo, String? overrideReason}) => QuantityForm(
        itemLineId: itemLineId ?? this.itemLineId,
        periodId: periodId ?? this.periodId,
        quantity: quantity ?? this.quantity,
        referenceNo: referenceNo ?? this.referenceNo,
        overrideReason: overrideReason ?? this.overrideReason,
      );

  Map<String, Object?> toJson() => <String, Object?>{'item_line_id': itemLineId, 'period_id': periodId, 'quantity': quantity, 'reference_no': referenceNo, 'override_reason': overrideReason};

  static QuantityForm fromJson(Object? json) {
    if (json is! Map) return const QuantityForm();
    String text(String key) => json[key] is String ? json[key]! as String : '';
    return QuantityForm(itemLineId: text('item_line_id'), periodId: text('period_id'), quantity: text('quantity'), referenceNo: text('reference_no'), overrideReason: text('override_reason'));
  }
}

enum QuantityProblem { required, tooLong, notAQuantity, notPositive, notAnIdentifier }

/// What is wrong with the form, judged on the phone by the rules of the web (CTR-10); the server judges again (the total against the
/// quantity of the item, the period, the reference number). The quantity is exact decimal text of at most six decimals, never a float.
Map<String, QuantityProblem> checkQuantity(QuantityForm form, {required bool periodsKnown}) {
  final Map<String, QuantityProblem> problems = <String, QuantityProblem>{};
  if (form.itemLineId.isEmpty) problems['item'] = QuantityProblem.required;
  final String period = form.periodId.trim();
  if (period.isEmpty) {
    problems['period'] = QuantityProblem.required;
  } else if (!periodsKnown && !_uuid.hasMatch(period)) {
    problems['period'] = QuantityProblem.notAnIdentifier;
  }
  final String quantity = form.quantity.trim();
  if (quantity.isEmpty) {
    problems['quantity'] = QuantityProblem.required;
  } else if (!_quantityShape.hasMatch(quantity)) {
    problems['quantity'] = QuantityProblem.notAQuantity;
  } else if (Decimal.tryParse(quantity)!.isZero) {
    problems['quantity'] = QuantityProblem.notPositive;
  }
  final String reference = form.referenceNo.trim();
  if (reference.isEmpty) {
    problems['reference'] = QuantityProblem.required;
  } else if (reference.runes.length > kQuantityTextMax) {
    problems['reference'] = QuantityProblem.tooLong;
  }
  if (form.overrideReason.trim().runes.length > kQuantityTextMax) problems['override'] = QuantityProblem.tooLong;
  return problems;
}

// -------------------------------------------------------------------------------------------------------- the local draft

/// A quantity as the person is recording it on the phone: kept in the draft store per contract, so it survives the app being closed.
/// The identity of the record (`operationId`) is made with the draft and is the idempotency key of the command, so a send repeated
/// after a lost answer is the same record (UAT-AC358).
final class QuantityDraft {
  const QuantityDraft({required this.contractId, required this.operationId, this.form = const QuantityForm(), this.place = FieldPlace.none, this.photos = const <EvidencePhoto>[], this.commandId});

  final String contractId;
  final String operationId;
  final QuantityForm form;
  final FieldPlace place;
  final List<EvidencePhoto> photos;
  final String? commandId;

  QuantityDraft copyWith({QuantityForm? form, FieldPlace? place, List<EvidencePhoto>? photos, String? operationId, String? commandId, bool clearCommand = false}) => QuantityDraft(
        contractId: contractId,
        operationId: operationId ?? this.operationId,
        form: form ?? this.form,
        place: place ?? this.place,
        photos: photos ?? this.photos,
        commandId: clearCommand ? null : (commandId ?? this.commandId),
      );

  Map<String, Object?> toJson() => <String, Object?>{
        'contract_id': contractId,
        'operation_id': operationId,
        'form': form.toJson(),
        'place': place.toJson(),
        'photos': <Object?>[for (final EvidencePhoto photo in photos) photo.toJson()],
        if (commandId != null) 'command_id': commandId,
      };

  static QuantityDraft? fromJson(Map<String, Object?> json) {
    final Object? contract = json['contract_id'];
    final Object? operation = json['operation_id'];
    if (contract is! String || operation is! String) return null;
    return QuantityDraft(
      contractId: contract,
      operationId: operation,
      form: QuantityForm.fromJson(json['form']),
      place: FieldPlace.fromJson(json['place']),
      photos: EvidencePhoto.listFromJson(json['photos']),
      commandId: json['command_id'] as String?,
    );
  }
}

/// The body of the `measurement.record` command: the body of `recordMeasurement` and the contract it is for (the path). The
/// evidence references are documents of the tenant; a photograph that is only uploaded is not one yet, so the list is empty and the
/// quantity is recorded as a draft that cannot be submitted until evidence is linked (`EVIDENCE_REQUIRED`).
Map<String, Object?> measurementPayload(QuantityDraft draft, BoqItem item) {
  final String override = draft.form.overrideReason.trim();
  return <String, Object?>{
    'contract_id': draft.contractId,
    'contract_revision_id': item.revisionId,
    'boq_item_id': item.itemId,
    'period_id': draft.form.periodId.trim().toLowerCase(),
    'quantity_period': draft.form.quantity.trim(),
    'reference_no': draft.form.referenceNo.trim(),
    if (override.isNotEmpty) 'duplicate_override_reason': override,
    'evidence_refs': <Object?>[],
  };
}
