import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/core_strings.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/mobile_routes.generated.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/navigation/route_policy.dart';
import 'package:machvon_mobile/core/navigation/route_table.dart';
import 'package:machvon_mobile/features/registry.generated.dart';

import '../../tool/generate_registry.dart' as registry_tool;
import '../../tool/generate_routes.dart' as routes_tool;

Widget _screen(BuildContext context, ScreenContext screen) => const SizedBox();

MobileFeature _feature(String id, List<ScreenSpec> screens) => MobileFeature(id: id, screens: screens);

ScreenSpec _spec(String id, {String suffix = ''}) => ScreenSpec(screenId: id, builder: _screen, pathSuffix: suffix);

void main() {
  group('TK-MOB-001-1 the generated files match their sources', () {
    // A Windows checkout with core.autocrlf holds the generated files with CRLF; the generators write LF (CI is Linux).
    test('the route table matches navigation_architecture.json and screen_catalog.json', () {
      expect(File(routes_tool.generatedRoutesFile).readAsStringSync().replaceAll('\r\n', '\n'), routes_tool.expectedRoutes());
    });

    test('the feature registry lists every lib/features/<name>/<name>_feature.dart', () {
      final String expected = registry_tool.renderRegistry(registry_tool.discoverFeatures());
      expect(File(registry_tool.generatedRegistryFile).readAsStringSync().replaceAll('\r\n', '\n'), expected);
    });

    test('the registry is rendered in name order with a prefix per feature', () {
      final String text = registry_tool.renderRegistry(<String>['queue', 'auth']);
      expect(text.indexOf('auth/auth_feature.dart'), lessThan(text.indexOf('queue/queue_feature.dart')));
      expect(text, contains("import 'auth/auth_feature.dart' as f_auth;"));
      expect(text, contains('f_queue.feature,'));
    });

    test('a route without an entry in the screen catalogue is refused', () {
      expect(
        () => routes_tool.renderRoutes(
          navigationJson: '{"mobileRoutes":[{"id":"MOB-99","kind":"form","bottomNavigation":null,"tabRoot":null}]}',
          catalogueJson: '[]',
        ),
        throwsStateError,
      );
    });
  });

  group('TK-MOB-001-1 the screens of the catalogue', () {
    test('there are 82 screens: the 77 MOB screens, the four web screens that are also on the phone and DIR-06 (the directives of the steering meetings)', () {
      expect(kMobileRoutes, hasLength(82));
      expect(kMobileRoutes.where((MobileRoute route) => route.id.startsWith('MOB-')), hasLength(77));
    });

    test('every screen has its functional requirement and its UI test id', () {
      final MobileRoute empty = kMobileRoutes.firstWhere((MobileRoute route) => route.id == 'MOB-52');
      expect(empty.requirement, 'FR-MOB-52');
      expect(empty.uiTestId, 'UI-MOB-52');
      expect(empty.kind, 'empty');
      expect(empty.tab, AppTab.account);
    });

    test('each tab has exactly one root: MOB-07, MOB-09, MOB-23, MOB-32, MOB-47', () {
      final Map<AppTab, List<String>> roots = <AppTab, List<String>>{};
      for (final MobileRoute route in kMobileRoutes.where((MobileRoute route) => route.isTabRoot)) {
        roots.putIfAbsent(route.tab!, () => <String>[]).add(route.id);
      }
      expect(roots, <AppTab, List<String>>{
        AppTab.home: <String>['MOB-07'],
        AppTab.projects: <String>['MOB-09'],
        AppTab.approval: <String>['MOB-23'],
        AppTab.inbox: <String>['MOB-32'],
        AppTab.account: <String>['MOB-47'],
      });
    });

    test('the locations: tab roots, tab screens, public screens', () {
      final RouteTable table = RouteTable(routes: kMobileRoutes, features: const <MobileFeature>[]);
      expect(table.locationOf('MOB-07'), '/home');
      expect(table.locationOf('MOB-08'), '/home/mob-08');
      expect(table.locationOf('MOB-52'), '/account/mob-52');
      expect(table.locationOf('QMS-09'), '/projects/qms-09');
      expect(table.locationOf('MOB-02'), '/mob-02');
      expect(table.locationOf('MOB-44'), '/mob-44', reason: 'the session-expired screen opens without the tabs although the catalogue gives it one');
      expect(table.locationOf('MOB-05'), '/mob-05');
    });

    test('public screens are those that open without a session', () {
      final RouteTable table = RouteTable(routes: kMobileRoutes, features: const <MobileFeature>[]);
      for (final String id in kPublicScreenIds) {
        expect(table.isPublicLocation(Uri.parse(table.locationOf(id))), isTrue, reason: id);
      }
      expect(table.isPublicLocation(Uri.parse('/home')), isFalse);
      expect(table.isPublicLocation(Uri.parse('/mob-05')), isFalse);
      expect(table.isPublicLocation(Uri.parse('/')), isFalse);
    });

    test('the sign-in, session-expired and access-denied screens exist', () {
      final RouteTable table = RouteTable(routes: kMobileRoutes, features: const <MobileFeature>[]);
      for (final String id in <String>[kSignInScreenId, kSessionExpiredScreenId, kAccessDeniedScreenId]) {
        expect(table.routeOf(id), isNotNull, reason: id);
      }
    });
  });

  group('TK-MOB-001-1 the registry of features is checked', () {
    test('the real registry builds', () {
      expect(() => RouteTable(routes: kMobileRoutes, features: kAllFeatures), returnsNormally);
    });

    test('an implementation of a screen that is not in the catalogue is refused', () {
      expect(
        () => RouteTable(routes: kMobileRoutes, features: <MobileFeature>[_feature('a', <ScreenSpec>[_spec('MOB-99')])]),
        throwsA(isA<StateError>().having((StateError e) => e.message, 'message', contains('MOB-99'))),
      );
    });

    test('a screen implemented by two features is refused and names both', () {
      expect(
        () => RouteTable(
          routes: kMobileRoutes,
          features: <MobileFeature>[_feature('a', <ScreenSpec>[_spec('MOB-52')]), _feature('b', <ScreenSpec>[_spec('MOB-52')])],
        ),
        throwsA(isA<StateError>().having((StateError e) => e.message, 'message', allOf(contains('a'), contains('b')))),
      );
    });

    test('a tab root cannot take path parameters, and a suffix must start with a slash', () {
      expect(
        () => RouteTable(routes: kMobileRoutes, features: <MobileFeature>[_feature('a', <ScreenSpec>[_spec('MOB-09', suffix: '/:id')])]),
        throwsStateError,
      );
      expect(
        () => RouteTable(routes: kMobileRoutes, features: <MobileFeature>[_feature('a', <ScreenSpec>[_spec('MOB-10', suffix: ':id')])]),
        throwsStateError,
      );
    });

    test('a catalogue with a screen twice, or a tab without a root, is refused', () {
      const MobileRoute route = MobileRoute(id: 'MOB-07', kind: 'dashboard', requirement: 'FR-MOB-07', tab: AppTab.home, isTabRoot: true);
      expect(() => RouteTable(routes: const <MobileRoute>[route, route], features: const <MobileFeature>[]), throwsStateError);
      expect(() => RouteTable(routes: const <MobileRoute>[route], features: const <MobileFeature>[]), throwsStateError);
    });
  });

  group('TK-MOB-001-5 the string tables', () {
    final List<StringTable> tables = <StringTable>[
      kCoreStrings,
      for (final MobileFeature feature in kAllFeatures)
        if (feature.strings != null) feature.strings!,
    ];

    test('both languages carry exactly the same keys, and every key follows module.screen.action.state', () {
      for (final StringTable table in tables) {
        expect(table.vi.keys.toSet(), table.en.keys.toSet());
        for (final String key in table.vi.keys) {
          expect(isValidStringKey(key), isTrue, reason: key);
        }
      }
    });

    test('no value is empty and every placeholder of one language is in the other', () {
      final RegExp placeholder = RegExp(r'\{([a-zA-Z0-9]+)\}');
      Set<String> names(String text) => placeholder.allMatches(text).map((Match m) => m.group(1)!).toSet();
      for (final StringTable table in tables) {
        for (final String key in table.vi.keys) {
          expect(table.vi[key], isNotEmpty, reason: key);
          expect(table.en[key], isNotEmpty, reason: key);
          expect(names(table.vi[key]!), names(table.en[key]!), reason: key);
        }
      }
    });

    test('a key declared in two tables is refused', () {
      expect(() => StringCatalogue(<StringTable>[kCoreStrings, kCoreStrings]), throwsStateError);
    });

    test('the convention accepts module.screen.action.state and refuses anything else', () {
      expect(isValidStringKey('mob.states.retry.action'), isTrue);
      expect(isValidStringKey('mob.shell.tab.home'), isTrue);
      expect(isValidStringKey('mob.retry'), isFalse);
      expect(isValidStringKey('Mob.states.retry.action'), isFalse);
      expect(isValidStringKey('mob.states.retry action'), isFalse);
      expect(isValidStringKey('mob.a.b.c.d.e'), isFalse);
    });

    test('every key written as a literal in lib/ is declared in both languages (no dynamic keys)', () {
      final StringCatalogue catalogue = StringCatalogue(tables);
      final RegExp usage = RegExp(r"""\bt\(\s*'([^']+)'""");
      final Set<String> used = <String>{};
      for (final FileSystemEntity entity in Directory('lib').listSync(recursive: true)) {
        if (entity is! File || !entity.path.endsWith('.dart') || entity.path.replaceAll('\\', '/').contains('lib/editions/enterprise/')) continue;
        for (final Match match in usage.allMatches(entity.readAsStringSync())) {
          used.add(match.group(1)!);
        }
      }
      expect(used, isNotEmpty);
      for (final String key in used) {
        // The words of the enterprise phone shell live in the enterprise home table: its own test (editions/enterprise_home_enterprise_test.dart) holds them to the same rules.
        if (key.startsWith('mob.ent.')) continue;
        expect(catalogue.lookup('vi', key), isNotNull, reason: '$key (vi)');
        expect(catalogue.lookup('en', key), isNotNull, reason: '$key (en)');
      }
      final Set<String> declared = catalogue.viKeys;
      expect(declared.difference(used), isEmpty, reason: 'declared but never used');
    });

    test('a call that builds its key from parts is refused', () {
      final RegExp dynamicKey = RegExp(r"""\bt\(\s*(?!')[^)\s]""");
      for (final FileSystemEntity entity in Directory('lib').listSync(recursive: true)) {
        if (entity is! File || !entity.path.endsWith('.dart') || entity.path.endsWith('app_strings.dart')) continue;
        final String text = entity.readAsStringSync();
        expect(dynamicKey.hasMatch(text), isFalse, reason: entity.path);
      }
    });
  });
}
