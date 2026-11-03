import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/offline/attachments/attachment_upload.dart';
import '../../core/offline/attachments/attachment_uploader.dart';
import '../../core/offline/drafts/draft_store.dart';
import '../../core/offline/drafts/local_draft.dart';
import '../../core/offline/offline_providers.dart';
import '../field_evidence/evidence_photos.dart';
import 'photo_models.dart';

/// A capture kept on the phone with its id in the draft store.
final class StoredCapture {
  const StoredCapture({required this.id, required this.record});

  final String id;
  final PhotoRecord record;
}

/// The local work of QMS-10: the capture is kept in the encrypted store (the contract, the diary, the caption and, only with the
/// consent, the place), and its photographs are handed to the uploader once each, so they go up in chunks when there is a network, are
/// scanned, and wait as clean uploads. Nothing here talks to the network: the uploader does, when the network is there.
class SitePhotoService {
  SitePhotoService(this._ref);

  final Ref _ref;

  Future<DraftStore> get _drafts => _ref.read(draftStoreProvider.future);

  /// Keeps the capture and hands its photographs to the uploader. What the consent does not allow is taken out of the photographs
  /// first, so no coordinate is written to the phone, or sent, without it (BR-MOB-06, UAT-AC367). A hand-over cut between two
  /// photographs is resumed by the next call with the same operation id: a photograph already handed over is never handed over twice.
  Future<PhotoRecord> keep(PhotoRecord capture) async {
    final DraftStore drafts = await _drafts;
    final AttachmentUploader uploader = await _ref.read(attachmentUploaderProvider.future);
    final LocalDraft? earlier = _find(drafts, capture.operationId);
    // The screen sends again what it holds: the photographs as they were taken, without the uploads an earlier, cut call gave them.
    // Those uploads are in the record that was kept, and writing the screen's photographs over it would forget them and hand the same
    // files over a second time.
    final List<EvidencePhoto> clean = _withKnownUploads(await enforcePhotoConsent(capture.photos, consent: capture.place.consent), earlier, uploader);
    PhotoRecord record = _with(capture, clean);
    final String? existing = earlier?.id;
    final String id = drafts.save(id: existing, kind: kSitePhotoKind, fields: record.toJson(), recordId: record.contractId).id;
    final List<EvidencePhoto> handed = await handOverPhotos(
      uploader,
      clean,
      ownerKind: kSitePhotoKind,
      ownerRef: record.operationId,
      saved: (List<EvidencePhoto> photos) async {
        record = _with(record, photos);
        drafts.save(id: id, kind: kSitePhotoKind, fields: record.toJson(), recordId: record.contractId);
      },
    );
    record = _with(record, handed);
    drafts.save(id: id, kind: kSitePhotoKind, fields: record.toJson(), recordId: record.contractId);
    // Starting the runner is what makes the uploads go: it also runs when the device comes back online.
    (await _ref.read(uploadRunnerProvider.future)).trigger();
    return record;
  }

  /// The captures on the phone, the newest first.
  Future<List<StoredCapture>> captures() async => <StoredCapture>[
        for (final LocalDraft stored in (await _drafts).list(kind: kSitePhotoKind))
          if (PhotoRecord.fromJson(stored.fields) case final PhotoRecord record) StoredCapture(id: stored.id, record: record),
      ];

  /// Drops a capture the person does not want any more: its uploads that have not finished are cancelled, its files and its record are
  /// removed. What the server already holds is not touched.
  Future<void> drop(StoredCapture capture) async {
    final AttachmentUploader uploader = await _ref.read(attachmentUploaderProvider.future);
    for (final EvidencePhoto photo in capture.record.photos) {
      final String? uploadId = photo.uploadId;
      if (uploadId != null) {
        final AttachmentUpload? upload = uploader.upload(uploadId);
        if (upload != null && !upload.state.isFinal) uploader.cancel(uploadId);
      }
      await removePreparedFiles(photo);
    }
    (await _drafts).delete(capture.id);
  }

  /// The photographs with the upload each already has in the record kept for this capture, when the uploader still knows that upload.
  List<EvidencePhoto> _withKnownUploads(List<EvidencePhoto> photos, LocalDraft? kept, AttachmentUploader uploader) {
    final PhotoRecord? before = kept == null ? null : PhotoRecord.fromJson(kept.fields);
    if (before == null) return photos;
    final Map<String, String> uploads = <String, String>{
      for (final EvidencePhoto photo in before.photos)
        if (photo.uploadId case final String uploadId when uploader.upload(uploadId) != null) photo.id: uploadId,
    };
    return <EvidencePhoto>[
      for (final EvidencePhoto photo in photos) photo.uploadId == null && uploads.containsKey(photo.id) ? photo.copyWith(uploadId: uploads[photo.id]) : photo,
    ];
  }

  LocalDraft? _find(DraftStore drafts, String operationId) {
    for (final LocalDraft stored in drafts.list(kind: kSitePhotoKind)) {
      if (stored.fields['operation_id'] == operationId) return stored;
    }
    return null;
  }

  PhotoRecord _with(PhotoRecord record, List<EvidencePhoto> photos) => PhotoRecord(
        operationId: record.operationId,
        contractId: record.contractId,
        contractCode: record.contractCode,
        siteDiaryId: record.siteDiaryId,
        diaryDate: record.diaryDate,
        caption: record.caption,
        place: record.place,
        photos: photos,
      );
}

final Provider<SitePhotoService> sitePhotoServiceProvider = Provider<SitePhotoService>(SitePhotoService.new);
