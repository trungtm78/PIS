import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/read_support/read_cache.dart';
import 'package:machvon_mobile/features/site_clearance/site_clearance_feature.dart' as clearance;

import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../support/scripted_server.dart';
import 'fixtures.dart';

/// The locations of the three views of MOB-68.
const String kClearanceProjects = '/projects/mob-68';
const String kClearanceHouseholds = '/projects/mob-68?project=p-1';
const String kClearanceTask = '/projects/mob-68?project=p-1&household=h-1';

/// A read cache in memory: the screens need one, and what it holds is not what these tests look at.
final class MemoryReadCache implements ReadCache {
  final Map<String, CacheEntry> entries = <String, CacheEntry>{};

  @override
  Future<CacheEntry?> read(CacheScope scope, String key) async => entries[key];

  @override
  Future<void> write(CacheScope scope, String key, CacheEntry entry) async => entries[key] = entry;

  @override
  Future<void> forget(CacheScope scope, String key) async => entries.remove(key);

  @override
  Future<void> clear() async => entries.clear();
}

/// Opens the clearance officer's app on [location]: a signed-in officer, an encrypted store of drafts in a temporary directory, a read cache in
/// memory, and the clock of the scripted world.
Future<ProviderContainer> openClearance(WidgetTester tester, ScriptedServer server, String location) async {
  final TestStorage storage = TestStorage.create();
  await storage.open();
  return pumpWithServer(
    tester,
    features: <MobileFeature>[clearance.feature],
    server: server,
    location: location,
    session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1')),
    overrides: <Override>[offlineStorageProvider.overrideWithValue(storage.storage), readCacheProvider.overrideWithValue(MemoryReadCache())],
  );
}

/// The reads of the three views, with what the server holds for them.
void answerClearance(ScriptedServer server, {List<Object?>? households, List<Object?>? projects, List<Object?>? records}) {
  server
    ..on('GET', '/resources/project', (_) => page(projects ?? <Object?>[project('p-1', 'DA-001', 'Đường vành đai 1')]))
    ..on('GET', '/affected-households', (_) => page(households ?? <Object?>[household('h-1', consent: 'cr-1')]))
    ..on('GET', '/land-inventory-records', (_) => page(records ?? <Object?>[record('r-1')]));
}
