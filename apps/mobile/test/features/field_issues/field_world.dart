import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/api/dart_io_transport.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/features/field_evidence/device_sources.dart';
import 'package:machvon_mobile/features/field_evidence/field_evidence_feature.dart' as evidence;
import 'package:machvon_mobile/features/field_evidence/field_place.dart';
import 'package:machvon_mobile/features/field_issues/field_issues_feature.dart' as issues;
import 'package:machvon_mobile/features/field_issues/issue_draft.dart';
import 'package:machvon_mobile/features/field_issues/issue_service.dart';
import 'package:machvon_mobile/features/offline/offline_feature.dart' as offline;
import 'package:machvon_mobile/features/permissions/permission_providers.dart';
import 'package:machvon_mobile/features/permissions/permission_service.dart';
import 'package:machvon_mobile/features/permissions/permissions_feature.dart' as permissions;
import 'package:machvon_mobile/features/read_support/clock.dart';
import 'package:machvon_mobile/features/read_support/read_support_feature.dart' as read_support;
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../../support/fake_attachment_server.dart';
import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../../support/temp_dirs.dart';
import '../session/support/world.dart' show MemorySecureStore;
import '../support/scripted_server.dart';

/// A phone as tall as the longest screen, so that a list built lazily is built whole and a test can read all of it.
const Size kTall = Size(390, 3200);

const String kDeviceId = '11111111-1111-4111-8111-111111111111';

/// What the phone says about each permission and what the prompt would answer.
class FakePermissions implements PermissionPlatform {
  final Map<AppPermission, PermissionState> now = <AppPermission, PermissionState>{for (final AppPermission p in AppPermission.values) p: PermissionState.granted};
  final Map<AppPermission, PermissionState> promptAnswer = <AppPermission, PermissionState>{for (final AppPermission p in AppPermission.values) p: PermissionState.granted};
  final List<AppPermission> prompts = <AppPermission>[];

  @override
  Future<PermissionState> status(AppPermission permission) async => now[permission]!;

  @override
  Future<PermissionState> request(AppPermission permission) async {
    prompts.add(permission);
    return now[permission] = promptAnswer[permission]!;
  }

  @override
  Future<bool> openSettings() async => true;
}

/// The camera and the gallery: the file the person would take or choose next.
class FakePhotos implements PhotoSource {
  File? camera;
  File? gallery;
  int cameraOpened = 0;
  int galleryOpened = 0;

  /// The files the application handed back as no longer needed.
  final List<String> discarded = <String>[];

  @override
  Future<File?> takePhoto() async {
    cameraOpened += 1;
    return camera;
  }

  @override
  Future<File?> pickPhoto() async {
    galleryOpened += 1;
    return gallery;
  }

  @override
  Future<void> discard(File picked) async {
    discarded.add(picked.path);
    await removeTempFile(picked);
  }
}

/// The position the phone would measure next.
class FakePosition implements PositionSource {
  DevicePosition? next = const DevicePosition(latitude: 10.8, longitude: 106.7, accuracyMetres: 12);

  /// A reading that arrives later than the person acts.
  Future<DevicePosition?>? slow;
  int asked = 0;

  @override
  Future<DevicePosition?> current() async {
    asked += 1;
    return slow ?? next;
  }
}

/// Everything the phone talks to: the sync endpoints (the queue), the attachment endpoints (the uploads), and the reads and
/// commands of the modules, answered by a script. One switch cuts all of it, as a phone with no signal.
class FieldServer implements HttpTransport {
  FieldServer({FakeSyncServer? sync, FakeAttachmentServer? attachments, ScriptedServer? api})
      : sync = sync ?? FakeSyncServer(),
        attachments = attachments ?? FakeAttachmentServer(chunkBytes: 1024 * 1024),
        api = api ?? ScriptedServer();

  final FakeSyncServer sync;
  final FakeAttachmentServer attachments;
  final ScriptedServer api;
  bool _offline = false;

  bool get offline => _offline;

  set offline(bool value) {
    _offline = value;
    sync.offline = value;
    attachments.offline = value;
    api.offline = value;
  }

  @override
  Future<HttpResult> send(HttpCall call) {
    final String path = call.url.path.replaceFirst('/v1', '');
    if (path.startsWith('/sync/attachments')) return attachments.send(call);
    if (path.startsWith('/sync/')) return sync.send(call);
    return api.send(call);
  }
}

/// The reads the capture form needs.
void answerLookups(ScriptedServer api, {bool empty = false}) {
  api
    ..on('GET', '/resources/project', (_) => _page(empty ? <Object?>[] : <Object?>[<String, Object?>{'id': 'p-1', 'code': 'PRJ-A-001', 'name': 'Đường tỉnh ĐT.A1'}]))
    ..on('GET', '/resources/organization_unit', (_) => _page(<Object?>[<String, Object?>{'id': 'u-1', 'code': 'CDT-A-01', 'name': 'Ban QLDA giao thông A'}]))
    ..on('GET', '/master-records', (_) => _page(<Object?>[<String, Object?>{'version_id': 'c-1', 'business_key': 'MAT_BANG', 'label': 'Mặt bằng', 'status': 'EFFECTIVE'}]));
}

Map<String, Object?> _page(List<Object?> items) => <String, Object?>{'items': items, 'next_cursor': null, 'as_of': '2026-11-03T02:00:00Z'};

/// An issue as the server shows it.
Map<String, Object?> issueView(String id, {String status = 'OPEN', List<Object?> events = const <Object?>[], bool overdue = false, Map<String, Object?>? geo, bool geoConsent = false, int version = 1}) => <String, Object?>{
      'id': id,
      'code': 'ISS-0001',
      'title': 'Sạt lở taluy km3',
      'description': 'Đất đá đổ ra mặt đường.',
      'project_id': 'p-1',
      'project_code': 'PRJ-A-001',
      'project_name': 'Đường tỉnh ĐT.A1',
      'category_label': 'Mặt bằng',
      'severity': 'HIGH',
      'status': status,
      'owner_unit_id': 'u-1',
      'owner_unit_name': 'Ban QLDA giao thông A',
      'assignee': status == 'OPEN' ? null : <String, Object?>{'membership_id': 'm-9', 'display_name': 'Trần Văn B'},
      'opened_at': '2026-11-03T01:00:00Z',
      'response_due_at': '2026-11-03T05:00:00Z',
      'responded_at': null,
      'due_at': '2026-11-05T10:00:00Z',
      'overdue_since': overdue ? '2026-11-05T10:00:00Z' : null,
      'closed_at': null,
      'version': version,
      'sla': <String, Object?>{'policy_code': 'SLA-HIGH', 'policy_revision': 1, 'response_hours': 4, 'resolve_hours': 48},
      'geo_consent': geoConsent,
      'geo': geo,
      'events': events,
    };

Map<String, Object?> issueEvent(String id, String kind, {String? note, String at = '2026-11-03T01:00:00Z', String? actor}) =>
    <String, Object?>{'id': id, 'kind': kind, 'created_at': at, if (note != null) 'note': note, if (actor != null) 'actor': <String, Object?>{'membership_id': 'm-1', 'display_name': actor}};

/// One phone: its encrypted store, its network, its permissions, its camera, its position.
class FieldWorld {
  FieldWorld._(this.storage, this.server, this.folder);

  final TestStorage storage;
  final FieldServer server;
  final Directory folder;
  final FakePermissions permissionsPlatform = FakePermissions();
  final FakePhotos photos = FakePhotos();
  final FakePosition position = FakePosition();
  late ProviderContainer container;
  DateTime now = DateTime.utc(2026, 11, 3, 3, 0);

  static FieldWorld create({FieldServer? server}) {
    final Directory folder = Directory.systemTemp.createTempSync('machvon-field-');
    addTearDown(() => removeTempDirectory(folder));
    return FieldWorld._(TestStorage.create(), server ?? FieldServer(), folder);
  }

  /// A file of the gallery.
  File file(String name, List<int> bytes) => File('${folder.path}/$name')..writeAsBytesSync(bytes);

  Future<ProviderContainer> open(
    WidgetTester tester,
    String location, {
    FakeSession? session,
    Locale locale = const Locale('vi'),
    List<Override> overrides = const <Override>[],
    List<MobileFeature> extra = const <MobileFeature>[],
  }) async {
    final SessionSnapshotUser user = SessionSnapshotUser.of(session);
    (await storage.open(tenantId: user.tenant, userId: user.user)).deviceId = kDeviceId;
    final MemorySecureStore secure = MemorySecureStore();
    container = await pumpApp(
      tester,
      features: <MobileFeature>[read_support.feature, evidence.feature, issues.feature, offline.feature, permissions.feature, ...extra],
      session: session,
      locale: locale,
      overrides: <Override>[
        httpTransportProvider.overrideWith((Ref ref) => ObservingTransport(server, ref.read(reachabilityProvider.notifier).report)),
        clockProvider.overrideWithValue(() => now),
        offlineStorageProvider.overrideWithValue(storage.storage),
        chunkTransportProvider.overrideWithValue(server.attachments),
        permissionPlatformProvider.overrideWithValue(permissionsPlatform),
        secureValueStoreProvider.overrideWithValue(secure),
        photoSourceProvider.overrideWithValue(photos),
        positionSourceProvider.overrideWithValue(position),
        ...overrides,
      ],
      location: location,
    );
    return container;
  }
}

extension FieldWorldDrafts on FieldWorld {
  /// Writes a complete draft on the phone, as the person would have, and returns its id.
  Future<String> seedDraft(WidgetTester tester, {bool consent = false, String title = 'Sạt lở taluy km3', FieldPlace? place, List<IssuePhoto> photos = const <IssuePhoto>[]}) async {
    final IssueService service = container.read(issueServiceProvider);
    final IssueDraft draft = service.blank().copyWith(
          projectId: 'p-1',
          projectLabel: 'PRJ-A-001 · Đường tỉnh ĐT.A1',
          ownerUnitId: 'u-1',
          ownerUnitLabel: 'CDT-A-01 · Ban QLDA giao thông A',
          categoryVersionId: 'c-1',
          categoryLabel: 'MAT_BANG · Mặt bằng',
          severity: 'HIGH',
          title: title,
          description: 'Đất đá đổ ra mặt đường.',
          place: place ?? (consent ? FieldPlace.none.withConsent(true) : FieldPlace.none),
          photos: photos,
        );
    return (await tester.runAsync(() => service.save(draft)))!;
  }

  Future<void> go(WidgetTester tester, String location) async {
    container.read(routerProvider).go(location);
    await settleReal(tester, rounds: 10);
  }
}

/// The tenant and the person of a session in a test.
class SessionSnapshotUser {
  const SessionSnapshotUser(this.tenant, this.user);

  final String tenant;
  final String user;

  static SessionSnapshotUser of(FakeSession? session) => SessionSnapshotUser(session?.initial.tenantId ?? 'tenant-a', session?.initial.userId ?? 'user-1');
}

/// Real time for a test that reads and writes files and talks to the encrypted store: the fake clock of a widget test never lets
/// those finish.
Future<void> settleReal(WidgetTester tester, {int rounds = 40}) async {
  for (int i = 0; i < rounds; i += 1) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// Real time passes until [done] is true (a file was written, an isolate finished); the screen is pumped as it goes.
Future<void> waitUntil(WidgetTester tester, Future<bool> Function() done, {int seconds = 30}) async {
  for (int i = 0; i < seconds * 20; i += 1) {
    if ((await tester.runAsync(done)) ?? false) break;
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump(const Duration(milliseconds: 50));
  }
  await tester.pump(const Duration(milliseconds: 100));
}

Future<void> tapText(WidgetTester tester, String label, {int index = 0}) async {
  final Finder finder = find.text(label).at(index);
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder, warnIfMissed: false);
  await settleReal(tester, rounds: 12);
}

Uint8List bytesOf(File file) => file.readAsBytesSync();
