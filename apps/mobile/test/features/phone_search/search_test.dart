import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/widgets/filter_chips.dart';
import 'package:machvon_mobile/features/phone_search/phone_search_feature.dart' as phone_search;
import 'package:machvon_mobile/features/phone_search/recent_searches.dart';
import 'package:machvon_mobile/features/phone_search/screens/search_screen.dart' show searchTypingPause;
import 'package:machvon_mobile/features/phone_search/search_models.dart';
import 'package:machvon_mobile/features/project_views/project_views_feature.dart' as project_views;
import 'package:machvon_mobile/features/read_support/read_cache.dart';
import 'package:machvon_mobile/features/read_support/widgets.dart' show TappableRow;

import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';

const String r1 = 'a1000000-0000-4000-8000-000000000001';
const String r2 = 'a2000000-0000-4000-8000-000000000002';
const String idIssue = 'a3000000-0000-4000-8000-000000000003';
const String idConversation = 'a4000000-0000-4000-8000-000000000004';
const String idPerson = 'a5000000-0000-4000-8000-000000000005';

Map<String, Object?> hit(String type, String id, {String? title, String classification = 'INTERNAL', String? snippet}) =>
    <String, Object?>{'entity_type': type, 'entity_id': id, 'title': title, 'classification': classification, 'snippet': snippet};

Map<String, Object?> hits(List<Map<String, Object?>> items, {String? next}) => <String, Object?>{'items': items, 'next_cursor': next};

/// A stub of the screen a record opens in: it takes the id.
const MobileFeature _records = MobileFeature(id: 'records', screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-36', pathSuffix: '/:conversationId', builder: _record)]);

Widget _record(BuildContext context, ScreenContext screen) => Text('conversation ${screen.pathParameters.values.single}');

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {TestStorage? storage, FakeSession? session, Locale locale = const Locale('vi'), bool projects = false}) {
  return pumpWithServer(
    tester,
    features: <MobileFeature>[phone_search.feature, _records, if (projects) project_views.feature],
    server: server,
    location: location,
    session: session,
    locale: locale,
    overrides: <Override>[if (storage != null) offlineStorageProvider.overrideWithValue(storage.storage)],
  );
}

Finder get _field => find.widgetWithText(TextField, 'Từ khóa');

Future<void> _search(WidgetTester tester, String keyword) async {
  await tester.enterText(_field, keyword);
  await tester.tap(find.widgetWithText(FilledButton, 'Tìm kiếm'));
  await tester.pumpAndSettle();
}

/// The chips of the kinds scroll sideways when they do not fit: bring one into view, then tap it.
Future<void> _chip(WidgetTester tester, String label) async {
  final Finder chip = find.descendant(of: find.byType(FilterChips<String?>), matching: find.text(label));
  await tester.ensureVisible(chip);
  await tester.tap(chip);
}

void main() {
  group('AC-ST-MOB-027-2 UAT-PLAN-41 a search by a user with scope U-BQL1', () {
    testWidgets('only the in-scope record is listed, the phone adds no scope of its own, and shows no total of any kind', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu Bình An', snippet: 'Gói thầu xây lắp cầu')]));
      await _open(tester, server, '/account/mob-51');

      await _search(tester, 'cầu');

      expect(server.callsTo('GET', '/search').single.url.queryParameters, <String, String>{'q': 'cầu', 'limit': '50'});
      expect(find.text('Cầu Bình An'), findsOneWidget);
      expect(find.text('Gói thầu xây lắp cầu'), findsOneWidget);
      expect(find.textContaining('Danh sách không có tổng số'), findsOneWidget);
      expect(find.textContaining(RegExp(r'\d+ (kết quả|hồ sơ)')), findsNothing, reason: 'a count would show how much lies outside the scope');
    });

    testWidgets('opening the record of the other unit by its id is not found: the screen shows the code and nothing of the record', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu Bình An')]));
      server.refuse('GET', '/resources/project/$r2', 404, 'RESOURCE_NOT_FOUND');
      server.refuse('GET', '/resources/project/$r2/milestones', 404, 'RESOURCE_NOT_FOUND');
      server.refuse('GET', '/resources/project/$r2/risks', 404, 'RESOURCE_NOT_FOUND');
      await _open(tester, server, '/projects/mob-10/$r2', projects: true);

      expect(find.text('RESOURCE_NOT_FOUND'), findsOneWidget);
      expect(find.textContaining('Cầu'), findsNothing);
      expect(find.textContaining(r2), findsNothing);
    });

    testWidgets('a hit opens the record it names, and only the kinds of record the phone has a screen for', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/search', (_) => hits(<Map<String, Object?>>[
            hit('conversation', idConversation, title: 'Hội thoại với hộ dân'),
            hit('issue', idIssue, title: 'Vướng mắc mặt bằng'),
            hit('document', idPerson, title: null, classification: 'PERSONAL'),
          ]));
      final ProviderContainer container = await _open(tester, server, '/account/mob-51');
      await _search(tester, 'dân');

      expect(find.text('Chưa mở được trên điện thoại.'), findsNWidgets(2), reason: 'an issue and a document have no screen on the phone yet');
      expect(find.text('Hồ sơ cá nhân, mở để xem chi tiết'), findsOneWidget, reason: 'the name of a person is not shown by a search');
      expect(find.text('Dữ liệu cá nhân'), findsOneWidget);
      await tester.tap(find.text('Hội thoại với hộ dân'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/inbox/mob-36/$idConversation');
      expect(find.text('conversation $idConversation'), findsOneWidget);
      await pressBack(tester);
      expect(currentLocation(container), '/account/mob-51');
      expect(find.text('Hội thoại với hộ dân'), findsOneWidget, reason: 'back returns to the results where they were left');
    });

    testWidgets('a project hit opens the project, and the id in the path is the id of the hit', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu Bình An')]));
      final ProviderContainer container = await _open(tester, server, '/account/mob-51');
      await _search(tester, 'cầu');
      await tester.tap(find.text('Cầu Bình An'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-10/$r1');
    });

    testWidgets('the results carry what their classification lets them show and the screen shows no more', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/search', (_) => hits(<Map<String, Object?>>[
            hit('project', r1, title: 'Công khai', classification: 'PUBLIC'),
            hit('project', r2, title: 'Mật', classification: 'CONFIDENTIAL'),
          ]));
      await _open(tester, server, '/account/mob-51');
      await _search(tester, 'cầu');

      expect(find.text('Công khai'), findsNWidgets(2), reason: 'the title and the classification pill');
      expect(find.text('Mật'), findsNWidgets(2));
    });
  });

  group('AC-ST-MOB-027-2 the keyword is checked as the server checks it', () {
    testWidgets('a keyword of one character, or of more than 200, is not sent and says what is wrong', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/search', (_) => hits(<Map<String, Object?>>[]));
      await _open(tester, server, '/account/mob-51');

      await _search(tester, 'c');
      expect(find.text('Nhập ít nhất 2 ký tự.'), findsOneWidget);
      await _search(tester, 'a' * 201);
      expect(find.text('Từ khóa tối đa 200 ký tự.'), findsOneWidget);
      expect(server.callsTo('GET', '/search'), isEmpty);

      await _search(tester, '😀😀');
      expect(find.text('Nhập ít nhất 2 ký tự.'), findsNothing);
      expect(server.callsTo('GET', '/search'), hasLength(1), reason: 'two emoji are two characters');
    });

    test('characters are counted, not code units, and blanks around the keyword do not count', () {
      expect(keywordProblem(''), KeywordProblem.tooShort);
      expect(keywordProblem(' a '), KeywordProblem.tooShort);
      expect(keywordProblem('ab'), isNull);
      expect(keywordProblem('😀😀'), isNull);
      expect(keywordProblem('😀' * 200), isNull);
      expect(keywordProblem('😀' * 201), KeywordProblem.tooLong);
      expect(keywordProblem('a' * 200), isNull);
      expect(keywordProblem('a' * 201), KeywordProblem.tooLong);
    });

    testWidgets('the keyword of the address is searched at once, and one that is too short is not', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu Bình An')]));
      await _open(tester, server, '/account/mob-51?q=${Uri.encodeQueryComponent('cầu')}');
      expect(find.text('Cầu Bình An'), findsOneWidget);
      expect(tester.widget<TextField>(_field).controller!.text, 'cầu');

      final ScriptedServer none = ScriptedServer();
      await _open(tester, none, '/account/mob-51?q=c');
      expect(none.callsTo('GET', '/search'), isEmpty);
      expect(find.text('Nhập từ khóa để bắt đầu tìm.'), findsOneWidget);
    });

    testWidgets('emptying the field takes the results away', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu Bình An')]));
      await _open(tester, server, '/account/mob-51');
      await _search(tester, 'cầu');
      expect(find.text('Cầu Bình An'), findsOneWidget);

      await tester.enterText(_field, '');
      await tester.pumpAndSettle();
      expect(find.text('Cầu Bình An'), findsNothing);
      expect(find.text('Nhập từ khóa để bắt đầu tìm.'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-027-2 the kinds of record among the results', () {
    testWidgets('chips narrow the list to one kind and back; a new search starts with all kinds', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Dự án A'), hit('issue', idIssue, title: 'Vướng mắc B'), hit('project', r2, title: 'Dự án C')]));
      await _open(tester, server, '/account/mob-51');
      await _search(tester, 'dự');

      expect(find.byType(FilterChips<String?>), findsOneWidget);
      await _chip(tester, 'Vướng mắc');
      await tester.pumpAndSettle();
      expect(find.text('Vướng mắc B'), findsOneWidget);
      expect(find.text('Dự án A'), findsNothing);
      await _chip(tester, 'Tất cả loại hồ sơ');
      await tester.pumpAndSettle();
      expect(find.text('Dự án A'), findsOneWidget);

      await _chip(tester, 'Dự án');
      await tester.pumpAndSettle();
      expect(find.text('Vướng mắc B'), findsNothing);
      await _search(tester, 'vướng');
      expect(find.text('Vướng mắc B'), findsOneWidget, reason: 'a new search is not narrowed by the last one');
    });

    testWidgets('a list longer than the pages the phone reads says there is more, without a count', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/search', (HttpCall call) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu ${call.url.queryParameters['cursor'] ?? 0}')], next: 'c-${call.url.queryParameters['cursor'] ?? 0}'));
      await _open(tester, server, '/account/mob-51');
      await _search(tester, 'cầu');

      expect(server.callsTo('GET', '/search'), hasLength(4));
      expect(find.text('Còn kết quả chưa hiển thị. Hãy thu hẹp từ khóa.'), findsOneWidget);
    });

    test('a hit without a kind, an id or a known classification is dropped, and an answer without items is unusable', () {
      final SearchResults results = parseSearchResults(hits(<Map<String, Object?>>[hit('project', r1), <String, Object?>{'entity_id': r2, 'classification': 'INTERNAL'}, hit('project', r2, classification: 'SECRET'), hit('', r2)]))!;
      expect(results.hits.map((SearchHit h) => h.entityId), <String>[r1]);
      expect(parseSearchResults(<String, Object?>{'next_cursor': null}), isNull);
      expect(openTargetOf(results.hits.single)!.screenId, 'MOB-10');
      expect(openTargetOf(const SearchHit(entityType: 'issue', entityId: 'x', classification: Classification.internal)), isNull);
    });
  });

  group('AC-ST-MOB-027-2 the search follows the typing', () {
    testWidgets('an acceptable keyword is searched after a pause without a press of the button, and is not remembered until a hit is opened', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final TestStorage storage = TestStorage.create();
      final ScriptedServer server = ScriptedServer()..on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('conversation', idConversation, title: 'Hội thoại với hộ dân')]));
      final ProviderContainer container = await _open(tester, server, '/account/mob-51', storage: storage);

      await tester.enterText(_field, 'dân');
      await tester.pump(const Duration(milliseconds: 100));
      expect(server.callsTo('GET', '/search'), isEmpty, reason: 'the field is still resting');
      await tester.pumpAndSettle(searchTypingPause);
      expect(server.callsTo('GET', '/search'), hasLength(1));
      expect(find.text('Hội thoại với hộ dân'), findsOneWidget);
      final LocalStore store = await storage.open();
      expect(RecentSearches(store).read(), isEmpty, reason: 'a half-typed word is not a search the person made');

      await tester.tap(find.text('Hội thoại với hộ dân'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/inbox/mob-36/$idConversation');
      expect(RecentSearches(store).read(), <String>['dân']);
    });

    testWidgets('a press of the button right after typing searches once: the pause does not search the same keyword again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu Bình An')]));
      await _open(tester, server, '/account/mob-51');
      await _search(tester, 'cầu');
      await tester.pump(searchTypingPause * 2);
      expect(server.callsTo('GET', '/search'), hasLength(1));
    });

    testWidgets('a keyword that is too short waits: nothing is sent and no error is shown before the person presses search', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/search', (_) => hits(<Map<String, Object?>>[]));
      await _open(tester, server, '/account/mob-51');
      await tester.enterText(_field, 'c');
      await tester.pumpAndSettle(searchTypingPause);
      expect(server.callsTo('GET', '/search'), isEmpty);
      expect(find.text('Nhập ít nhất 2 ký tự.'), findsNothing);
    });
  });

  group('AC-ST-MOB-027-2 the recent searches', () {
    testWidgets('the keywords searched for lately are listed while the field is empty, newest first, and a tap searches again', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final TestStorage storage = TestStorage.create();
      final ScriptedServer server = ScriptedServer()..on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu Bình An')]));
      await _open(tester, server, '/account/mob-51', storage: storage);
      expect(find.text('Nhập từ khóa để bắt đầu tìm.'), findsOneWidget, reason: 'nothing searched yet');

      await _search(tester, 'cầu');
      await _search(tester, 'đường');
      await tester.enterText(_field, '');
      await tester.pumpAndSettle();

      expect(find.text('Tìm gần đây'), findsOneWidget);
      final List<String> shown = tester.widgetList<Text>(find.descendant(of: find.byType(TappableRow), matching: find.byType(Text))).map((Text t) => t.data ?? '').toList();
      expect(shown, <String>['đường', 'cầu']);

      await tester.tap(find.text('cầu'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', '/search').last.url.queryParameters['q'], 'cầu');
      expect(tester.widget<TextField>(_field).controller!.text, 'cầu');
    });

    testWidgets('the same keyword in another case is listed once, first; a keyword that is not acceptable is not kept; the list is cleared on request', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final TestStorage storage = TestStorage.create();
      final ScriptedServer server = ScriptedServer()..on('GET', '/search', (_) => hits(<Map<String, Object?>>[]));
      await _open(tester, server, '/account/mob-51', storage: storage);

      await _search(tester, 'Cầu');
      await _search(tester, 'đường');
      await _search(tester, 'c');
      await _search(tester, 'cầu');
      await tester.enterText(_field, '');
      await tester.pumpAndSettle();
      expect(find.text('cầu'), findsOneWidget);
      expect(find.text('Cầu'), findsNothing);
      expect(find.text('đường'), findsOneWidget);

      await tester.tap(find.text('Xóa lịch sử tìm kiếm'));
      await tester.pumpAndSettle();
      expect(find.text('Tìm gần đây'), findsNothing);
      expect(find.text('Nhập từ khóa để bắt đầu tìm.'), findsOneWidget);
      final LocalStore store = await storage.open();
      expect(RecentSearches(store).read(), isEmpty);
    });

    test('only the keywords are kept, in the encrypted store of the person; ten at most; they go with the store', () async {
      final TestStorage storage = TestStorage.create();
      final LocalStore store = await storage.open();
      final RecentSearches recent = RecentSearches(store);
      for (int i = 1; i <= 12; i += 1) {
        recent.remember('từ khóa $i');
      }
      expect(recent.read(), hasLength(recentSearchesMax));
      expect(recent.read().first, 'từ khóa 12');
      expect(recent.read().last, 'từ khóa 3');
      expect(store.meta(kRecentSearchesMeta), isNot(contains(r1)), reason: 'no id, no hit');

      store.setMeta(kRecentSearchesMeta, jsonEncode(<Object?>['tốt', 7, 'x', null, 'hợp lệ']));
      expect(recent.read(), <String>['tốt', 'hợp lệ'], reason: 'what is not an acceptable keyword is not read back');
      store.setMeta(kRecentSearchesMeta, '{"a":1}');
      expect(recent.read(), isEmpty);

      expect(recent.remember('c'), isNot(contains('c')), reason: 'a keyword that is not acceptable is not kept');
      expect(recent.remember(' ' * 3), isNot(contains(' ')));
      recent.remember('một tìm kiếm');
      await storage.storage.purge(tenantId: 'tenant-a', userId: 'user-1');
      expect(RecentSearches(await storage.open()).read(), isEmpty, reason: 'sign-out and tenant switch purge the store, and the history with it');
    });

    test('each person has their own list', () async {
      final TestStorage storage = TestStorage.create();
      RecentSearches(await storage.open()).remember('của người một');
      expect(RecentSearches(await storage.open(userId: 'user-2')).read(), isEmpty);
      expect(RecentSearches(await storage.open(tenantId: 'tenant-b')).read(), isEmpty);
    });

    testWidgets('another person on the same phone does not see the keywords of the first', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final TestStorage storage = TestStorage.create();
      RecentSearches(await storage.open()).remember('của người một');
      final ScriptedServer server = ScriptedServer();
      await _open(tester, server, '/account/mob-51', storage: storage);
      expect(find.text('của người một'), findsOneWidget);

      await _open(tester, server, '/account/mob-51', storage: storage, session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-2')));
      expect(find.text('của người một'), findsNothing);
    });

    testWidgets('without a store the search still works and remembers nothing', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu Bình An')]));
      await _open(tester, server, '/account/mob-51', storage: null);
      await _search(tester, 'cầu');
      expect(find.text('Cầu Bình An'), findsOneWidget);
      await tester.enterText(_field, '');
      await tester.pumpAndSettle();
      expect(find.text('Tìm gần đây'), findsNothing);
    });
  });

  group('AC-ST-MOB-027-2 UI-MOB-51 MOB-51 results are not kept on the device, and every state is drawn', () {
    testWidgets('after a good search a lost connection shows the offline state and no title; nothing was written to the device', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu Bình An')]));
      final ProviderContainer container = await _open(tester, server, '/account/mob-51');
      await _search(tester, 'cầu');
      expect((container.read(readCacheProvider) as InMemoryReadCache).length, 0, reason: 'titles and extracts are not kept');

      await container.read(readCacheProvider).write(const CacheScope(tenantId: 'tenant-a', userId: 'user-1'), 'search.cầu', CacheEntry(raw: hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu Bình An')]), fetchedAt: kNow));
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.text('Bạn đang ngoại tuyến'), findsWidgets);
      expect(find.text('Cầu Bình An'), findsNothing);
    });

    testWidgets('a search with no hit is the empty state, with the keyword as the filter in use', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/search', (_) => hits(<Map<String, Object?>>[]));
      await _open(tester, server, '/account/mob-51');
      await _search(tester, 'không có');
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(find.text('không có'), findsWidgets);
    });

    testWidgets('the search is read in English as well', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('conversation', idConversation, title: 'Site talk', classification: 'PERSONAL')]));
      await _open(tester, server, '/account/mob-51?q=site', locale: const Locale('en'));
      expect(find.text('Search'), findsWidgets);
      expect(find.text('Conversation'), findsOneWidget);
      expect(find.text('Personal data'), findsOneWidget);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      final String location = '/account/mob-51?q=${Uri.encodeQueryComponent('cầu')}';
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, location),
        script: StateScript(
          healthy: (ScriptedServer server) => server.on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu Bình An', snippet: 'Gói thầu'), hit('issue', idIssue, title: 'Vướng mắc')])),
          content: find.text('Cầu Bình An'),
          empty: (ScriptedServer server) => server.on('GET', '/search', (_) => hits(<Map<String, Object?>>[])),
        ),
      );
      await expectScreenContract(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, location),
        healthy: (ScriptedServer server) => server.on('GET', '/search', (_) => hits(<Map<String, Object?>>[hit('project', r1, title: 'Cầu Bình An', snippet: 'Gói thầu'), hit('issue', idIssue, title: 'Vướng mắc'), hit('document', idPerson, classification: 'PERSONAL')])),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/account/mob-51', storage: TestStorage.create()), healthy: (ScriptedServer server) {});
    });
  });
}
