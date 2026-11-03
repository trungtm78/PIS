import '../field_evidence/evidence_photos.dart';
import '../field_evidence/field_place.dart';
import '../read_support/wire.dart';
import '../site_diary/contract_models.dart';

/// The command type the queue sends the result of an inspection as (docs/mob-sync.md).
const String kInspectionResultCommand = 'inspection.result';

/// What the local draft of an inspection result is called in the draft store.
const String kInspectionDraftKind = 'inspection_result';

const List<String> kResults = <String>['PASS', 'FAIL', 'CONDITIONAL'];
const List<String> kOutcomes = <String>['PASS', 'FAIL', 'NA'];
const int kInspectionTextMax = 2000;

/// An item of the checklist an inspection was given.
final class ChecklistItem {
  const ChecklistItem({required this.code, required this.label});

  final String code;
  final String label;
}

/// An inspection of a contract as the phone needs it: the checklist to answer, and where it stands.
final class Inspection {
  const Inspection({
    required this.id,
    required this.inspectionNo,
    required this.title,
    required this.status,
    required this.checklist,
    required this.canRecord,
    required this.version,
    this.type = '',
    this.result,
    this.locationText,
    this.scheduledAt,
  });

  final String id;
  final String inspectionNo;
  final String title;
  final String status;
  final List<ChecklistItem> checklist;
  final bool canRecord;
  final int version;
  final String type;
  final String? result;
  final String? locationText;
  final String? scheduledAt;

  /// An inspection whose result is still to be written, by a reader the server lets record it.
  bool get isOpen => status == 'SCHEDULED' && canRecord;

  /// An acceptance can be asked for from an inspection that passed, or that passed with conditions.
  bool get mayRequestAcceptance => status == 'RESULT_RECORDED' && (result == 'PASS' || result == 'CONDITIONAL');

  /// The scope of the acceptance this inspection leads to (QMS 5): the stage, the part and the completion have their own inspections;
  /// every other kind accepts a work item.
  String get acceptanceScope {
    switch (type) {
      case 'CONSTRUCTION_STAGE':
        return 'STAGE';
      case 'PART_ACCEPTANCE':
        return 'PART';
      case 'COMPLETION':
        return 'COMPLETION';
      default:
        return 'WORK_ITEM';
    }
  }
}

Inspection? parseInspection(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? status = filled(row?['status']);
  final int? version = whole(row?['version']);
  if (row == null || id == null || status == null || version == null) return null;
  final Json? actions = asRecord(row['actions']);
  return Inspection(
    id: id,
    inspectionNo: filled(row['inspection_no']) ?? '',
    title: filled(row['title']) ?? '',
    status: status,
    checklist: <ChecklistItem>[
      for (final Object? item in listOf(row['checklist']))
        if (filled(asRecord(item)?['code']) case final String code) ChecklistItem(code: code, label: filled(asRecord(item)?['label']) ?? code),
    ],
    canRecord: actions?['record'] == true,
    version: version,
    type: filled(row['inspection_type']) ?? '',
    result: filled(row['result']),
    locationText: filled(row['location_text']),
    scheduledAt: filled(row['scheduled_at']),
  );
}

/// A non-conformance, as far as the inspection screen shows it: raised by a failed item, and whether it blocks the acceptance.
final class Nonconformance {
  const Nonconformance({required this.id, required this.ncrNo, required this.title, required this.severity, required this.status, required this.blocksAcceptance, this.inspectionId});

  final String id;
  final String ncrNo;
  final String title;
  final String severity;
  final String status;
  final bool blocksAcceptance;
  final String? inspectionId;

  bool get isOpen => status != 'CLOSED' && status != 'VERIFIED';
}

Nonconformance? parseNonconformance(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? severity = filled(row?['severity']);
  final String? status = filled(row?['status']);
  if (row == null || id == null || severity == null || status == null) return null;
  return Nonconformance(
    id: id,
    ncrNo: filled(row['ncr_no']) ?? '',
    title: filled(row['title']) ?? '',
    severity: severity,
    status: status,
    blocksAcceptance: row['blocks_acceptance'] == true,
    inspectionId: filled(row['inspection_id']),
  );
}

/// What MOB-64 needs of the server: the contract, its inspections, and its non-conformances.
final class InspectionContext {
  const InspectionContext({required this.contract, required this.inspections, required this.nonconformances});

  final ContractLine contract;
  final List<Inspection> inspections;
  final List<Nonconformance> nonconformances;

  List<Nonconformance> raisedBy(String inspectionId) => <Nonconformance>[for (final Nonconformance ncr in nonconformances) if (ncr.inspectionId == inspectionId) ncr];
}

InspectionContext? parseInspectionContext(Object? raw) {
  final Json? body = asRecord(raw);
  final ContractLine? contract = parseContract(body?['contract']);
  if (body == null || contract == null || body['inspections'] is! List || body['nonconformances'] is! List) return null;
  return InspectionContext(
    contract: contract,
    inspections: <Inspection>[for (final Object? item in listOf(body['inspections'])) if (parseInspection(item) case final Inspection inspection) inspection],
    nonconformances: <Nonconformance>[for (final Object? item in listOf(body['nonconformances'])) if (parseNonconformance(item) case final Nonconformance ncr) ncr],
  );
}

// ------------------------------------------------------------------------------------------------------------- the form

/// The answer to one item of the checklist.
final class ItemAnswer {
  const ItemAnswer({this.outcome = '', this.note = ''});

  final String outcome;
  final String note;

  ItemAnswer copyWith({String? outcome, String? note}) => ItemAnswer(outcome: outcome ?? this.outcome, note: note ?? this.note);
}

/// What the inspector writes: an answer for each item, the overall result and the words that go with it.
final class ResultForm {
  const ResultForm({this.answers = const <String, ItemAnswer>{}, this.result = '', this.resultNote = ''});

  final Map<String, ItemAnswer> answers;
  final String result;
  final String resultNote;

  ItemAnswer answerOf(String code) => answers[code] ?? const ItemAnswer();

  ResultForm withAnswer(String code, ItemAnswer answer) => ResultForm(answers: <String, ItemAnswer>{...answers, code: answer}, result: result, resultNote: resultNote);

  ResultForm copyWith({String? result, String? resultNote}) => ResultForm(answers: answers, result: result ?? this.result, resultNote: resultNote ?? this.resultNote);

  Map<String, Object?> toJson() => <String, Object?>{
        'answers': <String, Object?>{for (final MapEntry<String, ItemAnswer> entry in answers.entries) entry.key: <String, Object?>{'outcome': entry.value.outcome, 'note': entry.value.note}},
        'result': result,
        'result_note': resultNote,
      };

  static ResultForm fromJson(Object? json) {
    if (json is! Map) return const ResultForm();
    final Object? raw = json['answers'];
    return ResultForm(
      answers: <String, ItemAnswer>{
        if (raw is Map)
          for (final MapEntry<Object?, Object?> entry in raw.entries)
            if (entry.key is String && entry.value is Map) entry.key! as String: ItemAnswer(outcome: (entry.value! as Map)['outcome'] is String ? (entry.value! as Map)['outcome']! as String : '', note: (entry.value! as Map)['note'] is String ? (entry.value! as Map)['note']! as String : ''),
      },
      result: json['result'] is String ? json['result']! as String : '',
      resultNote: json['result_note'] is String ? json['result_note']! as String : '',
    );
  }
}

enum ResultProblem { unanswered, required, tooLong, contradiction, noInspection }

/// What is wrong with the form, judged on the phone by the rules of the web (QMS-04); the server judges again. Every item is
/// answered once; a PASS has no failed item; a FAIL or a CONDITIONAL has at least one; a CONDITIONAL says its condition in the note
/// of each failed item. Keys: `result`, `resultNote`, `whole`, and `answer:<code>`.
Map<String, ResultProblem> checkResult(ResultForm form, List<ChecklistItem> items) {
  final Map<String, ResultProblem> problems = <String, ResultProblem>{};
  if (items.isEmpty) problems['whole'] = ResultProblem.noInspection;
  int failed = 0;
  for (final ChecklistItem item in items) {
    final ItemAnswer answer = form.answerOf(item.code);
    if (!kOutcomes.contains(answer.outcome)) {
      problems['answer:${item.code}'] = ResultProblem.unanswered;
    } else if (answer.outcome == 'FAIL') {
      failed += 1;
      if (form.result == 'CONDITIONAL' && answer.note.trim().isEmpty) problems['answer:${item.code}'] = ResultProblem.required;
    }
    if (answer.note.trim().runes.length > kInspectionTextMax) problems['answer:${item.code}'] = ResultProblem.tooLong;
  }
  if (!kResults.contains(form.result)) {
    problems['result'] = ResultProblem.required;
  } else if (form.result == 'PASS' && failed > 0) {
    problems['whole'] = ResultProblem.contradiction;
  } else if (form.result != 'PASS' && failed == 0 && items.isNotEmpty) {
    problems['whole'] = ResultProblem.contradiction;
  }
  final String note = form.resultNote.trim();
  if (note.isEmpty) {
    problems['resultNote'] = ResultProblem.required;
  } else if (note.runes.length > kInspectionTextMax) {
    problems['resultNote'] = ResultProblem.tooLong;
  }
  return problems;
}

/// The body of the `inspection.result` command: the body of `recordInspectionResult` and the inspection it is for (the path).
Map<String, Object?> resultPayload(String inspectionId, ResultForm form, List<ChecklistItem> items) => <String, Object?>{
      'inspection_id': inspectionId,
      'result': form.result,
      'result_note': form.resultNote.trim(),
      'checklist': <Object?>[
        for (final ChecklistItem item in items)
          <String, Object?>{'code': item.code, 'outcome': form.answerOf(item.code).outcome, if (form.answerOf(item.code).note.trim().isNotEmpty) 'note': form.answerOf(item.code).note.trim()},
      ],
    };

/// A result as the inspector is writing it on the phone, kept in the draft store per inspection. The identity of the record is the
/// key of the command.
final class ResultDraft {
  const ResultDraft({required this.contractId, required this.inspectionId, required this.operationId, this.form = const ResultForm(), this.place = FieldPlace.none, this.photos = const <EvidencePhoto>[]});

  final String contractId;
  final String inspectionId;
  final String operationId;
  final ResultForm form;
  final FieldPlace place;
  final List<EvidencePhoto> photos;

  ResultDraft copyWith({ResultForm? form, FieldPlace? place, List<EvidencePhoto>? photos, String? operationId}) =>
      ResultDraft(contractId: contractId, inspectionId: inspectionId, operationId: operationId ?? this.operationId, form: form ?? this.form, place: place ?? this.place, photos: photos ?? this.photos);

  Map<String, Object?> toJson() => <String, Object?>{
        'contract_id': contractId,
        'inspection_id': inspectionId,
        'operation_id': operationId,
        'form': form.toJson(),
        'place': place.toJson(),
        'photos': <Object?>[for (final EvidencePhoto photo in photos) photo.toJson()],
      };

  static ResultDraft? fromJson(Map<String, Object?> json) {
    final Object? contract = json['contract_id'];
    final Object? inspection = json['inspection_id'];
    final Object? operation = json['operation_id'];
    if (contract is! String || inspection is! String || operation is! String) return null;
    return ResultDraft(
      contractId: contract,
      inspectionId: inspection,
      operationId: operation,
      form: ResultForm.fromJson(json['form']),
      place: FieldPlace.fromJson(json['place']),
      photos: EvidencePhoto.listFromJson(json['photos']),
    );
  }
}
