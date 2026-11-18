import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/app_strings.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/features/account/account_providers.dart';
import 'package:machvon_mobile/features/account/account_strings.dart';
import 'package:machvon_mobile/features/account/session_name.dart';

const String _chromeWindows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const String _edgeWindows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
const String _chromeAndroid = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36';
const String _safariIphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const String _safariMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const String _firefoxLinux = 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0';
const String _cocCoc = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) coc_coc_browser/128.0.0 Chrome/122.0.0.0 Safari/537.36';

/// The name as the screen says it, in [language].
String _words(String summary, [String language = 'vi']) {
  return sessionName(sessionClientOf(summary), AppStrings(language, StringCatalogue(const <StringTable>[accountStrings])).t);
}

SessionRow _row(String id, {bool current = false, String? seen}) =>
    SessionRow(id: id, current: current, summary: '', lastSeenAt: seen == null ? null : DateTime.parse(seen));

void main() {
  group('L4 the name of a session, from its user-agent summary', () {
    test('a browser is named with its system', () {
      expect(_words(_chromeWindows), 'Trình duyệt Chrome trên Windows');
      expect(_words(_chromeAndroid), 'Trình duyệt Chrome trên Android');
      expect(_words(_safariIphone), 'Trình duyệt Safari trên iOS');
      expect(_words(_safariMac), 'Trình duyệt Safari trên macOS');
      expect(_words(_firefoxLinux), 'Trình duyệt Firefox trên Linux');
    });

    test('a browser built on Chromium is named by its own mark, not as Chrome or Safari', () {
      expect(sessionClientOf(_edgeWindows), const SessionClient(SessionClientKind.browser, browser: 'Edge', system: 'Windows'));
      expect(_words(_cocCoc), 'Trình duyệt Cốc Cốc trên Windows');
      expect(sessionClientOf(_chromeWindows).browser, 'Chrome');
    });

    test('the phone application and a service of the system are named as what they are', () {
      expect(_words('Dart/3.9 (dart:io)'), 'Ứng dụng điện thoại');
      expect(_words('  dart/3.11 (dart:io) '), 'Ứng dụng điện thoại');
      expect(_words('node'), 'Dịch vụ hệ thống');
      expect(_words('node-fetch/1.0 (+https://github.com/bitinn/node-fetch)'), 'Dịch vụ hệ thống');
      expect(_words('undici'), 'Dịch vụ hệ thống');
      expect(_words('curl/8.4.0'), 'Dịch vụ hệ thống');
    });

    test('a browser that is only half recognised still reads as a browser', () {
      expect(_words('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Something/1.0'), 'Trình duyệt trên Windows');
      expect(_words('Mozilla/5.0 (PlayStation 5) Chrome/100.0'), 'Trình duyệt Chrome');
      expect(_words('Mozilla/5.0 (compatible)'), 'Trình duyệt');
    });

    test('what is not recognised gets a neutral name, and the raw text is never the name', () {
      for (final String summary in <String>['', '   ', 'unknown', 'MACHVON Android 14', '<script>alert(1)</script>', 'x' * 400]) {
        expect(_words(summary), 'Thiết bị khác', reason: summary);
        expect(sessionClientOf(summary), const SessionClient(SessionClientKind.unknown));
      }
    });

    test('the same names in English', () {
      expect(_words(_chromeWindows, 'en'), 'Chrome browser on Windows');
      expect(_words('Dart/3.9 (dart:io)', 'en'), 'Phone app');
      expect(_words('node', 'en'), 'System service');
      expect(_words('?', 'en'), 'Other device');
      expect(_words('Mozilla/5.0 (compatible)', 'en'), 'Browser');
      expect(_words('Mozilla/5.0 (X11; Linux x86_64)', 'en'), 'Browser on Linux');
      expect(_words('Mozilla/5.0 (PlayStation 5) Chrome/100.0', 'en'), 'Chrome browser');
    });
  });

  group('L4 the order of the sessions and how many are drawn', () {
    test('the session of this phone is first, then the others by their latest activity; one with no time is last', () {
      final List<SessionRow> ordered = orderedSessions(<SessionRow>[
        _row('old', seen: '2026-11-01T00:00:00Z'),
        _row('never'),
        _row('this', current: true, seen: '2026-10-01T00:00:00Z'),
        _row('new', seen: '2026-11-17T08:00:00Z'),
        _row('same-1', seen: '2026-11-05T00:00:00Z'),
        _row('same-2', seen: '2026-11-05T00:00:00Z'),
      ]);
      expect(ordered.map((SessionRow row) => row.id), <String>['this', 'new', 'same-1', 'same-2', 'old', 'never']);
    });

    test('until the person asks for more: this session and the five latest of the others', () {
      final List<SessionRow> ordered = orderedSessions(<SessionRow>[
        for (int index = 0; index < 63; index += 1) _row('s-$index', seen: DateTime.utc(2026, 11, 1).add(Duration(hours: index)).toIso8601String()),
        _row('this', current: true, seen: '2026-11-18T00:00:00Z'),
      ]);
      expect(ordered, hasLength(64));
      expect(visibleSessions(ordered, all: false).map((SessionRow row) => row.id), <String>['this', 's-62', 's-61', 's-60', 's-59', 's-58']);
      expect(visibleSessions(ordered, all: true), hasLength(64));
    });

    test('a short list is whole, and a list with no session of this phone still shows five', () {
      final List<SessionRow> few = orderedSessions(<SessionRow>[_row('a', seen: '2026-11-02T00:00:00Z'), _row('b', current: true)]);
      expect(visibleSessions(few, all: false).map((SessionRow row) => row.id), <String>['b', 'a']);
      final List<SessionRow> none = orderedSessions(<SessionRow>[for (int index = 0; index < 8; index += 1) _row('s-$index')]);
      expect(visibleSessions(none, all: false), hasLength(sessionsShownFirst));
      expect(orderedSessions(const <SessionRow>[]), isEmpty);
    });
  });
}
