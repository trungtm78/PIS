import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/offline/attachments/attachment_upload.dart';
import '../../core/offline/attachments/attachment_uploader.dart';
import '../../core/offline/drafts/draft_store.dart';
import '../../core/offline/drafts/local_draft.dart';
import '../../core/offline/offline_providers.dart';
import '../../core/offline/queue/command_queue.dart';
import '../../core/offline/queue/queue_runner.dart';
import '../../core/offline/queue/queued_command.dart';
import '../field_evidence/annotation.dart';
import '../field_evidence/evidence_photos.dart';
import '../field_evidence/photo_pipeline.dart';
import 'issue_draft.dart';

/// The report cannot be sent yet: [problems] are the fields of the form, [blockers] the lines of the checklist.
final class IssueNotReady implements Exception {
  const IssueNotReady({
    this.problems = const <String, IssueProblem>{},
    this.blockers = const <String>[],
  });

  final Map<String, IssueProblem> problems;
  final List<String> blockers;

  @override
  String toString() =>
      'IssueNotReady(${problems.keys.followedBy(blockers).join(', ')})';
}

/// A draft of the signed-in person with its id on the device.
final class StoredIssueDraft {
  const StoredIssueDraft({
    required this.id,
    required this.draft,
    required this.status,
    this.blockedCode,
  });

  final String id;
  final IssueDraft draft;
  final DraftStatus status;
  final String? blockedCode;
}

/// The local work on a report of an issue: the draft in the encrypted store, the photographs prepared in the private folder of
/// the person, and the hand-over to the upload and to the queue. Nothing here talks to the network: the queue and the uploader do,
/// when the network is there.
class IssueService {
  IssueService(this._ref, {String Function()? newId})
    : _newId = newId ?? newUuidV4;

  final Ref _ref;
  final String Function() _newId;

  Future<DraftStore> get _drafts => _ref.read(draftStoreProvider.future);

  /// A draft with the identity the report will carry for ever. Nothing is stored until [save].
  IssueDraft blank() => IssueDraft(clientOperationId: _newId());

  Future<StoredIssueDraft?> load(String draftId) async {
    final LocalDraft? stored = (await _drafts).byId(draftId);
    if (stored == null || stored.kind != kIssueDraftKind) return null;
    final IssueDraft? draft = IssueDraft.fromJson(stored.fields);
    return draft == null
        ? null
        : StoredIssueDraft(
            id: stored.id,
            draft: draft,
            status: stored.status,
            blockedCode: stored.blockedCode,
          );
  }

  /// Saves the draft; a new one when [draftId] is null. Returns the id on the device.
  Future<String> save(IssueDraft draft, {String? draftId}) async =>
      (await _drafts)
          .save(id: draftId, kind: kIssueDraftKind, fields: draft.toJson())
          .id;

  /// The drafts that can still be worked on (not the ones already handed to the queue), newest first.
  Future<List<StoredIssueDraft>> open() async {
    final List<StoredIssueDraft> out = <StoredIssueDraft>[];
    for (final LocalDraft stored in (await _drafts).list(
      kind: kIssueDraftKind,
    )) {
      if (stored.status == DraftStatus.queued ||
          stored.status == DraftStatus.synced)
        continue;
      final IssueDraft? draft = IssueDraft.fromJson(stored.fields);
      if (draft != null)
        out.add(
          StoredIssueDraft(
            id: stored.id,
            draft: draft,
            status: stored.status,
            blockedCode: stored.blockedCode,
          ),
        );
    }
    return out;
  }

  /// Drops a draft and the photographs it kept on the device.
  Future<void> discard(String draftId) async {
    final StoredIssueDraft? stored = await load(draftId);
    if (stored != null) {
      for (final IssuePhoto photo in stored.draft.photos) {
        _delete(photo.path);
        _delete(photo.originalPath);
      }
    }
    (await _drafts).delete(draftId);
  }

  void _delete(String? path) {
    if (path == null) return;
    final File file = File(path);
    if (file.existsSync()) file.deleteSync();
  }

  // ----------------------------------------------------------------------------------------------------- photographs

  Future<Directory> get _evidence => _ref.read(evidenceDirectoryProvider.future);

  /// Prepares a photograph for the draft: what it says of where and when is kept only when [keepPlaceAndTime] (the consent of
  /// the person), the marks are drawn in, a large one is compressed, and the original is kept per the retention policy. Throws
  /// [AttachmentRefused] with the reason when it cannot be used, before anything is written.
  Future<IssuePhoto> prepare(
    File source, {
    required bool keepPlaceAndTime,
    AnnotationSet marks = AnnotationSet.empty,
    EvidenceLimits limits = const EvidenceLimits(),
  }) async {
    final PreparedPhoto prepared = await preparePhoto(
      source: source,
      directory: await _evidence,
      keepPlaceAndTime: keepPlaceAndTime,
      annotations: marks,
      limits: limits,
      newId: _newId,
    );
    return IssuePhoto(
      id: _newId(),
      path: prepared.path,
      mime: prepared.mime,
      bytes: prepared.bytes,
      annotations: marks,
      originalPath: prepared.originalPath,
      sourceHadPlaceOrTime: prepared.sourceHadPlaceOrTime,
      keepsPlaceOrTime: prepared.keepsPlaceOrTime,
    );
  }

  /// Takes the place and the time out of the photographs of a draft whose person has not consented (or withdrew the consent):
  /// the prepared file and the kept original are rewritten without them. Nothing the person did not agree to keep stays on the
  /// phone or goes up (BR-MOB-06).
  Future<IssueDraft> enforceConsent(IssueDraft draft) async {
    if (draft.place.consent) return draft;
    final List<IssuePhoto> photos = <IssuePhoto>[];
    for (final IssuePhoto photo in draft.photos) {
      if (!photo.keepsPlaceOrTime && photo.originalPath == null) {
        photos.add(photo);
        continue;
      }
      await stripPreparedFile(photo.path, photo.mime);
      final String? original = photo.originalPath;
      if (original != null) await stripPreparedFile(original, photo.mime);
      photos.add(
        IssuePhoto(
          id: photo.id,
          path: photo.path,
          mime: photo.mime,
          bytes: File(photo.path).existsSync() ? File(photo.path).lengthSync() : photo.bytes,
          annotations: photo.annotations,
          originalPath: original,
          sourceHadPlaceOrTime: photo.sourceHadPlaceOrTime,
          keepsPlaceOrTime: false,
          uploadId: photo.uploadId,
        ),
      );
    }
    return draft.copyWith(photos: photos);
  }

  // ----------------------------------------------------------------------------------------------------------- sending

  /// Sends the report: the photographs are handed to the uploader and the report is queued as one `issue.create` command with
  /// the identity of the draft as its key, so a second tap, a send repeated after a lost answer and a retry of the queue all give
  /// the same single issue. Works without a network: the queue sends when the device is back. Throws [IssueNotReady] when a
  /// required field or line is missing.
  Future<QueuedCommand> send(
    String draftId, {
    required String manualPlaceLabel,
  }) async {
    final StoredIssueDraft? stored = await load(draftId);
    if (stored == null) throw StateError('no draft $draftId');
    IssueDraft draft = stored.draft;
    final Map<String, IssueProblem> problems = checkIssue(
      draft,
      manualPlaceLabel: manualPlaceLabel,
    );
    if (problems.isNotEmpty) throw IssueNotReady(problems: problems);
    draft = await enforceConsent(draft);
    final List<FieldCheck> checks = fieldChecklist(
      draft,
      manualPlaceLabel: manualPlaceLabel,
    );
    if (!canSend(checks)) {
      throw IssueNotReady(
        blockers: <String>[
          for (final FieldCheck check in checks)
            if (check.blocking && check.status == CheckStatus.missing) check.id,
        ],
      );
    }
    final AttachmentUploader uploader = await _ref.read(
      attachmentUploaderProvider.future,
    );
    final List<IssuePhoto> photos = <IssuePhoto>[];
    for (final IssuePhoto photo in draft.photos) {
      if (photo.uploadId != null) {
        photos.add(photo);
        continue;
      }
      final AttachmentUpload upload = await uploader.add(
        file: File(photo.path),
        ownerKind: 'issue',
        ownerRef: draft.clientOperationId,
      );
      photos.add(photo.withUpload(upload.id));
      // The draft remembers the upload at once: a send interrupted here is resumed, never repeated.
      await save(
        draft.copyWith(
          photos: <IssuePhoto>[...photos, ...draft.photos.skip(photos.length)],
        ),
        draftId: draftId,
      );
    }
    draft = draft.copyWith(photos: photos);
    await save(draft, draftId: draftId);
    final CommandQueue queue = await _ref.read(commandQueueProvider.future);
    final QueuedCommand command = queue.enqueue(
      commandType: kIssueCreateCommand,
      payload: issuePayload(draft, manualPlaceLabel: manualPlaceLabel),
      attempt: CommandAttempt(draft.clientOperationId),
      draftId: draftId,
      releaseDraft: true,
    );
    // Both runners are started: the queue sends the report, the uploader sends the photographs.
    final QueueRunner runner = await _ref.read(queueRunnerProvider.future);
    runner.trigger();
    await _ref.read(uploadRunnerProvider.future);
    return command;
  }
}

final Provider<IssueService> issueServiceProvider = Provider<IssueService>(
  IssueService.new,
);
