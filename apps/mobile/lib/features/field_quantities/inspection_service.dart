import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/offline/attachments/attachment_uploader.dart';
import '../../core/offline/drafts/draft_store.dart';
import '../../core/offline/drafts/local_draft.dart';
import '../../core/offline/offline_providers.dart';
import '../../core/offline/queue/command_queue.dart';
import '../../core/offline/queue/queue_runner.dart';
import '../../core/offline/queue/queued_command.dart';
import '../field_evidence/evidence_photos.dart';
import 'command_identity.dart';
import 'inspection_models.dart';

/// The result cannot be recorded yet: [problems] are the lines of the form.
final class ResultNotReady implements Exception {
  const ResultNotReady(this.problems);

  final Map<String, ResultProblem> problems;

  @override
  String toString() => 'ResultNotReady(${problems.keys.join(', ')})';
}

/// A result draft of the person with its id on the device.
final class StoredResultDraft {
  const StoredResultDraft({required this.id, required this.draft});

  final String id;
  final ResultDraft draft;
}

/// The local work on the result of an inspection: the draft in the encrypted store (per inspection), and the hand-over of the
/// photographs and the result to the uploader and the queue. Nothing here talks to the network.
class InspectionService {
  InspectionService(this._ref, {String Function()? newId}) : _newId = newId ?? newUuidV4;

  final Ref _ref;
  final String Function() _newId;

  Future<DraftStore> get _drafts => _ref.read(draftStoreProvider.future);

  Future<StoredResultDraft> draftFor(String contractId, String inspectionId) async {
    for (final LocalDraft stored in (await _drafts).list(kind: kInspectionDraftKind)) {
      if (stored.status == DraftStatus.queued || stored.status == DraftStatus.synced) continue;
      final ResultDraft? draft = ResultDraft.fromJson(stored.fields);
      if (draft != null && draft.inspectionId == inspectionId) return StoredResultDraft(id: stored.id, draft: draft);
    }
    return StoredResultDraft(id: '', draft: ResultDraft(contractId: contractId, inspectionId: inspectionId, operationId: _newId()));
  }

  Future<String> save(ResultDraft draft, {String draftId = ''}) async =>
      (await _drafts).save(id: draftId.isEmpty ? null : draftId, kind: kInspectionDraftKind, fields: draft.toJson(), recordId: draft.inspectionId).id;

  /// Queues the result as one `inspection.result` command based on the version of the inspection that was read, with the identity
  /// of the draft as its key: a second tap and a retry after a lost answer give one result. Works without a network.
  Future<QueuedCommand> queueResult(String draftId, Inspection inspection) async {
    final LocalDraft? stored = (await _drafts).byId(draftId);
    ResultDraft draft = (stored == null ? null : ResultDraft.fromJson(stored.fields)) ?? (throw StateError('no draft $draftId'));
    final Map<String, ResultProblem> problems = checkResult(draft.form, inspection.checklist);
    if (problems.isNotEmpty) throw ResultNotReady(problems);
    final CommandQueue queue = await _ref.read(commandQueueProvider.future);
    // A result the server refused (or the person took back) and that is recorded again is a new intention: a new key.
    final String operation = operationForNextSend(queue, draft.operationId, _newId);
    if (operation != draft.operationId) draft = draft.copyWith(operationId: operation);
    draft = draft.copyWith(photos: await enforcePhotoConsent(draft.photos, consent: draft.place.consent));
    final AttachmentUploader uploader = await _ref.read(attachmentUploaderProvider.future);
    draft = draft.copyWith(
      photos: await handOverPhotos(
        uploader,
        draft.photos,
        ownerKind: 'inspection',
        ownerRef: draft.operationId,
        saved: (List<EvidencePhoto> photos) async => save(draft.copyWith(photos: photos), draftId: draftId),
      ),
    );
    await save(draft, draftId: draftId);
    final QueuedCommand command = queue.enqueue(
      commandType: kInspectionResultCommand,
      payload: resultPayload(inspection.id, draft.form, inspection.checklist),
      baseServerVersion: inspection.version,
      attempt: CommandAttempt(draft.operationId),
      draftId: draftId,
      releaseDraft: true,
    );
    final QueueRunner runner = await _ref.read(queueRunnerProvider.future);
    runner.trigger();
    await _ref.read(uploadRunnerProvider.future);
    return command;
  }
}

final Provider<InspectionService> inspectionServiceProvider = Provider<InspectionService>(InspectionService.new);
