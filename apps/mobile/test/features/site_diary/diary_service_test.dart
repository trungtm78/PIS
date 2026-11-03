import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/app/app_config.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/offline_codes.dart';
import 'package:machvon_mobile/core/offline/queue/queue_results.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/site_diary/diary_models.dart';
import 'package:machvon_mobile/features/site_diary/diary_service.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../field_issues/field_world.dart';

Future<(ProviderContainer, FieldServer)> _phone() async {
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
  return (container, server);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AC-ST-MOB-020-2 UAT-AC358 a diary refused as unverifiable may have been recorded: it is never saved again under a new key', () {
    test('saving again is refused and leaves the refused command, its key and the draft as they were', () async {
      final (ProviderContainer container, FieldServer server) = await _phone();
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.rejected(kResultUnverifiable);
      final DiaryService service = container.read(diaryServiceProvider);
      final StoredDiaryDraft stored = await service.draftFor('c-1', '2026-11-03');
      final String id = await service.save(stored.draft.copyWith(form: const DiaryForm(summary: 'Đổ bê tông móng T3')));
      final QueuedCommand first = await service.queueSave(id, today: '2026-11-03');
      final CommandQueue queue = await container.read(commandQueueProvider.future);
      await queue.flush();
      expect(queue.command(first.id)!.errorCode, kResultUnverifiable);

      await expectLater(service.queueSave(id, today: '2026-11-03'), throwsA(isA<ResultUnverifiable>()));

      expect(queue.commands(), hasLength(1), reason: 'no second diary was made');
      expect(queue.command(first.id)!.state, CommandState.rejected);
      expect((await service.draftFor('c-1', '2026-11-03')).draft.operationId, first.idempotencyKey);
      (await container.read(queueRunnerProvider.future)).dispose();
      (await container.read(uploadRunnerProvider.future)).dispose();
      await pumpEventQueue(times: 50);
    });
  });
}
