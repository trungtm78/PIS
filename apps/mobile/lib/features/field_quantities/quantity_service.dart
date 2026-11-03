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
import 'quantity_models.dart';

/// The quantity cannot be recorded yet: [problems] are the fields of the form; [itemNotRecordable] says the item has no stable
/// identity for this reader (the server shows it only to a reader who may record).
final class QuantityNotReady implements Exception {
  const QuantityNotReady(this.problems, {this.itemNotRecordable = false});

  final Map<String, QuantityProblem> problems;
  final bool itemNotRecordable;

  @override
  String toString() => 'QuantityNotReady(${problems.keys.join(', ')})';
}

/// A quantity draft of the person with its id on the device.
final class StoredQuantityDraft {
  const StoredQuantityDraft({required this.id, required this.draft});

  final String id;
  final QuantityDraft draft;
}

/// The local work on a quantity: the draft in the encrypted store, and the hand-over of the photographs and the record to the
/// uploader and the queue. Nothing here talks to the network: the queue and the uploader do, when the network is there.
class QuantityService {
  QuantityService(this._ref, {String Function()? newId}) : _newId = newId ?? newUuidV4;

  final Ref _ref;
  final String Function() _newId;

  Future<DraftStore> get _drafts => _ref.read(draftStoreProvider.future);

  /// The quantity being written for this contract, or a new one that is not stored until [save]. A record that was handed to the
  /// queue is no longer a draft: the next quantity starts empty.
  Future<StoredQuantityDraft> draftFor(String contractId) async {
    for (final LocalDraft stored in (await _drafts).list(kind: kQuantityDraftKind)) {
      if (stored.status == DraftStatus.queued || stored.status == DraftStatus.synced) continue;
      final QuantityDraft? draft = QuantityDraft.fromJson(stored.fields);
      if (draft != null && draft.contractId == contractId) return StoredQuantityDraft(id: stored.id, draft: draft);
    }
    return StoredQuantityDraft(id: '', draft: QuantityDraft(contractId: contractId, operationId: _newId()));
  }

  Future<String> save(QuantityDraft draft, {String draftId = ''}) async =>
      (await _drafts).save(id: draftId.isEmpty ? null : draftId, kind: kQuantityDraftKind, fields: draft.toJson(), recordId: draft.contractId).id;

  /// Queues the quantity as one `measurement.record` command whose key is the identity of the draft, so a second tap, a send
  /// repeated after a lost answer and a retry of the queue all give the same single measurement (UAT-AC358). Works without a network.
  Future<QueuedCommand> queueRecord(String draftId, {required BoqItem? item, required bool periodsKnown}) async {
    final LocalDraft? stored = (await _drafts).byId(draftId);
    QuantityDraft draft = (stored == null ? null : QuantityDraft.fromJson(stored.fields)) ?? (throw StateError('no draft $draftId'));
    final Map<String, QuantityProblem> problems = checkQuantity(draft.form, periodsKnown: periodsKnown);
    if (problems.isNotEmpty || item == null || item.itemId == null) throw QuantityNotReady(problems, itemNotRecordable: item != null && item.itemId == null);
    draft = draft.copyWith(photos: await enforcePhotoConsent(draft.photos, consent: draft.place.consent));
    final AttachmentUploader uploader = await _ref.read(attachmentUploaderProvider.future);
    draft = draft.copyWith(
      photos: await handOverPhotos(
        uploader,
        draft.photos,
        ownerKind: 'measurement',
        ownerRef: draft.operationId,
        saved: (List<EvidencePhoto> photos) async => save(draft.copyWith(photos: photos), draftId: draftId),
      ),
    );
    await save(draft, draftId: draftId);
    final CommandQueue queue = await _ref.read(commandQueueProvider.future);
    final QueuedCommand command = queue.enqueue(
      commandType: kMeasurementRecordCommand,
      payload: measurementPayload(draft, item),
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

final Provider<QuantityService> quantityServiceProvider = Provider<QuantityService>(QuantityService.new);
