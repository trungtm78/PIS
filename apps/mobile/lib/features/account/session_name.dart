import 'account_providers.dart' show SessionRow;

/// What kind of program opened a session, as far as its user-agent tells.
enum SessionClientKind { browser, phoneApp, service, unknown }

/// The program behind a session, read from the user-agent summary the server keeps. It names a kind, and for a browser the browser and the
/// system when they are recognised; it never carries the raw text, so the screen has nothing technical to show.
final class SessionClient {
  const SessionClient(this.kind, {this.browser, this.system});

  final SessionClientKind kind;

  /// The name of the browser (`Chrome`, `Firefox`); null when it is a browser that is not recognised, or not a browser.
  final String? browser;

  /// The name of the system the browser runs on (`Windows`, `Android`); null when it is not recognised.
  final String? system;

  @override
  bool operator ==(Object other) => other is SessionClient && other.kind == kind && other.browser == browser && other.system == system;

  @override
  int get hashCode => Object.hash(kind, browser, system);

  @override
  String toString() => 'SessionClient(${kind.name}, $browser, $system)';
}

/// The marks of a browser, the most specific first: the browsers built on Chromium also say `Chrome` and `Safari`, and Chrome says `Safari`.
const List<({String mark, String name})> _browsers = <({String mark, String name})>[
  (mark: 'edg/', name: 'Edge'),
  (mark: 'edga/', name: 'Edge'),
  (mark: 'edgios/', name: 'Edge'),
  (mark: 'coc_coc_browser/', name: 'Cốc Cốc'),
  (mark: 'opr/', name: 'Opera'),
  (mark: 'samsungbrowser/', name: 'Samsung Internet'),
  (mark: 'firefox/', name: 'Firefox'),
  (mark: 'fxios/', name: 'Firefox'),
  (mark: 'chrome/', name: 'Chrome'),
  (mark: 'crios/', name: 'Chrome'),
  (mark: 'safari/', name: 'Safari'),
];

/// The marks of a system, the most specific first: Android also says `Linux`, an iPhone also says `Mac OS X`.
const List<({String mark, String name})> _systems = <({String mark, String name})>[
  (mark: 'windows', name: 'Windows'),
  (mark: 'android', name: 'Android'),
  (mark: 'iphone', name: 'iOS'),
  (mark: 'ipad', name: 'iOS'),
  (mark: 'ipod', name: 'iOS'),
  (mark: 'mac os x', name: 'macOS'),
  (mark: 'macintosh', name: 'macOS'),
  (mark: 'cros', name: 'ChromeOS'),
  (mark: 'linux', name: 'Linux'),
];

/// The user-agents of a program that is not a person at a screen: a server of the system or a script calling the API.
const List<String> _services = <String>['node', 'undici', 'axios/', 'curl/', 'python', 'go-http-client', 'postmanruntime', 'okhttp/', 'java/'];

/// Who opened a session, from its user-agent summary (L4). The phone application signs in through `dart:io` (`Dart/3.9 (dart:io)`); a server of the
/// system says `node`; a browser says `Mozilla/5.0 (…)` with its own marks. Anything else, an empty summary and the server's `unknown` are
/// [SessionClientKind.unknown]: the screen then says a neutral name and never the raw text.
SessionClient sessionClientOf(String summary) {
  final String text = summary.trim().toLowerCase();
  if (text.isEmpty || text == 'unknown') return const SessionClient(SessionClientKind.unknown);
  if (text.startsWith('dart/') || text.contains('(dart:io)')) return const SessionClient(SessionClientKind.phoneApp);
  if (text.startsWith('mozilla/')) {
    String? named(List<({String mark, String name})> marks) {
      for (final ({String mark, String name}) entry in marks) {
        if (text.contains(entry.mark)) return entry.name;
      }
      return null;
    }

    return SessionClient(SessionClientKind.browser, browser: named(_browsers), system: named(_systems));
  }
  for (final String mark in _services) {
    if (text.startsWith(mark)) return const SessionClient(SessionClientKind.service);
  }
  return const SessionClient(SessionClientKind.unknown);
}

/// The words of the interface for a key, as `AppStrings.t` and `context.t` give them.
typedef SessionWords = String Function(String key, [Map<String, Object> values]);

/// The name of a session in the words of the interface (L4): "Trình duyệt Chrome trên Windows", "Ứng dụng điện thoại", "Dịch vụ hệ thống", and a
/// neutral name for what is not recognised. [t] is the translation of the screen (`context.t`).
String sessionName(SessionClient client, SessionWords t) {
  switch (client.kind) {
    case SessionClientKind.phoneApp:
      return t('mob.devices.session.app');
    case SessionClientKind.service:
      return t('mob.devices.session.service');
    case SessionClientKind.unknown:
      return t('mob.devices.session.unknown');
    case SessionClientKind.browser:
      final String? browser = client.browser;
      final String? system = client.system;
      if (browser != null && system != null) return t('mob.devices.session.browserOn', <String, Object>{'browser': browser, 'system': system});
      if (browser != null) return t('mob.devices.session.browser', <String, Object>{'browser': browser});
      if (system != null) return t('mob.devices.session.webOn', <String, Object>{'system': system});
      return t('mob.devices.session.web');
  }
}

/// How many of the other sessions the list shows before "Xem thêm".
const int sessionsShownFirst = 5;

/// The sessions as the list shows them (L4): the one of this phone first, then the others, the most recently active first (one with no time of
/// activity last, in the order the server gave).
List<SessionRow> orderedSessions(List<SessionRow> sessions) {
  final List<SessionRow> current = <SessionRow>[for (final SessionRow row in sessions) if (row.current) row];
  final List<({int at, SessionRow row})> others = <({int at, SessionRow row})>[
    for (int index = 0; index < sessions.length; index += 1)
      if (!sessions[index].current) (at: index, row: sessions[index]),
  ]..sort((({int at, SessionRow row}) a, ({int at, SessionRow row}) b) {
      final DateTime? left = a.row.lastSeenAt;
      final DateTime? right = b.row.lastSeenAt;
      if (left != null && right != null && !left.isAtSameMomentAs(right)) return right.compareTo(left);
      if ((left == null) != (right == null)) return left == null ? 1 : -1;
      return a.at.compareTo(b.at);
    });
  return <SessionRow>[...current, for (final ({int at, SessionRow row}) entry in others) entry.row];
}

/// The rows of [ordered] (see [orderedSessions]) that are drawn: all of them once the person asked for more, otherwise the session of this phone and
/// the [sessionsShownFirst] latest of the others.
List<SessionRow> visibleSessions(List<SessionRow> ordered, {required bool all}) {
  if (all) return ordered;
  final List<SessionRow> shown = <SessionRow>[];
  int others = 0;
  for (final SessionRow row in ordered) {
    if (row.current) {
      shown.add(row);
    } else if (others < sessionsShownFirst) {
      others += 1;
      shown.add(row);
    }
  }
  return shown;
}
