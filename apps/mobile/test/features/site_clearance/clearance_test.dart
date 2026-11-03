import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_uploader.dart';
import 'package:machvon_mobile/core/offline/drafts/draft_store.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';
import 'package:machvon_mobile/features/command_support/command_outcome.dart';
import 'package:machvon_mobile/features/read_support/read_cache.dart';
import 'package:machvon_mobile/features/read_support/wire.dart' show Json;
import 'package:machvon_mobile/features/site_clearance/clearance_commands.dart';
import 'package:machvon_mobile/features/site_clearance/clearance_models.dart';
import 'package:machvon_mobile/features/site_clearance/clearance_support.dart';
import 'package:machvon_mobile/features/site_clearance/inventory_drafts.dart';
import 'package:machvon_mobile/features/site_clearance/inventory_rules.dart';
import 'package:machvon_mobile/features/site_clearance/site_clearance_feature.dart' as clearance;

import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'fixtures.dart';

const String _projects = '/projects/mob-68';
const String _households = '/projects/mob-68?project=p-1';
const String _task = '/projects/mob-68?project=p-1&household=h-1';

FakeSession _officer({SessionMode mode = SessionMode.full}) =>
    FakeSession(SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1', mode: mode));

/// A read cache that remembers everything written to it: the test then looks at what the phone would keep.
final class _Spy implements ReadCache {
  final Map<String, CacheEntry> entries = <String, CacheEntry>{};
  final List<Object?> written = <Object?>[];

  @override
  Future<CacheEntry?> read(CacheScope scope, String key) async => entries[key];

  @override
  Future<void> write(CacheScope scope, String key, CacheEntry entry) async {
    entries[key] = entry;
    written.add(entry.raw);
  }

  @override
  Future<void> forget(CacheScope scope, String key) async => entries.remove(key);

  @override
  Future<void> clear() async => entries.clear();
}

final class _Rig {
  _Rig() : storage = TestStorage.create();

  final TestStorage storage;
  final _Spy spy = _Spy();
}

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {_Rig? rig, FakeSession? session, Locale locale = const Locale('vi')}) async {
  final _Rig r = rig ?? _Rig();
  await r.storage.open();
  return pumpWithServer(
    tester,
    features: <MobileFeature>[clearance.feature],
    server: server,
    location: location,
    session: session ?? _officer(),
    locale: locale,
    overrides: [
      offlineStorageProvider.overrideWithValue(r.storage.storage),
      readCacheProvider.overrideWithValue(r.spy),
    ],
  );
}

void _reads(ScriptedServer server, {List<Object?>? records, Map<String, Object?>? onlyHousehold}) {
  server
    ..on('GET', '/resources/project', (_) => page(<Object?>[project('p-1', 'DA-001', 'Đường vành đai 1')]))
    ..on('GET', '/affected-households', (_) => page(<Object?>[onlyHousehold ?? household('h-1', consent: 'cr-1'), household('h-2', code: 'HH-A-002', parcels: <Map<String, Object?>>[parcel('pa-2', 'TH-002'), parcel('pa-3', 'TH-003', right: 'LESSEE')])]))
    ..on('GET', '/land-inventory-records', (_) => page(records ?? <Object?>[record('r-1'), record('r-2', status: 'CONFIRMED', surveyedBy: 'mem-1', description: 'Cây xoài 10 năm tuổi', kind: 'TREE', quantity: '12', price: '800000', amount: '9600000')]));
}

Finder _field(String label) => find.widgetWithText(TextField, label);

Future<void> _fillForm(WidgetTester tester, {String kind = 'Nhà', String description = 'Nhà cấp 4', String quantity = '80', String unit = 'm2', String price = '4500000', String reference = 'QD-GIA-2026', String? day}) async {
  await tester.ensureVisible(find.text('Loại tài sản'));
  await tester.tap(find.widgetWithText(DropdownButtonFormField<String>, 'Loại tài sản'));
  await tester.pumpAndSettle();
  await tester.tap(find.text(kind).last);
  await tester.pumpAndSettle();
  await tester.enterText(_field('Mô tả tài sản'), description);
  await tester.enterText(_field('Số lượng'), quantity);
  await tester.enterText(_field('Đơn vị tính'), unit);
  await tester.enterText(_field('Đơn giá (đồng)'), price);
  await tester.enterText(_field('Quyết định giá áp dụng'), reference);
  if (day != null) await tester.enterText(_field('Ngày khảo sát (năm-tháng-ngày)'), day);
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Finder _keep() => find.widgetWithText(OutlinedButton, 'Lưu trên máy');
Finder _keepAndSend() => find.widgetWithText(FilledButton, 'Lưu và gửi');

List<LocalDraft> _drafts(LocalStore store) => store.drafts.all();

void main() {
  group('UI-MOB-68 MOB-68 the projects, the households and the task', () {
    testWidgets('chooses a project, lists its households by code with their parcels, and opens one', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, _projects);

      expect(find.text('DA-001'), findsOneWidget);
      await tester.tap(find.text('DA-001'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), _households);
      expect(find.text('Hộ HH-A-001'), findsOneWidget);
      expect(find.text('Hộ HH-A-002'), findsOneWidget);
      expect(find.text('Thửa: TH-001'), findsOneWidget);
      expect(find.text('Thửa: TH-002, TH-003'), findsOneWidget);
      expect(find.textContaining('Điện thoại chỉ giữ mã hộ'), findsOneWidget);
      expect(server.callsTo('GET', '/affected-households').first.url.queryParameters, containsPair('project_id', 'p-1'));

      await tester.tap(find.text('Hộ HH-A-001'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), _task);
      expect(find.text('Mã hộ:'), findsOneWidget);
    });

    testWidgets('no name, identity number, telephone or address of a household is ever on the screen, although the server sent masked ones', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _households);
      for (final String leaked in <String>['Nguyễn', '•••', 'Quận 1']) {
        expect(find.textContaining(leaked), findsNothing, reason: leaked);
      }
      await _open(tester, server, _task);
      for (final String leaked in <String>['Nguyễn', '•••', 'Quận 1']) {
        expect(find.textContaining(leaked), findsNothing, reason: leaked);
      }
      expect(server.callsTo('GET', '/affected-households/h-1/identity'), isEmpty, reason: 'the identity is opened on the web, never asked for by the phone');
    });

    testWidgets('shows the household by its code, its parcels, its consent, and the inventory with the amounts the server computed', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, onlyHousehold: household('h-1', basis: 'CONSENT', consent: 'cr-1', status: 'INVENTORIED'));
      await _open(tester, server, _task);

      expect(find.text('HH-A-001'), findsOneWidget);
      expect(find.text('Đã kiểm đếm'), findsOneWidget);
      expect(find.text('4'), findsOneWidget);
      expect(find.text('Sự đồng ý của hộ'), findsOneWidget, reason: 'the basis');
      expect(find.text('Sự đồng ý của hộ:'), findsOneWidget, reason: 'the line about the consent record');
      expect(find.text('Đã có biên bản đồng ý'), findsOneWidget);
      expect(find.text('Thửa TH-001: chủ sử dụng'), findsOneWidget);
      expect(find.text('Nhà: Nhà cấp 4, tường gạch'), findsOneWidget);
      expect(find.text('80 m2 · thửa TH-001 · thành tiền 360.000.000 đồng'), findsOneWidget);
      expect(find.text('Chờ hộ trả lời · khảo sát 20/10/2026'), findsOneWidget);
      expect(find.text('Cây: Cây xoài 10 năm tuổi'), findsNothing);
      expect(find.text('Cây trồng: Cây xoài 10 năm tuổi'), findsOneWidget);
      expect(find.text('Hộ đã xác nhận · khảo sát 20/10/2026'), findsOneWidget);
      expect(find.textContaining('Hệ thống chưa có thao tác đặt lịch hẹn'), findsOneWidget);
    });

    testWidgets('a household that asked for restricted processing or was anonymised is not worked on', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, onlyHousehold: household('h-1', restricted: true, anonymised: true));
      await _open(tester, server, _task);
      expect(find.textContaining('Hộ đã đề nghị hạn chế xử lý dữ liệu'), findsOneWidget);
      expect(find.textContaining('đã được xóa theo đề nghị'), findsOneWidget);
      expect(find.textContaining('không ghi kiểm đếm mới trên điện thoại'), findsOneWidget);
      expect(find.text('Lưu và gửi'), findsNothing);
    });

    testWidgets('restricted processing alone, and anonymisation alone, each stop a new count', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer restricted = ScriptedServer();
      _reads(restricted, onlyHousehold: household('h-1', restricted: true));
      await _open(tester, restricted, _task);
      expect(find.textContaining('Hộ đã đề nghị hạn chế xử lý dữ liệu'), findsOneWidget);
      expect(find.textContaining('đã được xóa theo đề nghị'), findsNothing);
      expect(find.text('Lưu và gửi'), findsNothing);

      final ScriptedServer anonymised = ScriptedServer();
      _reads(anonymised, onlyHousehold: household('h-1', anonymised: true));
      await _open(tester, anonymised, _task);
      expect(find.textContaining('đã được xóa theo đề nghị'), findsOneWidget);
      expect(find.text('Lưu và gửi'), findsNothing);
    });

    testWidgets('a household with no parcel cannot be counted, and says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, onlyHousehold: household('h-1', parcels: <Map<String, Object?>>[]));
      await _open(tester, server, _task);
      expect(find.textContaining('chưa được gắn với thửa đất nào'), findsOneWidget);
      await _open(tester, server, _households);
      expect(find.text('Chưa gắn thửa đất'), findsOneWidget);
    });

    testWidgets('every state is drawn and the contract of the three views holds', (WidgetTester tester) async {
      for (final (String location, Finder content, bool empty) in <(String, Finder, bool)>[
        (_projects, find.text('DA-001'), true),
        (_households, find.text('Hộ HH-A-001'), true),
        (_task, find.text('Kết quả kiểm đếm'), false),
      ]) {
        await expectEveryState(
          tester,
          open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, location),
          script: StateScript(
            healthy: _reads,
            content: content,
            empty: !empty
                ? null
                : (ScriptedServer server) {
                    server
                      ..on('GET', '/resources/project', (_) => page(<Object?>[]))
                      ..on('GET', '/affected-households', (_) => page(<Object?>[]));
                  },
          ),
        );
        await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, location), healthy: _reads);
      }
    });
  });

  group('AC-ST-MOB-024-3 UAT-PLAN-39 a household outside the scope of the officer is not found, and nothing of it is described', () {
    testWidgets('officer Y opens the task of officer X: 404 RESOURCE_NOT_FOUND, the not-found state, no household and no form', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.refuse('GET', '/land-inventory-records', 404, 'RESOURCE_NOT_FOUND');
      await _open(tester, server, _task);

      expect(find.text('RESOURCE_NOT_FOUND'), findsOneWidget);
      expect(find.text('HH-A-001'), findsNothing);
      expect(find.text('Lưu và gửi'), findsNothing);
      expect(find.text('Kết quả kiểm đếm'), findsNothing);
      expect(server.callsTo('GET', '/affected-households'), isEmpty, reason: 'the register is not even read once the task is not found');
    });

    testWidgets('a household that is not in the register of the officer is a contract mismatch, not a task', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, '/projects/mob-68?project=p-1&household=h-9');
      expect(find.text('CONTRACT_MISMATCH'), findsOneWidget);
      expect(find.text('Lưu và gửi'), findsNothing);
    });
  });

  group('AC-ST-MOB-024-2 UAT-AC379 the phone holds no national id and no household identity', () {
    testWidgets('what is copied for the offline view and what is kept in the encrypted store hold none of it, and the screens never ask for it', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final _Rig rig = _Rig();
      await _open(tester, server, _projects, rig: rig);
      await _open(tester, server, _households, rig: rig);
      await _open(tester, server, _task, rig: rig);
      await _fillForm(tester);
      await _tap(tester, _keep());

      final LocalStore store = await rig.storage.open();
      final String everything = jsonEncode(<Object?>[
        ...rig.spy.written,
        for (final LocalDraft draft in _drafts(store)) <Object?>[draft.kind, draft.recordId, draft.fields],
      ]);
      expect(rig.spy.written, isNotEmpty);
      expect(_drafts(store), hasLength(1));
      for (final String forbidden in <String>['national', 'head_name', 'phone', 'address', '0001', 'Nguyễn', '•••', 'Quận 1', 'cr-1', 'QĐ-123']) {
        expect(everything, isNot(contains(forbidden)), reason: forbidden);
      }
      expect(everything, contains('HH-A-001'), reason: 'the code of the household is the reference the phone keeps');
      expect(everything, contains('pa-1'));
      expect(server.calls.where((HttpCall call) => call.url.path.contains('identity')), isEmpty);
      expect(server.calls.where((HttpCall call) => call.method != 'GET'), isEmpty);
    });

    test('a household is cut down to a code, its parcels, its status and whether consent is on record', () {
      final Json reduced = minimiseHousehold(household('h-1', consent: 'cr-1'))!;
      expect(reduced.keys.toSet(), <String>{'id', 'household_code', 'status', 'legal_basis', 'has_consent_record', 'processing_restricted', 'anonymised', 'member_count', 'parcels'});
      expect(jsonEncode(reduced), isNot(contains('cr-1')));
      expect((reduced['parcels']! as List<Object?>).single, <String, Object?>{'parcel_id': 'pa-1', 'parcel_code': 'TH-001', 'right_kind': 'OWNER'});
      expect(minimiseHousehold(<String, Object?>{'id': 'x'}), isNull);
      expect(minimiseHousehold('nope'), isNull);

      final Json register = minimiseRegister(<String, Object?>{'items': <Object?>[household('h-1'), 'junk'], 'next_cursor': 'c', 'as_of': '2026-11-03T00:00:00Z', 'summary': <String, Object?>{'phone': '0900000001'}});
      expect(register.keys.toSet(), <String>{'items', 'next_cursor', 'as_of'});
      expect(parseHouseholdRegister(register)!.more, isTrue);

      final Json record_ = minimiseRecord(record('r-1'))!;
      expect(record_.containsKey('owner_unit_id'), isFalse);
      expect(record_.containsKey('confirmed_by'), isFalse);
      expect(record_.containsKey('document_version_id'), isFalse);
      expect(record_['description'], 'Nhà cấp 4, tường gạch');
      expect(minimiseRecord('nope'), isNull);
    });
  });

  group('AC-ST-MOB-024-1 UAT-AC380 the answer of the household is refused without consent: 422 CONSENT_REQUIRED', () {
    Finder open() => find.widgetWithText(OutlinedButton, 'Ghi ý kiến của hộ');
    Finder submit() => find.widgetWithText(FilledButton, 'Ghi nhận trả lời của hộ');

    Future<void> choose(WidgetTester tester, String label) async {
      await _tap(tester, find.widgetWithText(DropdownButtonFormField<String>, 'Hộ trả lời'));
      await tester.tap(find.text(label).last);
      await tester.pumpAndSettle();
    }

    testWidgets('confirming without the consent of the household is refused with its code, nothing is recorded, and the form stays', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/land-inventory-records/r-1/confirm', (_) => problem(422, 'CONSENT_REQUIRED', detail: 'consent_record_id'));
      await _open(tester, server, _task);

      await _tap(tester, open());
      await choose(tester, 'Hộ xác nhận kết quả kiểm đếm');
      await _tap(tester, submit());

      expect(server.callsTo('POST', '/land-inventory-records/r-1/confirm'), hasLength(1));
      expect(find.text('Hộ chưa có sự đồng ý được ghi nhận cho việc này nên chưa xác nhận kiểm đếm được.'), findsOneWidget);
      expect(find.text('CONSENT_REQUIRED'), findsOneWidget);
      expect(find.text('Đã ghi nhận'), findsNothing);
      expect(submit(), findsOneWidget, reason: 'the form is still there');
    });

    testWidgets('a confirmation is one request under the version of the record, then the task is read again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/land-inventory-records/r-1/confirm', (_) => recorded('r-1', version: 3, status: 'CONFIRMED'));
      await _open(tester, server, _task);
      final int reads = server.callsTo('GET', '/land-inventory-records').length;

      await _tap(tester, open());
      expect(find.widgetWithText(TextField, 'Ngày hộ trả lời (năm-tháng-ngày)').evaluate().single.widget, isA<TextField>());
      expect(tester.widget<TextField>(_field('Ngày hộ trả lời (năm-tháng-ngày)')).controller!.text, '2026-11-03', reason: 'the day is offered from the clock, the server judges it');
      await choose(tester, 'Hộ xác nhận kết quả kiểm đếm');
      await tester.enterText(_field('Ý kiến của hộ'), '  Đồng ý  ');
      await _tap(tester, submit());

      final HttpCall call = server.callsTo('POST', '/land-inventory-records/r-1/confirm').single;
      expect(call.headers['if-match'], '"2"');
      expect(call.headers['idempotency-key'], isNotEmpty);
      expect(jsonDecode(call.body!), <String, Object?>{'outcome': 'CONFIRMED', 'household_confirmed_on': '2026-11-03', 'note': 'Đồng ý'});
      expect(find.text('Đã ghi nhận'), findsOneWidget);
      expect(server.callsTo('GET', '/land-inventory-records'), hasLength(reads + 1));
    });

    testWidgets('the form stops an answer without an outcome, a day that is not a day or is before the survey, and an objection without its reason', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _task);
      await _tap(tester, open());

      await _tap(tester, submit());
      expect(find.text('Hãy chọn hộ xác nhận hay phản đối.'), findsOneWidget);
      await choose(tester, 'Hộ phản đối kết quả kiểm đếm');
      await tester.enterText(_field('Ngày hộ trả lời (năm-tháng-ngày)'), '2026-02-30');
      await _tap(tester, submit());
      expect(find.text('Ngày không phải một ngày có thật (năm-tháng-ngày).'), findsOneWidget);
      expect(find.text('Phản đối cần ghi rõ lý do.'), findsOneWidget);
      await tester.enterText(_field('Ngày hộ trả lời (năm-tháng-ngày)'), '2026-10-01');
      await _tap(tester, submit());
      expect(find.text('Ngày trả lời không được trước ngày khảo sát.'), findsOneWidget);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('the officer who counted a record is not offered its answer, and a record that is answered already is not either', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, records: <Object?>[record('r-1', surveyedBy: 'mem-1'), record('r-2', status: 'DISPUTED', note: 'Không đồng ý với đơn giá')]);
      await _open(tester, server, _task);
      expect(open(), findsNothing);
      expect(find.text('Ý kiến phản đối: Không đồng ý với đơn giá'), findsOneWidget);
      expect(find.text('Hộ có ý kiến phản đối · khảo sát 20/10/2026'), findsOneWidget);
    });

    testWidgets('the other refusals each have their words and the code', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Map<String, String> expected = <String, String>{
        'SELF_APPROVAL_DENIED': 'Người kiểm đếm không được tự ghi nhận trả lời của hộ. Hãy nhờ cán bộ khác.',
        'INVENTORY_STATE_INVALID': 'Bản ghi này đã có trả lời, không ghi lại được.',
        'VERSION_CONFLICT': 'Bản ghi vừa được người khác thay đổi. Hãy mở lại để xem tình trạng hiện tại.',
        'MFA_REQUIRED': 'Cần xác thực lại hai yếu tố. Chưa ghi nhận gì; hãy hoàn tất bước xác thực rồi thử lại.',
        'LICENSE_EXPIRED': 'License đã hết hạn nên chưa thực hiện được.',
        'SCOPE_DENIED': 'Bạn không có quyền thực hiện thao tác này với hộ này.',
        'RESOURCE_NOT_FOUND': 'Không tìm thấy.',
        'VALIDATION_FAILED': 'Thông tin chưa hợp lệ (ví dụ ngày khảo sát ở tương lai). Hãy kiểm tra lại các ô đã nhập.',
        'SESSION_EXPIRED': 'Phiên làm việc đã hết hạn. Đăng nhập lại rồi thử lại.',
        'LEGAL_BASIS_REQUIRED': 'Hộ chưa có căn cứ pháp lý để xử lý dữ liệu.',
        'DOCUMENT_NOT_CLEAN': 'Tệp biên bản chưa được quét sạch.',
        'ODD_ONE': 'Chưa thực hiện được. Hãy thử lại.',
      };
      for (final MapEntry<String, String> entry in expected.entries) {
        final ScriptedServer server = ScriptedServer();
        _reads(server);
        server.answer('POST', '/land-inventory-records/r-1/confirm', (_) => problem(entry.key == 'SESSION_EXPIRED' ? 401 : 409, entry.key));
        await _open(tester, server, _task);
        await _tap(tester, open());
        await choose(tester, 'Hộ xác nhận kết quả kiểm đếm');
        await _tap(tester, submit());
        expect(find.text(entry.value), findsOneWidget, reason: entry.key);
      }
    });

    testWidgets('offline the answer of the household is not recorded: the button is disabled with the reason, nothing is queued or sent', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, _task);
      await _tap(tester, open());
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(container.read(reachabilityProvider), Reachability.offline);
      expect(find.textContaining('Cần kết nối mạng để gửi hoặc ghi nhận trả lời của hộ'), findsWidgets);
      expect(tester.widget<FilledButton>(submit()).onPressed, isNull);
      expect(container.read(syncStatusProvider).pendingCommands, 0);
      server.offline = false;
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });

    testWidgets('a lost answer is "result unknown": sending the same answer again reuses the key', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      int attempt = 0;
      server.answer('POST', '/land-inventory-records/r-1/confirm', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('r-1', status: 'CONFIRMED');
      });
      await _open(tester, server, _task);
      await _tap(tester, open());
      await choose(tester, 'Hộ xác nhận kết quả kiểm đếm');
      await _tap(tester, submit());
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      await _tap(tester, find.text('Gửi lại cùng thao tác'));
      final List<HttpCall> calls = server.callsTo('POST', '/land-inventory-records/r-1/confirm');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(find.text('Đã ghi nhận'), findsOneWidget);
    });
  });

  group('TK-MOB-024-1 TK-MOB-024-4 inventory counted in the field: kept on the encrypted device offline, sent when the network is there', () {
    testWidgets('with no network the record is kept on the phone and nothing is sent; the send button says why it is off', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final _Rig rig = _Rig();
      final ProviderContainer container = await _open(tester, server, _task, rig: rig);
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(container.read(reachabilityProvider), Reachability.offline);

      await _fillForm(tester);
      expect(find.text('Thành tiền: 360.000.000 đồng'), findsOneWidget);
      expect(tester.widget<FilledButton>(_keepAndSend()).onPressed, isNull);
      await tester.ensureVisible(find.textContaining('Cần kết nối mạng để gửi hoặc ghi nhận trả lời của hộ'));
      await _tap(tester, _keep());

      expect(find.text('Nhà: 80 m2 · thửa TH-001'), findsOneWidget);
      expect(find.text('Chờ gửi'), findsOneWidget);
      final LocalStore store = await rig.storage.open();
      final LocalDraft draft = _drafts(store).single;
      expect(draft.kind, 'land.inventory');
      expect(draft.fields['household_code'], 'HH-A-001');
      expect(draft.fields['quantity'], '80');
      expect(draft.fields['attempt_key'], isNotEmpty);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi')).onPressed, isNull);
      expect(server.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
      expect(container.read(syncStatusProvider).pendingCommands, 0, reason: 'a kept record is not a queued command');
    });

    testWidgets('the kept record survives a restart of the application, and online it is sent under the key it was made with', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/land-inventory-records', (_) => recorded('r-9', version: 1, status: 'DRAFT'));
      final _Rig rig = _Rig();
      await _open(tester, server, _task, rig: rig);
      await _fillForm(tester, quantity: '12,5', description: ' Mặt tiền ');
      await _tap(tester, _keep());
      final String key = (await rig.storage.open()).drafts.all().single.fields['attempt_key']! as String;

      await _open(tester, server, _task, rig: rig);
      expect(find.text('Nhà: 12.5 m2 · thửa TH-001'), findsOneWidget, reason: 'the comma of a Vietnamese keyboard is a decimal point for the server');
      await _tap(tester, find.widgetWithText(FilledButton, 'Gửi'));

      final HttpCall call = server.callsTo('POST', '/land-inventory-records').single;
      expect(call.headers['idempotency-key'], key);
      expect(jsonDecode(call.body!), <String, Object?>{
        'household_id': 'h-1',
        'parcel_id': 'pa-1',
        'item_kind': 'HOUSE',
        'description': 'Mặt tiền',
        'quantity': '12.5',
        'unit_code': 'm2',
        'unit_price_vnd': '4500000',
        'price_decision_ref': 'QD-GIA-2026',
        'surveyed_on': '2026-11-03',
      });
      expect(find.text('Đã ghi nhận'), findsOneWidget);
      expect(find.text('Không có bản nháp nào.'), findsOneWidget, reason: 'the draft has done its work');
      expect((await rig.storage.open()).drafts.all(), isEmpty);
    });

    testWidgets('keep and send, with the network, sends at once; a lost answer is sent again under the same key and recorded once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      int attempt = 0;
      server.answer('POST', '/land-inventory-records', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('r-9', status: 'DRAFT');
      });
      final _Rig rig = _Rig();
      await _open(tester, server, _task, rig: rig);
      await _fillForm(tester);
      await _tap(tester, _keepAndSend());
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      expect((await rig.storage.open()).drafts.all(), hasLength(1), reason: 'the record is kept until the server has answered');

      await _tap(tester, find.text('Gửi lại cùng thao tác'));
      final List<HttpCall> calls = server.callsTo('POST', '/land-inventory-records');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect((await rig.storage.open()).drafts.all(), isEmpty);
    });

    testWidgets('a final refusal keeps the record with its code, and sending it again after the correction is a new command', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      int attempt = 0;
      server.answer('POST', '/land-inventory-records', (_) {
        attempt += 1;
        return attempt == 1 ? problem(422, 'PRICE_DECISION_NOT_EFFECTIVE') : recorded('r-9', status: 'DRAFT');
      });
      final _Rig rig = _Rig();
      await _open(tester, server, _task, rig: rig);
      await _fillForm(tester);
      await _tap(tester, _keepAndSend());

      expect(find.text('Quyết định giá này chưa có hiệu lực vào ngày khảo sát.'), findsOneWidget);
      expect(find.text('PRICE_DECISION_NOT_EFFECTIVE'), findsOneWidget);
      expect(find.text('Máy chủ từ chối: PRICE_DECISION_NOT_EFFECTIVE. Sửa rồi gửi lại.'), findsOneWidget);
      final String firstKey = (await rig.storage.open()).drafts.all().single.fields['attempt_key']! as String;

      await _tap(tester, find.text('Sửa'));
      expect(find.text('Sửa bản nháp kiểm đếm'), findsOneWidget);
      await tester.enterText(_field('Quyết định giá áp dụng'), 'QD-GIA-2024');
      await _tap(tester, _keep());
      await _tap(tester, find.widgetWithText(FilledButton, 'Gửi'));

      final List<HttpCall> calls = server.callsTo('POST', '/land-inventory-records');
      expect(calls, hasLength(2));
      expect(calls[0].headers['idempotency-key'], isNot(calls[1].headers['idempotency-key']));
      expect(calls[0].headers['idempotency-key'], isNot(firstKey), reason: 'the refusal gave the draft a new key');
      expect(calls[1].headers['idempotency-key'], firstKey, reason: 'and editing the draft kept that new key');
      expect(calls[1].body, contains('QD-GIA-2024'));
      expect((await rig.storage.open()).drafts.all(), isEmpty);
    });

    testWidgets('the form stops what the server would refuse for its shape, field by field, before anything is kept', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final _Rig rig = _Rig();
      await _open(tester, server, _task, rig: rig);
      await _tap(tester, _keep());
      for (final String message in <String>[
        'Hãy chọn loại tài sản.',
        'Hãy mô tả tài sản.',
        'Hãy nhập số lượng.',
        'Hãy nhập đơn vị tính.',
        'Hãy nhập đơn giá.',
        'Hãy nhập quyết định giá áp dụng.',
      ]) {
        expect(find.text(message), findsOneWidget, reason: message);
      }
      expect((await rig.storage.open()).drafts.all(), isEmpty);

      await _fillForm(tester, quantity: '0', price: '4.500.000', day: '2026-13-01');
      await _tap(tester, _keep());
      expect(find.text('Số lượng phải lớn hơn 0, tối đa 6 chữ số thập phân.'), findsOneWidget);
      expect(find.text('Đơn giá là số đồng nguyên, không có dấu phân cách.'), findsOneWidget);
      expect(find.text('Ngày khảo sát không phải một ngày có thật (năm-tháng-ngày).'), findsOneWidget);
      expect((await rig.storage.open()).drafts.all(), isEmpty);
    });

    testWidgets('a kept record can be deleted, and a household with several parcels asks which one', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, onlyHousehold: household('h-1', parcels: <Map<String, Object?>>[parcel('pa-1', 'TH-001'), parcel('pa-2', 'TH-002')]));
      final _Rig rig = _Rig();
      await _open(tester, server, _task, rig: rig);
      await _fillForm(tester);
      await _tap(tester, _keep());
      expect(find.text('Hãy chọn thửa đất.'), findsOneWidget);

      await _tap(tester, find.widgetWithText(DropdownButtonFormField<String>, 'Thửa đất'));
      await tester.tap(find.text('TH-002').last);
      await tester.pumpAndSettle();
      await _tap(tester, _keep());
      expect(find.text('Nhà: 80 m2 · thửa TH-002'), findsOneWidget);

      await _tap(tester, find.text('Xóa nháp'));
      expect(find.text('Không có bản nháp nào.'), findsOneWidget);
      expect((await rig.storage.open()).drafts.all(), isEmpty);
    });

    testWidgets('a read-only organisation can keep a record but not send it', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, _task, session: _officer(mode: SessionMode.readOnly));
      await _fillForm(tester);
      expect(find.text('Tổ chức đang ở chế độ chỉ đọc nên chưa gửi hoặc ghi nhận được.'), findsWidgets);
      expect(tester.widget<FilledButton>(_keepAndSend()).onPressed, isNull);
      await _tap(tester, _keep());
      expect(find.text('Chờ gửi'), findsOneWidget);
    });

    testWidgets('when the store of the phone cannot be opened the screen says nothing can be kept', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final _Rig rig = _Rig();
      await rig.storage.open();
      await pumpWithServer(
        tester,
        features: <MobileFeature>[clearance.feature],
        server: server,
        location: _task,
        session: _officer(),
        overrides: [localStoreProvider.overrideWith((Ref ref) async => throw StateError('disk')), readCacheProvider.overrideWithValue(rig.spy)],
      );
      expect(find.text('Không mở được kho lưu trên máy nên chưa lưu được bản nháp.'), findsOneWidget);
      await _fillForm(tester);
      await _tap(tester, _keep());
      expect(find.text('Nhà: 80 m2 · thửa TH-001'), findsNothing);
    });
  });

  group('TK-MOB-024-1 the photos of the site', () {
    testWidgets('with no picker the screen says photos cannot be added from here, and still opens the list of uploads of the household', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, _task);
      expect(find.textContaining('Bản này chưa mở máy ảnh hoặc thư viện ảnh'), findsOneWidget);
      expect(find.text('Thêm ảnh hiện trường'), findsNothing);

      await _tap(tester, find.text('Xem ảnh đã thêm và tiến độ tải lên'));
      expect(currentLocation(container), '/projects/mob-19?owner=land_inventory&ref=h-1');
    });

    testWidgets('with a picker a photo is added to the uploads of the household, and a file that is refused is said with its code', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final Directory folder = Directory.systemTemp.createTempSync('machvon-clearance-');
      addTearDown(() => folder.deleteSync(recursive: true));
      final File good = File('${folder.path}/anh.pdf')..writeAsBytesSync(<int>[...'%PDF-1.7'.codeUnits, ...List<int>.filled(40, 1)]);
      final File bad = File('${folder.path}/macro.exe')..writeAsBytesSync(<int>[77, 90, 1, 2, 3, 4, 5, 6]);
      final _Rig rig = _Rig();
      await rig.storage.open();
      (await rig.storage.open()).deviceId = '11111111-1111-4111-8111-111111111111';
      final ProviderContainer container = await pumpWithServer(
        tester,
        features: <MobileFeature>[clearance.feature],
        server: server,
        location: _task,
        session: _officer(),
        overrides: [offlineStorageProvider.overrideWithValue(rig.storage.storage), readCacheProvider.overrideWithValue(rig.spy), attachmentPickerProvider.overrideWithValue(() async => <File>[good, bad])],
      );
      expect(find.text('Thêm ảnh hiện trường'), findsOneWidget);
      await tester.ensureVisible(find.text('Thêm ảnh hiện trường'));
      await tester.tap(find.text('Thêm ảnh hiện trường'));
      for (int i = 0; i < 40; i += 1) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
        await tester.pump(const Duration(milliseconds: 25));
      }
      final AttachmentUploader uploader = (await tester.runAsync(() => container.read(attachmentUploaderProvider.future)))!;
      final List<AttachmentUpload> uploads = uploader.uploads();
      expect(uploads, hasLength(1));
      expect(uploads.single.ownerKind, 'land_inventory');
      expect(uploads.single.ownerRef, 'h-1');
      expect(find.text('Ảnh không được nhận: FILE_TYPE_NOT_ALLOWED.'), findsOneWidget);
    });
  });

  group('the rules of the inventory form, as pure functions', () {
    test('the amount is quantity times unit price rounded half up to the dong, on whole numbers', () {
      expect(amountOf('80', '4500000'), '360000000');
      expect(amountOf('12,5', '3'), '38', reason: '37.5 rounds half up');
      expect(amountOf('0.000001', '500000'), '1', reason: '0.5 rounds up');
      expect(amountOf('0.000001', '499999'), '0');
      expect(amountOf('1234567890123456', '999999999999999999999999'), (BigInt.parse('1234567890123456') * BigInt.parse('999999999999999999999999')).toString());
      expect(amountOf('0', '5'), isNull);
      expect(amountOf('-1', '5'), isNull);
      expect(amountOf('80', '4.5'), isNull);
      expect(amountOf('', ''), isNull);
    });

    test('every shape the form refuses', () {
      InventoryForm form({String? parcel = 'pa-1', String? kind = 'HOUSE', String description = 'Nhà', String quantity = '1', String unit = 'm2', String price = '1', String reference = 'QD', String day = '2026-11-03'}) =>
          InventoryForm(parcelId: parcel, itemKind: kind, description: description, quantity: quantity, unitCode: unit, unitPriceVnd: price, priceDecisionRef: reference, surveyedOn: day);
      expect(checkInventory(form()), isEmpty);
      expect(checkInventory(form(parcel: null))['parcel'], InventoryProblem.parcelRequired);
      expect(checkInventory(form(parcel: ''))['parcel'], InventoryProblem.parcelRequired);
      expect(checkInventory(form(kind: null))['kind'], InventoryProblem.kindRequired);
      expect(checkInventory(form(kind: 'ROCKET'))['kind'], InventoryProblem.kindRequired);
      expect(checkInventory(form(description: ' '))['description'], InventoryProblem.descriptionRequired);
      expect(checkInventory(form(description: 'x' * 2001))['description'], InventoryProblem.descriptionTooLong);
      expect(checkInventory(form(description: 'a\u0000b'))['description'], InventoryProblem.descriptionInvalid);
      expect(checkInventory(form(quantity: ''))['quantity'], InventoryProblem.quantityRequired);
      expect(checkInventory(form(quantity: '0.0'))['quantity'], InventoryProblem.quantityInvalid);
      expect(checkInventory(form(quantity: '1.1234567'))['quantity'], InventoryProblem.quantityInvalid);
      expect(checkInventory(form(quantity: '01'))['quantity'], InventoryProblem.quantityInvalid);
      expect(checkInventory(form(quantity: '-2'))['quantity'], InventoryProblem.quantityInvalid);
      expect(checkInventory(form(quantity: '2,5')), isEmpty);
      expect(checkInventory(form(unit: ''))['unit'], InventoryProblem.unitRequired);
      expect(checkInventory(form(unit: 'x' * 51))['unit'], InventoryProblem.unitTooLong);
      expect(checkInventory(form(unit: 'm\n2'))['unit'], InventoryProblem.unitInvalid);
      expect(checkInventory(form(price: ''))['price'], InventoryProblem.priceRequired);
      expect(checkInventory(form(price: '4,5'))['price'], InventoryProblem.priceInvalid);
      expect(checkInventory(form(price: '007'))['price'], InventoryProblem.priceInvalid);
      expect(checkInventory(form(reference: ''))['reference'], InventoryProblem.referenceRequired);
      expect(checkInventory(form(reference: 'x' * 101))['reference'], InventoryProblem.referenceTooLong);
      expect(checkInventory(form(reference: 'q\u0007'))['reference'], InventoryProblem.referenceInvalid);
      expect(checkInventory(form(day: ''))['day'], InventoryProblem.dayRequired);
      expect(checkInventory(form(day: '2026-02-30'))['day'], InventoryProblem.dayInvalid);
      expect(checkInventory(form(day: '3/11/2026'))['day'], InventoryProblem.dayInvalid);
      expect(isCalendarDay('2024-02-29'), isTrue);
      expect(isCalendarDay('2026-02-29'), isFalse);
    });

    test('the answer of a household needs an outcome, a real day not before the survey, and the reason of an objection', () {
      Map<String, AnswerProblem> check({String? outcome = 'CONFIRMED', String day = '2026-11-03', String note = ''}) => checkAnswer(outcome: outcome, answeredOn: day, note: note, surveyedOn: '2026-10-20');
      expect(check(), isEmpty);
      expect(check(outcome: null)['outcome'], AnswerProblem.outcomeRequired);
      expect(check(outcome: 'MAYBE')['outcome'], AnswerProblem.outcomeRequired);
      expect(check(day: '')['day'], AnswerProblem.dayRequired);
      expect(check(day: '2026-11-31')['day'], AnswerProblem.dayInvalid);
      expect(check(day: '2026-10-19')['day'], AnswerProblem.dayBeforeSurvey);
      expect(check(day: '2026-10-20'), isEmpty);
      expect(check(outcome: 'DISPUTED')['note'], AnswerProblem.noteRequired);
      expect(check(outcome: 'DISPUTED', note: 'Giá thấp'), isEmpty);
      expect(check(note: 'x' * 2001)['note'], AnswerProblem.noteTooLong);
      expect(check(note: 'a\u0001')['note'], AnswerProblem.noteInvalid);
    });

    test('only a record that waits for the household, counted by somebody else, may be answered by this officer', () {
      final InventoryRecord mine = parseInventoryRecord(record('r', surveyedBy: 'MEM-1'))!;
      final InventoryRecord other = parseInventoryRecord(record('r'))!;
      final InventoryRecord answered = parseInventoryRecord(record('r', status: 'CONFIRMED'))!;
      expect(mayAnswer(other, 'mem-1'), isTrue);
      expect(mayAnswer(mine, 'mem-1'), isFalse, reason: 'ids compare without case');
      expect(mayAnswer(answered, 'mem-1'), isFalse);
      expect(mayAnswer(other, null), isFalse);
    });

    test('the gate puts offline and copies first, then the read-only mode', () {
      const SessionSnapshot full = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u');
      const SessionSnapshot readOnly = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u', mode: SessionMode.readOnly);
      expect(gateOf(offline: false, fromCopy: false, session: full), ClearanceGate.open);
      expect(gateOf(offline: true, fromCopy: false, session: readOnly), ClearanceGate.offline);
      expect(gateOf(offline: false, fromCopy: true, session: full), ClearanceGate.offline);
      expect(gateOf(offline: false, fromCopy: false, session: readOnly), ClearanceGate.readOnly);
    });

    test('a record the server answered with something that is not a record, or a household without a code, is dropped', () {
      expect(parseInventoryRecord(<String, Object?>{'id': 'x'}), isNull);
      expect(parseInventoryRecord(record('r', price: '4.5')), isNull, reason: 'money is a string of whole dong');
      expect(parseHousehold(<String, Object?>{'id': 'x'}), isNull);
      expect(parseHouseholdRegister(<String, Object?>{'items': 'no'}), isNull);
      expect(parseHouseholdTask(<String, Object?>{'household': null, 'records': <String, Object?>{'items': <Object?>[]}}), isNull);
      expect(parseHousehold(minimiseHousehold(household('h', status: 'WEIRD'))), isNull);
      final HouseholdRegister? register = parseHouseholdRegister(minimiseRegister(<String, Object?>{'items': <Object?>[household('h-2', code: 'B'), household('h-1', code: 'A')]}));
      expect(register!.households.map((Household h) => h.code), <String>['A', 'B']);
      expect(register.byId('h-2')!.code, 'B');
      expect(register.byId('zz'), isNull);
    });

    test('every refusal code maps to its problem', () {
      ClearanceProblem of(String code) => problemOf(CommandRefused(code));
      expect(of('CONSENT_REQUIRED'), ClearanceProblem.consentRequired);
      expect(of('LEGAL_BASIS_REQUIRED'), ClearanceProblem.legalBasis);
      expect(of('PRICE_DECISION_NOT_EFFECTIVE'), ClearanceProblem.priceDecision);
      expect(of('HOUSEHOLD_PARCEL_NOT_LINKED'), ClearanceProblem.parcelNotLinked);
      expect(of('SELF_APPROVAL_DENIED'), ClearanceProblem.selfApproval);
      expect(of('INVENTORY_STATE_INVALID'), ClearanceProblem.stateInvalid);
      expect(of('INVALID_REQUEST'), ClearanceProblem.validation);
      expect(of('PERMISSION_DENIED'), ClearanceProblem.denied);
      expect(of('ENTITLEMENT_DENIED'), ClearanceProblem.denied);
      expect(of('whatever'), ClearanceProblem.general);
    });

    test('the draft store keeps the key of a draft through edits and gives a new one after a final refusal', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore store = await test.open();
      int counter = 0;
      final InventoryDrafts drafts = InventoryDrafts(DraftStore(store), newKey: () => 'key-${counter++}');
      const InventoryForm form = InventoryForm(parcelId: 'pa-1', itemKind: 'TREE', description: 'Xoài', quantity: '3', unitCode: 'cây', unitPriceVnd: '800000', priceDecisionRef: 'QD', surveyedOn: '2026-11-03');
      final InventoryDraft first = drafts.save(householdId: 'h-1', householdCode: 'HH-A-001', parcelId: 'pa-1', parcelCode: 'TH-001', form: form);
      expect(first.attemptKey, 'key-0');
      final InventoryDraft edited = drafts.save(id: first.id, householdId: 'h-1', householdCode: 'HH-A-001', parcelId: 'pa-1', parcelCode: 'TH-001', form: form);
      expect(edited.id, first.id);
      expect(edited.attemptKey, 'key-0');
      final InventoryDraft refused = drafts.refused(edited, 'VALIDATION_FAILED');
      expect(refused.attemptKey, 'key-1');
      expect(refused.lastRefusal, 'VALIDATION_FAILED');
      expect(drafts.save(id: refused.id, householdId: 'h-1', householdCode: 'HH-A-001', parcelId: 'pa-1', parcelCode: 'TH-001', form: form).lastRefusal, 'VALIDATION_FAILED');
      expect(drafts.of('h-1'), hasLength(1));
      expect(drafts.of('h-2'), isEmpty);
      drafts.remove(first.id);
      expect(drafts.of('h-1'), isEmpty);
      expect(InventoryDraft.fromLocal(const LocalDraft(id: 'x', tenantId: 't', userId: 'u', kind: 'report', fields: const <String, Object?>{}, baseServerVersion: 0, status: DraftStatus.editing, createdAt: 0, updatedAt: 0)), isNull);
    });
  });
}
