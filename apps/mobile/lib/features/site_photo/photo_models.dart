import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/offline/attachments/attachment_upload.dart';
import '../field_evidence/evidence_photos.dart';
import '../field_evidence/field_place.dart';
import '../field_evidence/photo_checks.dart';
import '../read_support/paged.dart';
import '../read_support/wire.dart';

/// What the photographs taken here are called in the draft store (the record of a capture) and as the owner of their uploads.
const String kSitePhotoKind = 'site_photo';

/// The most a caption may say, as the server takes it (`QmsRegisterSitePhoto.caption`).
const int kCaptionMax = 2000;

enum CaptureProblem { contractRequired, noPhoto, captionTooLong }

/// What the capture lacks before anything is kept: a contract (it gives the project the photographs belong to), at least one
/// photograph and a caption the server takes. A place needs no check here: it exists only with the consent that keeps it.
Map<String, CaptureProblem> checkCapture({required String? contractId, required int photos, required String caption}) {
  final Map<String, CaptureProblem> problems = <String, CaptureProblem>{};
  if (contractId == null || contractId.isEmpty) problems['contract'] = CaptureProblem.contractRequired;
  if (photos == 0) problems['photos'] = CaptureProblem.noPhoto;
  if (caption.trim().runes.length > kCaptionMax) problems['caption'] = CaptureProblem.captionTooLong;
  return problems;
}

/// What the person is told before sending, counted over the photographs: the flags are notes for review and never stop a photograph
/// (QMS 3.4: they do not say a photograph is true or false). The flags of time, zone, repetition and EXIF are given by the server.
final class CaptureFlags {
  const CaptureFlags({required this.photos, required this.placeMissing, required this.timeMissing, required this.duplicates, required this.duplicatesChecked});

  final int photos;
  final int placeMissing;
  final int timeMissing;

  /// Photographs whose file is the same as one already registered for the contract.
  final int duplicates;

  /// Whether the registered photographs of the contract could be read; otherwise the repetition is not known.
  final bool duplicatesChecked;

  bool get hasAny => placeMissing > 0 || timeMissing > 0 || duplicates > 0;
}

CaptureFlags flagsOf(List<EvidencePhoto> photos, FieldPlace place, {required Set<String> duplicateIds, required bool duplicatesChecked}) {
  int placeMissing = 0;
  int timeMissing = 0;
  for (final EvidencePhoto photo in photos) {
    final PhotoChecks checks = checksOf(photo, place);
    if (checks.placeMissing) placeMissing += 1;
    if (checks.timeMissing) timeMissing += 1;
  }
  return CaptureFlags(
    photos: photos.length,
    placeMissing: placeMissing,
    timeMissing: timeMissing,
    duplicates: photos.where((EvidencePhoto photo) => duplicateIds.contains(photo.id)).length,
    duplicatesChecked: duplicatesChecked,
  );
}

/// The SHA-256 of a prepared photograph, in lower-case hex: what makes the same file the same photograph.
Future<String> fileSha256(String path) async => (await sha256.bind(File(path).openRead()).first).toString();

/// The files already registered for a contract, by hash (`get_resources_site_photo`), so a photograph that is there already is flagged.
Future<Json> readRegisteredPhotos(MachvonApiClient client, String contractId) =>
    readMerged(client, 'get_resources_site_photo', query: <String, Object?>{'contract_id': contractId, 'limit': 50}, maxPages: 4);

Set<String>? parseRegisteredHashes(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  return <String>{
    for (final Object? item in listOf(body['items']))
      if (filled(asRecord(item)?['file_sha256']) case final String hash) hash.toLowerCase(),
  };
}

/// A diary of the contract the photographs may be linked to.
final class DiaryOption {
  const DiaryOption({required this.id, required this.recordDate, this.diaryNo = ''});

  final String id;
  final String recordDate;
  final String diaryNo;
}

List<DiaryOption>? parseDiaryOptions(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  final List<DiaryOption> options = <DiaryOption>[];
  for (final Object? item in listOf(body['items'])) {
    final Json? row = asRecord(item);
    final String? id = filled(row?['id']);
    final String? date = day(row?['record_date']);
    if (row == null || id == null || date == null || row['status'] == 'SUPERSEDED') continue;
    options.add(DiaryOption(id: id, recordDate: date, diaryNo: filled(row['diary_no']) ?? ''));
  }
  options.sort((DiaryOption a, DiaryOption b) => b.recordDate.compareTo(a.recordDate));
  return options;
}

/// What the person captured, kept on the phone with the uploads of its photographs: the contract, the diary it is linked to, the
/// caption and the place (only with the consent that keeps it). It is the record a registration in the photo register is made from;
/// until the server hands the phone a key for the file service (see docs/mob-site-photo.md), the photographs wait as clean uploads.
final class PhotoRecord {
  const PhotoRecord({
    required this.operationId,
    required this.contractId,
    required this.contractCode,
    required this.caption,
    required this.place,
    required this.photos,
    this.siteDiaryId,
    this.diaryDate,
  });

  /// The identity of the capture: the owner of its uploads and the `client_operation_id` of its registration.
  final String operationId;
  final String contractId;
  final String contractCode;
  final String? siteDiaryId;
  final String? diaryDate;
  final String caption;
  final FieldPlace place;
  final List<EvidencePhoto> photos;

  Map<String, Object?> toJson() => <String, Object?>{
        'operation_id': operationId,
        'contract_id': contractId,
        'contract_code': contractCode,
        if (siteDiaryId != null) 'site_diary_id': siteDiaryId,
        if (diaryDate != null) 'diary_date': diaryDate,
        'caption': caption,
        'place': place.toJson(),
        'photos': <Object?>[for (final EvidencePhoto photo in photos) photo.toJson()],
      };

  static PhotoRecord? fromJson(Map<String, Object?> json) {
    final Object? operation = json['operation_id'];
    final Object? contract = json['contract_id'];
    if (operation is! String || contract is! String) return null;
    return PhotoRecord(
      operationId: operation,
      contractId: contract,
      contractCode: json['contract_code'] is String ? json['contract_code']! as String : '',
      siteDiaryId: json['site_diary_id'] as String?,
      diaryDate: json['diary_date'] as String?,
      caption: json['caption'] is String ? json['caption']! as String : '',
      place: FieldPlace.fromJson(json['place']),
      photos: EvidencePhoto.listFromJson(json['photos']),
    );
  }
}

/// How the uploads of one capture stand, for the line under it.
final class UploadSummary {
  const UploadSummary({required this.total, required this.clean, required this.waiting, required this.problems});

  final int total;
  final int clean;
  final int waiting;
  final int problems;

  bool get isDone => total > 0 && clean == total;
}

UploadSummary summaryOf(Iterable<AttachmentUpload> uploads, String operationId) {
  int total = 0;
  int clean = 0;
  int waiting = 0;
  int problems = 0;
  for (final AttachmentUpload upload in uploads) {
    if (upload.ownerKind != kSitePhotoKind || upload.ownerRef != operationId || upload.state == UploadState.cancelled) continue;
    total += 1;
    switch (upload.state) {
      case UploadState.clean:
        clean += 1;
      case UploadState.infected:
      case UploadState.failed:
        problems += 1;
      case UploadState.pending:
      case UploadState.uploading:
      case UploadState.scanning:
      case UploadState.cancelled:
        waiting += 1;
    }
  }
  return UploadSummary(total: total, clean: clean, waiting: waiting, problems: problems);
}
