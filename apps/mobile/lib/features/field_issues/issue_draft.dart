import 'package:machvon_api_client/machvon_api_client.dart';

import '../field_evidence/annotation.dart';
import '../field_evidence/field_place.dart';

/// The severities of an issue, as the server names them (the same as the web: ISS-02).
const List<String> kSeverities = <String>['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/// The longest title and description the server takes (the same limits as the web).
const int kTitleMax = 200;
const int kDescriptionMax = 2000;

/// What the local draft of an issue is called in the draft store.
const String kIssueDraftKind = 'issue';

/// The command type the queue sends an issue as (docs/mob-sync.md).
const String kIssueCreateCommand = 'issue.create';

/// A photograph attached to the draft: the file that will be uploaded, what the person drew on it, and what was done to it.
final class IssuePhoto {
  const IssuePhoto({
    required this.id,
    required this.path,
    required this.mime,
    required this.bytes,
    this.annotations = AnnotationSet.empty,
    this.originalPath,
    this.sourceHadPlaceOrTime = false,
    this.keepsPlaceOrTime = false,
    this.uploadId,
  });

  final String id;

  /// The prepared file (metadata handled, compressed, marks drawn in) that is uploaded.
  final String path;
  final String mime;
  final int bytes;
  final AnnotationSet annotations;

  /// The photograph as it was taken, kept on the device when the retention policy asks.
  final String? originalPath;
  final bool sourceHadPlaceOrTime;

  /// The file that is uploaded still says where or when: only ever true with the consent of the person.
  final bool keepsPlaceOrTime;

  /// The upload of the prepared file, once it has been handed to the uploader.
  final String? uploadId;

  IssuePhoto withUpload(String id) => IssuePhoto(
    id: this.id,
    path: path,
    mime: mime,
    bytes: bytes,
    annotations: annotations,
    originalPath: originalPath,
    sourceHadPlaceOrTime: sourceHadPlaceOrTime,
    keepsPlaceOrTime: keepsPlaceOrTime,
    uploadId: id,
  );

  IssuePhoto withAnnotations(AnnotationSet next) => IssuePhoto(
    id: id,
    path: path,
    mime: mime,
    bytes: bytes,
    annotations: next,
    originalPath: originalPath,
    sourceHadPlaceOrTime: sourceHadPlaceOrTime,
    keepsPlaceOrTime: keepsPlaceOrTime,
    uploadId: uploadId,
  );

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'path': path,
    'mime': mime,
    'bytes': bytes,
    'annotations': annotations.toJson(),
    if (originalPath != null) 'original_path': originalPath,
    'source_had_place_or_time': sourceHadPlaceOrTime,
    'keeps_place_or_time': keepsPlaceOrTime,
    if (uploadId != null) 'upload_id': uploadId,
  };

  static IssuePhoto? fromJson(Object? json) {
    if (json is! Map) return null;
    final Object? id = json['id'];
    final Object? path = json['path'];
    final Object? mime = json['mime'];
    final Object? bytes = json['bytes'];
    if (id is! String || path is! String || mime is! String || bytes is! int)
      return null;
    return IssuePhoto(
      id: id,
      path: path,
      mime: mime,
      bytes: bytes,
      annotations: AnnotationSet.fromJson(json['annotations']),
      originalPath: json['original_path'] as String?,
      sourceHadPlaceOrTime: json['source_had_place_or_time'] == true,
      keepsPlaceOrTime: json['keeps_place_or_time'] == true,
      uploadId: json['upload_id'] as String?,
    );
  }
}

/// An issue as the person is writing it on the phone (MOB-28 to MOB-30). It is kept as a local draft, so it survives the app
/// being closed, and becomes one `issue.create` command when the person sends it.
final class IssueDraft {
  const IssueDraft({
    required this.clientOperationId,
    this.projectId = '',
    this.projectLabel = '',
    this.ownerUnitId = '',
    this.ownerUnitLabel = '',
    this.categoryVersionId = '',
    this.categoryLabel = '',
    this.severity = 'MEDIUM',
    this.title = '',
    this.description = '',
    this.photos = const <IssuePhoto>[],
    this.place = FieldPlace.none,
  });

  /// The identity of this report for the server: the same value on every send, so a send repeated after a lost answer is the
  /// same issue (UAT-AC355, UAT-PLAN-37).
  final String clientOperationId;
  final String projectId;
  final String projectLabel;
  final String ownerUnitId;
  final String ownerUnitLabel;
  final String categoryVersionId;
  final String categoryLabel;
  final String severity;
  final String title;
  final String description;
  final List<IssuePhoto> photos;
  final FieldPlace place;

  IssueDraft copyWith({
    String? projectId,
    String? projectLabel,
    String? ownerUnitId,
    String? ownerUnitLabel,
    String? categoryVersionId,
    String? categoryLabel,
    String? severity,
    String? title,
    String? description,
    List<IssuePhoto>? photos,
    FieldPlace? place,
  }) => IssueDraft(
    clientOperationId: clientOperationId,
    projectId: projectId ?? this.projectId,
    projectLabel: projectLabel ?? this.projectLabel,
    ownerUnitId: ownerUnitId ?? this.ownerUnitId,
    ownerUnitLabel: ownerUnitLabel ?? this.ownerUnitLabel,
    categoryVersionId: categoryVersionId ?? this.categoryVersionId,
    categoryLabel: categoryLabel ?? this.categoryLabel,
    severity: severity ?? this.severity,
    title: title ?? this.title,
    description: description ?? this.description,
    photos: photos ?? this.photos,
    place: place ?? this.place,
  );

  Map<String, Object?> toJson() => <String, Object?>{
    'client_operation_id': clientOperationId,
    'project_id': projectId,
    'project_label': projectLabel,
    'owner_unit_id': ownerUnitId,
    'owner_unit_label': ownerUnitLabel,
    'category_version_id': categoryVersionId,
    'category_label': categoryLabel,
    'severity': severity,
    'title': title,
    'description': description,
    'photos': <Object?>[for (final IssuePhoto photo in photos) photo.toJson()],
    'place': place.toJson(),
  };

  /// The draft as it was stored; null when it lacks the identity of the report. A photograph that cannot be read is left out.
  static IssueDraft? fromJson(Map<String, Object?> json) {
    final Object? operation = json['client_operation_id'];
    if (operation is! String || operation.isEmpty) return null;
    String text(String key) => json[key] is String ? json[key]! as String : '';
    final Object? photos = json['photos'];
    final String severity = text('severity');
    return IssueDraft(
      clientOperationId: operation,
      projectId: text('project_id'),
      projectLabel: text('project_label'),
      ownerUnitId: text('owner_unit_id'),
      ownerUnitLabel: text('owner_unit_label'),
      categoryVersionId: text('category_version_id'),
      categoryLabel: text('category_label'),
      severity: kSeverities.contains(severity) ? severity : 'MEDIUM',
      title: text('title'),
      description: text('description'),
      photos: <IssuePhoto>[
        if (photos is List)
          for (final Object? item in photos)
            if (IssuePhoto.fromJson(item) case final IssuePhoto photo) photo,
      ],
      place: FieldPlace.fromJson(json['place']),
    );
  }
}

/// What is wrong with a field of the form, judged on the phone (the server judges again).
enum IssueProblem { required, tooLong }

/// The description as the server stores it: the words of the person, then the place typed by hand under its source label. The
/// issue has no field for a place that was not measured, so the label travels with the text and the place is never taken for a
/// reading of the phone (BR-MOB-06).
String composedDescription(
  IssueDraft draft, {
  required String manualPlaceLabel,
}) {
  final String words = draft.description.trim();
  final String? typed = draft.place.source == PlaceSource.manual
      ? draft.place.manualText
      : null;
  if (typed == null || typed.trim().isEmpty) return words;
  return '$words\n\n$manualPlaceLabel: ${typed.trim()}';
}

/// The fields that cannot be sent as they are, by the rules of ISS-02: the project, the unit and the category are chosen, the
/// title and the description are written and not too long (the description counted with the place typed by hand).
Map<String, IssueProblem> checkIssue(
  IssueDraft draft, {
  required String manualPlaceLabel,
}) {
  final Map<String, IssueProblem> problems = <String, IssueProblem>{};
  if (draft.projectId.isEmpty) problems['project'] = IssueProblem.required;
  if (draft.ownerUnitId.isEmpty) problems['unit'] = IssueProblem.required;
  if (draft.categoryVersionId.isEmpty)
    problems['category'] = IssueProblem.required;
  final String title = draft.title.trim();
  if (title.isEmpty) {
    problems['title'] = IssueProblem.required;
  } else if (title.runes.length > kTitleMax) {
    problems['title'] = IssueProblem.tooLong;
  }
  if (draft.description.trim().isEmpty) {
    problems['description'] = IssueProblem.required;
  } else if (composedDescription(
        draft,
        manualPlaceLabel: manualPlaceLabel,
      ).runes.length >
      kDescriptionMax) {
    problems['description'] = IssueProblem.tooLong;
  }
  return problems;
}

/// The body of the `issue.create` command: the body of `createIssue`, built by the generated request so it can only say what the
/// contract allows. A position travels only with the consent that stores it, and `geo_consent` says exactly that: it is true when a
/// position of the phone is sent and false in every other case (consent withheld, permission refused, a place typed by hand), with
/// no coordinates (UAT-AC355).
Map<String, Object?> issuePayload(
  IssueDraft draft, {
  required String manualPlaceLabel,
}) {
  final DevicePosition? position =
      draft.place.consent && draft.place.hasDevicePosition
      ? draft.place.position
      : null;
  return IssCreateIssue(
    projectId: draft.projectId,
    categoryVersionId: draft.categoryVersionId,
    severity: draft.severity,
    title: draft.title.trim(),
    description: composedDescription(draft, manualPlaceLabel: manualPlaceLabel),
    ownerUnitId: draft.ownerUnitId,
    geoConsent: position != null,
    geoLat: position == null ? null : latitudeText(position),
    geoLng: position == null ? null : longitudeText(position),
    geoAccuracyM: position == null ? null : accuracyText(position),
    clientOperationId: draft.clientOperationId,
  ).toJson();
}

/// How one line of the field checklist of MOB-30 stands.
enum CheckStatus { ok, warning, missing }

/// One line of the checklist the person goes through before the report is sent.
final class FieldCheck {
  const FieldCheck(this.id, this.status, {this.blocking = false});

  final String id;
  final CheckStatus status;

  /// A line that stops the report from being sent until it is put right.
  final bool blocking;
}

/// The checklist of MOB-30. The details of the report are required; a photograph and a place are advice (a report with neither
/// is still sent, and says so). A position with an accuracy above [kLowAccuracyMetres] is flagged; a photograph that still says
/// where or when is flagged unless the person consented.
List<FieldCheck> fieldChecklist(
  IssueDraft draft, {
  required String manualPlaceLabel,
}) {
  final Map<String, IssueProblem> problems = checkIssue(
    draft,
    manualPlaceLabel: manualPlaceLabel,
  );
  final bool detailsOk =
      !problems.containsKey('title') && !problems.containsKey('description');
  final bool chosenOk =
      !problems.containsKey('project') &&
      !problems.containsKey('unit') &&
      !problems.containsKey('category');
  final bool leaks =
      draft.photos.any((IssuePhoto photo) => photo.keepsPlaceOrTime) &&
      !draft.place.consent;
  return <FieldCheck>[
    FieldCheck(
      'chosen',
      chosenOk ? CheckStatus.ok : CheckStatus.missing,
      blocking: true,
    ),
    FieldCheck(
      'details',
      detailsOk ? CheckStatus.ok : CheckStatus.missing,
      blocking: true,
    ),
    FieldCheck(
      'photo',
      draft.photos.isEmpty ? CheckStatus.warning : CheckStatus.ok,
    ),
    FieldCheck(
      'place',
      !draft.place.hasPlace
          ? CheckStatus.warning
          : (draft.place.isLowAccuracy ? CheckStatus.warning : CheckStatus.ok),
    ),
    FieldCheck(
      'metadata',
      leaks ? CheckStatus.missing : CheckStatus.ok,
      blocking: true,
    ),
  ];
}

bool canSend(List<FieldCheck> checks) => !checks.any(
  (FieldCheck check) => check.blocking && check.status == CheckStatus.missing,
);
