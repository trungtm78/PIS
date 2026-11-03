import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/offline/attachments/attachment_uploader.dart';
import '../../core/offline/drafts/draft_store.dart';
import '../../core/offline/drafts/local_draft.dart';
import '../../core/offline/offline_providers.dart';
import '../../core/offline/queue/command_queue.dart';
import '../../core/offline/queue/offline_codes.dart';
import '../../core/offline/queue/queue_results.dart';
import '../../core/offline/queue/queue_runner.dart';
import '../../core/offline/queue/queued_command.dart';
import '../field_evidence/evidence_photos.dart';
import '../read_support/wire.dart' show Json;
import 'diary_models.dart';

/// The diary cannot be saved yet: [problems] are the fields of the form.
final class DiaryNotReady implements Exception {
  const DiaryNotReady(this.problems);

  final Map<String, DiaryProblem> problems;

  @override
  String toString() => 'DiaryNotReady(${problems.keys.join(', ')})';
}

/// The save before this one has not been settled by the server (it is being sent, its answer was lost, or it is waiting for the
/// person to choose in MOB-42): another save now could be a second diary, so it waits.
final class DiaryBusy implements Exception {
  const DiaryBusy(this.state);

  final CommandState state;

  @override
  String toString() => 'DiaryBusy(${state.name})';
}

/// A draft of the person with its id on the device.
final class StoredDiaryDraft {
  const StoredDiaryDraft({required this.id, required this.draft});

  final String id;
  final DiaryDraft draft;
}

/// The local work on a diary of a contract and a day: the draft in the encrypted store, and the hand-over of the photographs and the
/// diary to the uploader and the queue. Nothing here talks to the network: the queue and the uploader do, when the network is there.
class DiaryService {
  DiaryService(this._ref, {String Function()? newId})
    : _newId = newId ?? newUuidV4;

  final Ref _ref;
  final String Function() _newId;

  Future<DraftStore> get _drafts => _ref.read(draftStoreProvider.future);

  /// The draft of this contract and day, or a new one that is not stored until [save]. A draft is per person, contract and day.
  Future<StoredDiaryDraft> draftFor(
    String contractId,
    String recordDate,
  ) async {
    for (final LocalDraft stored in (await _drafts).list(
      kind: kDiaryDraftKind,
    )) {
      final DiaryDraft? draft = DiaryDraft.fromJson(stored.fields);
      if (draft != null &&
          draft.contractId == contractId &&
          draft.recordDate == recordDate)
        return StoredDiaryDraft(id: stored.id, draft: draft);
    }
    return StoredDiaryDraft(
      id: '',
      draft: DiaryDraft(
        contractId: contractId,
        recordDate: recordDate,
        operationId: _newId(),
      ),
    );
  }

  /// Saves the draft; a new one when [draftId] is empty. Returns the id on the device.
  Future<String> save(DiaryDraft draft, {String draftId = ''}) async =>
      (await _drafts)
          .save(
            id: draftId.isEmpty ? null : draftId,
            kind: kDiaryDraftKind,
            fields: draft.toJson(),
            recordId: draft.contractId,
          )
          .id;

  Future<void> discard(String draftId) async {
    final LocalDraft? stored = (await _drafts).byId(draftId);
    if (stored == null) return;
    final DiaryDraft? draft = DiaryDraft.fromJson(stored.fields);
    for (final EvidencePhoto photo
        in draft?.photos ?? const <EvidencePhoto>[]) {
      await removePreparedFiles(photo);
    }
    (await _drafts).delete(draftId);
  }

  /// Queues the diary as one `site_diary.append` command with the identity of the save as its key, so a second tap, a send repeated
  /// after a lost answer and a retry of the queue all give the same single diary (UAT-AC358). [over] is the diary of the day on the
  /// server when there is one: it is then written over under the version that was read, and a second editor who read the same
  /// version is refused with `VERSION_CONFLICT` and decides in MOB-42. Works without a network. Throws [DiaryNotReady] when a field
  /// is not in order, [DiaryBusy] when the save before this one is not settled and [ResultUnverifiable] when it was refused as
  /// unverifiable (it may have been carried out: only the person can say it was not).
  Future<QueuedCommand> queueSave(
    String draftId, {
    required String today,
    DiaryRecord? over,
  }) async {
    final LocalDraft? stored = (await _drafts).byId(draftId);
    DiaryDraft draft =
        (stored == null ? null : DiaryDraft.fromJson(stored.fields)) ??
        (throw StateError('no draft $draftId'));
    final Map<String, DiaryProblem> problems = checkDiary(
      draft.form,
      recordDate: draft.recordDate,
      today: today,
    );
    if (problems.isNotEmpty) throw DiaryNotReady(problems);
    final CommandQueue queue = await _ref.read(commandQueueProvider.future);
    // The save before this one: the same payload is the same tap; another one replaces it while it has not left the phone.
    final String? earlier = draft.commandId;
    final QueuedCommand? previous = earlier == null
        ? null
        : queue.command(earlier);
    if (previous != null &&
        (previous.state == CommandState.sending ||
            previous.state == CommandState.unknown ||
            previous.state == CommandState.conflict)) {
      throw DiaryBusy(previous.state);
    }
    if (previous != null &&
        previous.state == CommandState.rejected &&
        previous.errorCode == kResultUnverifiable) {
      // It may have been carried out, and a new key would carry it out twice: the person decides in the queue.
      throw ResultUnverifiable(previous.id);
    }
    draft = draft.copyWith(
      photos: await enforcePhotoConsent(
        draft.photos,
        consent: draft.place.consent,
      ),
    );
    final AttachmentUploader uploader = await _ref.read(
      attachmentUploaderProvider.future,
    );
    draft = draft.copyWith(
      photos: await handOverPhotos(
        uploader,
        draft.photos,
        ownerKind: 'site_diary',
        ownerRef: draft.operationId,
        saved: (List<EvidencePhoto> photos) async =>
            save(draft.copyWith(photos: photos), draftId: draftId),
      ),
    );
    if (previous != null &&
        (previous.state == CommandState.queued ||
            previous.state == CommandState.rejected)) {
      final Json again = diaryPayload(draft, over: over);
      if (previous.state == CommandState.queued &&
          previous.baseServerVersion == (over?.version ?? 0) &&
          _same(previous.payload, again))
        return previous;
      queue.discard(previous.id);
      draft = draft.copyWith(operationId: _newId(), clearCommand: true);
    } else if (previous != null) {
      // Settled: the next save is a new intention.
      draft = draft.copyWith(operationId: _newId(), clearCommand: true);
    }
    final QueuedCommand command = queue.enqueue(
      commandType: kDiaryAppendCommand,
      payload: diaryPayload(draft, over: over),
      baseServerVersion: over?.version ?? 0,
      attempt: CommandAttempt(draft.operationId),
      draftId: draftId,
    );
    await save(draft.copyWith(commandId: command.id), draftId: draftId);
    final QueueRunner runner = await _ref.read(queueRunnerProvider.future);
    runner.trigger();
    await _ref.read(uploadRunnerProvider.future);
    return command;
  }

  bool _same(Map<String, Object?>? a, Map<String, Object?> b) =>
      a != null && jsonEncode(a) == jsonEncode(b);
}

final Provider<DiaryService> diaryServiceProvider = Provider<DiaryService>(
  DiaryService.new,
);
