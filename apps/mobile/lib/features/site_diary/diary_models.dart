import '../field_evidence/evidence_photos.dart';
import '../field_evidence/field_place.dart';
import '../read_support/moment.dart';
import '../read_support/wire.dart';
import 'contract_models.dart';

/// The command type the queue sends a diary as (docs/mob-sync.md): a new draft of the day, or a revision of the draft that exists
/// when the payload names `diary_id`.
const String kDiaryAppendCommand = 'site_diary.append';

/// What the local draft of a diary is called in the draft store.
const String kDiaryDraftKind = 'site_diary';

const List<String> kDiaryStatuses = <String>[
  'DRAFT',
  'CONTRACTOR_SIGNED',
  'SUPERVISED',
  'OWNER_CONFIRMED',
  'LOCKED',
  'SUPERSEDED',
];

/// The weather the form offers; the server takes any code of the same shape.
const List<String> kWeatherCodes = <String>[
  'SUNNY',
  'CLOUDY',
  'RAIN',
  'HEAVY_RAIN',
  'STORM',
  'HOT',
  'COLD',
];

/// The limits of the form, the same as the web (QMS-02).
const int kDiaryTextMax = 8000;
const int kWorkItemMax = 200;
const int kWorkItemsMax = 50;

/// A signature on a diary. One that is not over the hash the diary carries is void.
final class DiarySignature {
  const DiarySignature({
    required this.role,
    required this.signerName,
    required this.method,
    required this.signedAt,
    required this.valid,
  });

  final String role;
  final String signerName;
  final String method;
  final String signedAt;
  final bool valid;
}

/// One diary of a contract and a day, as the server shows it to the reader: the content, who signed, and what the reader may do
/// with it (the server computes `actions` and `signable_roles` for the caller; the screen offers exactly these and the server
/// judges each command again).
final class DiaryRecord {
  const DiaryRecord({
    required this.id,
    required this.diaryNo,
    required this.contractId,
    required this.recordDate,
    required this.status,
    required this.content,
    required this.version,
    required this.signatures,
    required this.signableRoles,
    required this.canRevise,
    required this.canSign,
    required this.canCorrect,
    required this.pendingConflicts,
    this.supervisorRemark,
    this.correctionOfId,
    this.correctionReason,
    this.awaitingConfirmation = true,
  });

  final String id;
  final String diaryNo;
  final String contractId;
  final String recordDate;
  final String status;
  final Json content;
  final int version;
  final List<DiarySignature> signatures;
  final List<String> signableRoles;
  final bool canRevise;
  final bool canSign;
  final bool canCorrect;

  /// Copies that devices left for this diary which nobody has settled.
  final int pendingConflicts;
  final String? supervisorRemark;
  final String? correctionOfId;
  final String? correctionReason;

  /// The value of an in-app signature is not settled by the business yet (CXN-EXE-05); the screen never says more than it was told.
  final bool awaitingConfirmation;

  /// The diary can still be written over: only a draft, and only by a reader the server lets revise it.
  bool get isEditable => status == 'DRAFT' && canRevise;

  /// The contractor has signed (or a later role has): the content cannot change; a correction is a new revision.
  bool get isSigned => status != 'DRAFT';

  bool get isCorrection => correctionOfId != null;
}

DiarySignature? _signature(Object? raw) {
  final Json? row = asRecord(raw);
  final String? role = filled(row?['role']);
  final String? method = filled(row?['method']);
  final String? signedAt = filled(row?['signed_at']);
  if (row == null || role == null || method == null || signedAt == null)
    return null;
  return DiarySignature(
    role: role,
    signerName: filled(row['signer_name']) ?? '',
    method: method,
    signedAt: signedAt,
    valid: row['valid'] == true,
  );
}

DiaryRecord? parseDiary(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final Json? contract = asRecord(row?['contract']);
  final String? contractId = filled(contract?['id']);
  final String? status = filled(row?['status']);
  final String? date = day(row?['record_date']);
  final int? version = whole(row?['version']);
  final Json? actions = asRecord(row?['actions']);
  if (row == null ||
      id == null ||
      contractId == null ||
      status == null ||
      !kDiaryStatuses.contains(status) ||
      date == null ||
      version == null ||
      actions == null)
    return null;
  final Json? value = asRecord(row['signature_value']);
  return DiaryRecord(
    id: id,
    diaryNo: filled(row['diary_no']) ?? '',
    contractId: contractId,
    recordDate: date,
    status: status,
    content: asRecord(row['content']) ?? const <String, Object?>{},
    version: version,
    signatures: <DiarySignature>[
      for (final Object? item in listOf(row['signatures']))
        if (_signature(item) case final DiarySignature signature) signature,
    ],
    signableRoles: <String>[
      for (final Object? role in listOf(row['signable_roles']))
        if (role is String) role,
    ],
    canRevise: actions['revise'] == true,
    canSign: actions['contractorSign'] == true,
    canCorrect: actions['correct'] == true,
    pendingConflicts: listOf(row['conflicts'])
        .where((Object? copy) => asRecord(copy)?['state'] == 'CONFLICT_PENDING')
        .length,
    supervisorRemark: filled(row['supervisor_remark']),
    correctionOfId: filled(row['correction_of_id']),
    correctionReason: filled(row['correction_reason']),
    awaitingConfirmation: value?['awaiting_confirmation'] != false,
  );
}

/// The contract and the diary of one day, read together: the diary of the day is the one that is not set aside (a correction
/// replaces the diary it corrects).
final class DiaryDay {
  const DiaryDay({required this.contract, this.diary});

  final ContractLine contract;
  final DiaryRecord? diary;
}

DiaryDay? parseDiaryDay(Object? raw) {
  final Json? body = asRecord(raw);
  final ContractLine? contract = parseContract(body?['contract']);
  if (body == null || contract == null || body['diaries'] is! List) return null;
  final List<DiaryRecord> records = <DiaryRecord>[
    for (final Object? item in listOf(body['diaries']))
      if (parseDiary(item) case final DiaryRecord record) record,
  ].where((DiaryRecord record) => record.status != 'SUPERSEDED').toList();
  // A correction (a revision of a locked diary) is the diary of the day while the diary it corrects is locked: the newest wins.
  records.sort(
    (DiaryRecord a, DiaryRecord b) => b.version.compareTo(a.version),
  );
  return DiaryDay(
    contract: contract,
    diary: records.isEmpty ? null : records.first,
  );
}

// ------------------------------------------------------------------------------------------------------------- the form

/// What the person writes for a day. Strings, as typed.
final class DiaryForm {
  const DiaryForm({
    this.summary = '',
    this.workItems = '',
    this.weatherCode = '',
    this.workforce = '',
    this.notes = '',
  });

  final String summary;

  /// The work of the day, one item to a line.
  final String workItems;
  final String weatherCode;
  final String workforce;
  final String notes;

  DiaryForm copyWith({
    String? summary,
    String? workItems,
    String? weatherCode,
    String? workforce,
    String? notes,
  }) => DiaryForm(
    summary: summary ?? this.summary,
    workItems: workItems ?? this.workItems,
    weatherCode: weatherCode ?? this.weatherCode,
    workforce: workforce ?? this.workforce,
    notes: notes ?? this.notes,
  );

  /// What a diary that exists says, as the form shows it. A field the form cannot show as it is (a list of notes, say) stays
  /// in the content and is signed with it.
  static DiaryForm of(DiaryRecord record) {
    final Object? summary = record.content['summary'];
    final Object? notes = record.content['notes'];
    final Object? weather = record.content['weather_code'];
    final Object? workforce = record.content['workforce_count'];
    final Object? items = record.content['work_items'];
    return DiaryForm(
      summary: summary is String ? summary : '',
      workItems: items is List ? items.whereType<String>().join('\n') : '',
      weatherCode: weather is String ? weather : '',
      workforce: workforce is int ? '$workforce' : '',
      notes: notes is String ? notes : '',
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'summary': summary,
    'work_items': workItems,
    'weather_code': weatherCode,
    'workforce': workforce,
    'notes': notes,
  };

  static DiaryForm fromJson(Object? json) {
    if (json is! Map) return const DiaryForm();
    String text(String key) => json[key] is String ? json[key]! as String : '';
    return DiaryForm(
      summary: text('summary'),
      workItems: text('work_items'),
      weatherCode: text('weather_code'),
      workforce: text('workforce'),
      notes: text('notes'),
    );
  }
}

/// The lines of the work items as typed: trimmed, the empty ones left out.
List<String> workItemsOf(String text) => <String>[
  for (final String line in text.split('\n'))
    if (line.trim().isNotEmpty) line.trim(),
];

enum DiaryProblem {
  required,
  tooLong,
  invalidNumber,
  futureDay,
  invalidDay,
  tooManyItems,
}

final RegExp _weatherShape = RegExp(r'^[A-Z][A-Z0-9_]{1,19}$');

/// What is wrong with the form, judged on the phone by the rules of the web (QMS-02); the server judges again. [today] is the
/// calendar day in Vietnam; it only stops a diary being written for a day that has not come, the server decides the rest.
Map<String, DiaryProblem> checkDiary(
  DiaryForm form, {
  required String recordDate,
  required String today,
}) {
  final Map<String, DiaryProblem> problems = <String, DiaryProblem>{};
  final DateTime? parsed = DateTime.tryParse('${recordDate}T00:00:00Z');
  if (day(recordDate) == null ||
      parsed == null ||
      vietnamDayOf(parsed) != recordDate) {
    problems['date'] = DiaryProblem.invalidDay;
  } else if (recordDate.compareTo(today) > 0) {
    problems['date'] = DiaryProblem.futureDay;
  }
  final String summary = form.summary.trim();
  if (summary.isEmpty) {
    problems['summary'] = DiaryProblem.required;
  } else if (summary.runes.length > kDiaryTextMax) {
    problems['summary'] = DiaryProblem.tooLong;
  }
  if (form.notes.runes.length > kDiaryTextMax)
    problems['notes'] = DiaryProblem.tooLong;
  final List<String> items = workItemsOf(form.workItems);
  if (items.length > kWorkItemsMax) {
    problems['workItems'] = DiaryProblem.tooManyItems;
  } else if (items.any((String item) => item.runes.length > kWorkItemMax)) {
    problems['workItems'] = DiaryProblem.tooLong;
  }
  if (form.weatherCode.isNotEmpty && !_weatherShape.hasMatch(form.weatherCode))
    problems['weather'] = DiaryProblem.invalidNumber;
  if (form.workforce.trim().isNotEmpty &&
      !RegExp(r'^\d{1,7}$').hasMatch(form.workforce.trim()))
    problems['workforce'] = DiaryProblem.invalidNumber;
  return problems;
}

/// The content that goes to the server: what the form says over what the diary already held (the other fields, written by another
/// client, are kept as they were and signed with the rest). An empty field is taken out, not sent as an empty text. The place of
/// the phone goes in only with the consent that keeps it (UAT-AC367); the server refuses a place without `geo_consent: true`.
Json contentOf(
  DiaryForm form, {
  Json base = const <String, Object?>{},
  FieldPlace place = FieldPlace.none,
}) {
  final Json content = <String, Object?>{...base};
  content['summary'] = form.summary.trim();
  void optional(String key, Object? value) {
    if (value == null ||
        (value is String && value.isEmpty) ||
        (value is List && value.isEmpty)) {
      content.remove(key);
    } else {
      content[key] = value;
    }
  }

  optional('work_items', workItemsOf(form.workItems));
  optional('weather_code', form.weatherCode);
  optional(
    'workforce_count',
    form.workforce.trim().isEmpty ? null : int.parse(form.workforce.trim()),
  );
  optional('notes', form.notes.trim());
  content.remove('location');
  content.remove('geo_consent');
  final DevicePosition? position = place.consent && place.hasDevicePosition
      ? place.position
      : null;
  if (position != null) {
    content['geo_consent'] = true;
    content['location'] = <String, Object?>{
      'lat': double.parse(latitudeText(position)),
      'lng': double.parse(longitudeText(position)),
      'accuracy_m': double.parse(accuracyText(position)),
    };
  }
  return content;
}

// -------------------------------------------------------------------------------------------------------- the local draft

/// A diary as the person is writing it on the phone: kept in the draft store per contract and day, so it survives the app being
/// closed. The identity of the save (`operationId`) is made when the draft is created and again after a save has been settled, so
/// a send repeated after a lost answer is the same save.
final class DiaryDraft {
  const DiaryDraft({
    required this.contractId,
    required this.recordDate,
    required this.operationId,
    this.form = const DiaryForm(),
    this.place = FieldPlace.none,
    this.photos = const <EvidencePhoto>[],
    this.commandId,
    this.edited = false,
  });

  final String contractId;
  final String recordDate;
  final String operationId;
  final DiaryForm form;
  final FieldPlace place;
  final List<EvidencePhoto> photos;

  /// Written on the phone after the last save was queued: the command of that save does not stand for this content, so the
  /// command being taken by the server does not settle the draft.
  final bool edited;

  /// The queued command of the last save, while it is not settled.
  final String? commandId;

  DiaryDraft copyWith({
    DiaryForm? form,
    FieldPlace? place,
    List<EvidencePhoto>? photos,
    String? operationId,
    String? commandId,
    bool clearCommand = false,
    bool? edited,
  }) => DiaryDraft(
    contractId: contractId,
    recordDate: recordDate,
    operationId: operationId ?? this.operationId,
    form: form ?? this.form,
    place: place ?? this.place,
    photos: photos ?? this.photos,
    commandId: clearCommand ? null : (commandId ?? this.commandId),
    edited: edited ?? this.edited,
  );

  Map<String, Object?> toJson() => <String, Object?>{
    'contract_id': contractId,
    'record_date': recordDate,
    'operation_id': operationId,
    'form': form.toJson(),
    'place': place.toJson(),
    'photos': <Object?>[
      for (final EvidencePhoto photo in photos) photo.toJson(),
    ],
    if (commandId != null) 'command_id': commandId,
    if (edited) 'edited': true,
  };

  static DiaryDraft? fromJson(Map<String, Object?> json) {
    final Object? contract = json['contract_id'];
    final Object? date = json['record_date'];
    final Object? operation = json['operation_id'];
    if (contract is! String || date is! String || operation is! String)
      return null;
    return DiaryDraft(
      contractId: contract,
      recordDate: date,
      operationId: operation,
      form: DiaryForm.fromJson(json['form']),
      place: FieldPlace.fromJson(json['place']),
      photos: EvidencePhoto.listFromJson(json['photos']),
      commandId: json['command_id'] as String?,
      edited: json['edited'] == true,
    );
  }
}

/// The body of the `site_diary.append` command. A diary that exists on the server is written over under the version that was read
/// (the revision of its draft, `If-Match`), so a second editor who read the same version is refused with `VERSION_CONFLICT` and
/// decides in MOB-42; a day with no diary yet is a new draft of the contract and the day.
Json diaryPayload(DiaryDraft draft, {DiaryRecord? over}) {
  final Json content = contentOf(
    draft.form,
    base: over?.content ?? const <String, Object?>{},
    place: draft.place,
  );
  if (over != null)
    return <String, Object?>{
      'diary_id': over.id,
      'content': content,
      'client_operation_id': draft.operationId,
    };
  return <String, Object?>{
    'contract_id': draft.contractId,
    'record_date': draft.recordDate,
    'client_operation_id': draft.operationId,
    'content': content,
  };
}
