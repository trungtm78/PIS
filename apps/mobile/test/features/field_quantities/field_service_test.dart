
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/app/app_config.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/offline/drafts/draft_store.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/offline_codes.dart';
import 'package:machvon_mobile/core/offline/queue/queue_results.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/field_quantities/inspection_models.dart';
import 'package:machvon_mobile/features/field_quantities/inspection_service.dart';
import 'package:machvon_mobile/features/field_quantities/quantity_models.dart';
import 'package:machvon_mobile/features/field_quantities/quantity_service.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../field_issues/field_world.dart';

class _Phone {
  _Phone(this.container, this.server);

  final ProviderContainer container;
  final FieldServer server;

  Future<DraftStore> get drafts => container.read(draftStoreProvider.future);

  Future<CommandQueue> get queue => container.read(commandQueueProvider.future);

  /// Sends what is queued now, and ends the runners so nothing talks to the server when the test is over.
  Future<void> settle() async {
    final CommandQueue commands = await queue;
    await commands.flush();
    (await container.read(queueRunnerProvider.future)).dispose();
    (await container.read(uploadRunnerProvider.future)).dispose();
    await pumpEventQueue(times: 50);
  }

  /// The server answers the next command with a final refusal; the one after with an acceptance.
  void refuseOnce({String code = 'QUANTITY_EXCEEDS_BOQ'}) {
    int answered = 0;
    server.sync.decide = (Map<String, Object?> item) {
      answered += 1;
      return answered == 1 ? ServerOutcome.rejected(code) : const ServerOutcome.accepted();
    };
  }
}

Future<_Phone> _phone() async {
  final TestStorage storage = TestStorage.create();
  final FieldServer server = FieldServer();
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      appConfigProvider.overrideWithValue(AppConfig.parse('https://api.test/v1', allowInsecureLoopback: false)),
      sessionProvider.overrideWith(() => FakeSession()),
      httpTransportProvider.overrideWithValue(server),
      offlineStorageProvider.overrideWithValue(storage.storage),
      chunkTransportProvider.overrideWithValue(server.attachments),
    ],
  );
  addTearDown(container.dispose);
  (await container.read(localStoreProvider.future)).deviceId = kDeviceId;
  return _Phone(container, server);
}

const BoqItem _item = BoqItem(lineId: 'l-1', revisionId: 'r-1', businessKey: 'B01', description: 'Đào đất', unitCode: 'm3', quantity: '8000', itemId: 'item-l-1');

QuantityDraft _quantity(QuantityDraft draft, String quantity) =>
    draft.copyWith(form: QuantityForm(itemLineId: 'l-1', periodId: 'per-1', quantity: quantity, referenceNo: 'BB-014'));

final List<ChecklistItem> _checklist = <ChecklistItem>[const ChecklistItem(code: 'K1', label: 'Cốt thép'), const ChecklistItem(code: 'K2', label: 'Thép đai')];

Inspection get _inspection => Inspection(id: 'i-1', inspectionNo: 'INS-1', title: 'Nghiệm thu', status: 'SCHEDULED', checklist: _checklist, canRecord: true, version: 3);

ResultDraft _result(ResultDraft draft, String note) => draft.copyWith(
      form: ResultForm(
        answers: <String, ItemAnswer>{'K1': const ItemAnswer(outcome: 'PASS'), 'K2': ItemAnswer(outcome: 'PASS', note: note)},
        result: 'PASS',
        resultNote: 'Đạt yêu cầu',
      ),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AC-ST-MOB-021-2 UAT-AC358 a quantity refused by the server and corrected on the phone is a new measurement under a new key', () {
    Future<(_Phone, String, QueuedCommand)> refusedQuantity() async {
      final _Phone phone = await _phone();
      phone.refuseOnce();
      final QuantityService service = phone.container.read(quantityServiceProvider);
      final StoredQuantityDraft stored = await service.draftFor('c-1');
      final String id = await service.save(_quantity(stored.draft, '9000'));
      final QueuedCommand first = await service.queueRecord(id, item: _item, periodsKnown: true);
      final CommandQueue queue = await phone.queue;
      await queue.flush();
      expect(queue.command(first.id)!.state, CommandState.rejected);
      return (phone, id, first);
    }

    test('the corrected quantity is queued, the refused one is retired, and the key is a fresh one', () async {
      final (_Phone phone, String id, QueuedCommand first) = await refusedQuantity();
      final QuantityService service = phone.container.read(quantityServiceProvider);
      final StoredQuantityDraft reopened = await service.draftFor('c-1');
      expect(reopened.id, id, reason: 'the refused draft is the one that is corrected');
      await service.save(_quantity(reopened.draft, '100'), draftId: id);

      final QueuedCommand second = await service.queueRecord(id, item: _item, periodsKnown: true);

      final CommandQueue queue = await phone.queue;
      expect(second.id, isNot(first.id));
      expect(second.idempotencyKey, isNot(first.idempotencyKey));
      expect(second.payload!['quantity_period'], '100');
      expect(queue.command(first.id)!.state, CommandState.discarded, reason: 'the refused measurement cannot be retried beside the corrected one');
      expect(queue.unsentCount, greaterThanOrEqualTo(1));
      await phone.settle();
      expect(queue.command(second.id)!.state, CommandState.accepted);
    });

    test('the same figures sent again after the refusal are a new attempt, not the refused command handed back', () async {
      final (_Phone phone, String id, QueuedCommand first) = await refusedQuantity();
      final QuantityService service = phone.container.read(quantityServiceProvider);

      final QueuedCommand second = await service.queueRecord(id, item: _item, periodsKnown: true);

      expect(second.id, isNot(first.id));
      expect(second.state, isNot(CommandState.rejected));
      await phone.settle();
      expect((await phone.queue).command(second.id)!.state, CommandState.accepted);
    });

    test('a measurement the person discarded from the queue and records again is queued, not answered with the discarded command', () async {
      final _Phone phone = await _phone();
      phone.server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.transient();
      final QuantityService service = phone.container.read(quantityServiceProvider);
      final StoredQuantityDraft stored = await service.draftFor('c-1');
      final String id = await service.save(_quantity(stored.draft, '50'));
      final QueuedCommand first = await service.queueRecord(id, item: _item, periodsKnown: true);
      final CommandQueue queue = await phone.queue;
      await queue.flush();
      expect(queue.command(first.id)!.state, CommandState.queued, reason: 'the server could not take it yet: it waits for a later send');
      queue.discard(first.id);

      final QuantityDraft again = (await service.draftFor('c-1')).draft;
      final QueuedCommand second = await service.queueRecord(id, item: _item, periodsKnown: true);

      expect(again.operationId, first.idempotencyKey);
      expect(second.id, isNot(first.id));
      expect(second.state, CommandState.queued);
      await phone.settle();
    });

    test('a measurement still queued is handed back by a second tap, whatever the number of taps', () async {
      final _Phone phone = await _phone();
      phone.server.offline = true;
      final QuantityService service = phone.container.read(quantityServiceProvider);
      final String id = await service.save(_quantity((await service.draftFor('c-1')).draft, '50'));
      final QueuedCommand first = await service.queueRecord(id, item: _item, periodsKnown: true);
      final QueuedCommand second = await service.queueRecord(id, item: _item, periodsKnown: true);
      expect(second.id, first.id);
      expect((await phone.queue).commands(), hasLength(1));
      await phone.settle();
    });
  });

  group('AC-ST-MOB-021-2 UAT-AC358 a measurement refused as unverifiable may have been recorded: it is never sent again under a new key', () {
    test('recording it again, corrected or not, is refused and leaves the refused command and its key as they were', () async {
      final _Phone phone = await _phone();
      phone.refuseOnce(code: kResultUnverifiable);
      final QuantityService service = phone.container.read(quantityServiceProvider);
      final String id = await service.save(_quantity((await service.draftFor('c-1')).draft, '9000'));
      final QueuedCommand first = await service.queueRecord(id, item: _item, periodsKnown: true);
      final CommandQueue queue = await phone.queue;
      await queue.flush();
      expect(queue.command(first.id)!.errorCode, kResultUnverifiable);

      final StoredQuantityDraft reopened = await service.draftFor('c-1');
      expect(reopened.id, id, reason: 'the blocked draft is the one that comes back');
      await expectLater(service.queueRecord(id, item: _item, periodsKnown: true), throwsA(isA<ResultUnverifiable>()));
      await service.save(_quantity(reopened.draft, '100'), draftId: id);
      await expectLater(service.queueRecord(id, item: _item, periodsKnown: true), throwsA(isA<ResultUnverifiable>()));

      expect(queue.commands(), hasLength(1), reason: 'no second measurement was made');
      expect(queue.command(first.id)!.state, CommandState.rejected, reason: 'the person decides in the queue; nothing was discarded for them');
      expect(QuantityDraft.fromJson((await phone.drafts).byId(id)!.fields)!.operationId, first.idempotencyKey);
      await phone.settle();
    });

    test('once the person has discarded it in the queue, the measurement can be recorded again under a new key', () async {
      final _Phone phone = await _phone();
      phone.refuseOnce(code: kResultUnverifiable);
      final QuantityService service = phone.container.read(quantityServiceProvider);
      final String id = await service.save(_quantity((await service.draftFor('c-1')).draft, '9000'));
      final QueuedCommand first = await service.queueRecord(id, item: _item, periodsKnown: true);
      final CommandQueue queue = await phone.queue;
      await queue.flush();

      queue.discard(first.id);
      final QueuedCommand second = await service.queueRecord(id, item: _item, periodsKnown: true);

      expect(second.idempotencyKey, isNot(first.idempotencyKey));
      await phone.settle();
    });
  });

  group('AC-ST-MOB-021-3 UAT-AC358 an inspection result refused as unverifiable is never sent again under a new key', () {
    test('recording it again is refused and leaves the refused command as it was', () async {
      final _Phone phone = await _phone();
      phone.refuseOnce(code: kResultUnverifiable);
      final InspectionService service = phone.container.read(inspectionServiceProvider);
      final String id = await service.save(_result((await service.draftFor('c-1', 'i-1')).draft, ''));
      final QueuedCommand first = await service.queueResult(id, _inspection);
      final CommandQueue queue = await phone.queue;
      await queue.flush();
      expect(queue.command(first.id)!.errorCode, kResultUnverifiable);

      await expectLater(service.queueResult(id, _inspection), throwsA(isA<ResultUnverifiable>()));

      expect(queue.commands(), hasLength(1));
      expect(queue.command(first.id)!.state, CommandState.rejected);
      await phone.settle();
    });
  });

  group('AC-ST-MOB-021-3 UAT-AC358 an inspection result refused by the server and corrected on the phone is a new command under a new key', () {
    test('the corrected result is queued and the refused one is retired', () async {
      final _Phone phone = await _phone();
      phone.refuseOnce();
      final InspectionService service = phone.container.read(inspectionServiceProvider);
      final StoredResultDraft stored = await service.draftFor('c-1', 'i-1');
      final String id = await service.save(_result(stored.draft, ''));
      final QueuedCommand first = await service.queueResult(id, _inspection);
      final CommandQueue queue = await phone.queue;
      await queue.flush();
      expect(queue.command(first.id)!.state, CommandState.rejected);

      final StoredResultDraft reopened = await service.draftFor('c-1', 'i-1');
      expect(reopened.id, id);
      await service.save(_result(reopened.draft, 'đã sửa'), draftId: id);
      final QueuedCommand second = await service.queueResult(id, _inspection);

      expect(second.id, isNot(first.id));
      expect(second.idempotencyKey, isNot(first.idempotencyKey));
      expect(queue.command(first.id)!.state, CommandState.discarded);
      await phone.settle();
      expect(queue.command(second.id)!.state, CommandState.accepted);
    });
  });
}
