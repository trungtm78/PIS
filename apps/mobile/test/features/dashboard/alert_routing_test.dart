import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/dashboard/alerts.dart';

/// Where an alert opens on the phone, driven by the contract and by the sources of the server: every target screen the server writes into an
/// alert has a rule (a phone screen) or is declared to have none, and every phone screen a rule names is a phone screen of the catalogue.

const String _root = '../..';
const String _catalogue = '$_root/Design/MACHVON_Design/03_Engineering/screen_catalog.json';

final RegExp _screenId = RegExp(r"'([A-Z]{2,4}-\d{2})'");

/// The target screens that the server writes into the alerts: the literals `screen: '<ID>'` and the screen constants of the home sources of
/// the database package, and the screen tables of the kernel (GOV-10 and VND-3).
Set<String> _serverTargets() {
  final Set<String> found = <String>{};
  final Directory db = Directory('$_root/packages/db/src');
  for (final FileSystemEntity entry in db.listSync()) {
    final String name = entry.path.split(RegExp(r'[\\/]')).last;
    if (entry is! File || !RegExp(r'^(home|alert)-.*\.ts$').hasMatch(name)) continue;
    final String text = entry.readAsStringSync();
    for (final RegExpMatch match in RegExp(r"screen:\s*'([A-Z]{2,4}-\d{2})'").allMatches(text)) {
      found.add(match.group(1)!);
    }
    for (final RegExpMatch match in RegExp(r"\w*SCREEN\w*\s*=\s*'([A-Z]{2,4}-\d{2})'").allMatches(text)) {
      found.add(match.group(1)!);
    }
  }
  for (final String file in <String>['gov10-screens.ts', 'vnd3-alerts.ts']) {
    final String text = File('$_root/packages/kernel/src/$file').readAsStringSync();
    final RegExpMatch? table = RegExp(r'SCREENS\s*=\s*\{([^}]*)\}').firstMatch(text);
    expect(table, isNotNull, reason: '$file has no screen table any more');
    for (final RegExpMatch match in _screenId.allMatches(table!.group(1)!)) {
      found.add(match.group(1)!);
    }
  }
  return found;
}

Map<String, Map<String, Object?>> _screens() {
  final List<Object?> rows = jsonDecode(File(_catalogue).readAsStringSync()) as List<Object?>;
  return <String, Map<String, Object?>>{for (final Object? row in rows) (row! as Map<String, Object?>)['id']! as String: row as Map<String, Object?>};
}

AlertItem _item(String source, String screen, String id) => parseAlertFeed(<String, Object?>{
      'items': <Object?>[
        <String, Object?>{
          'id': 'a-1',
          'source': source,
          'severity': 'ACTION',
          'title': 't',
          'lifecycle': 'NEW',
          'target': <String, Object?>{'screen': screen, 'id': id},
        },
      ],
    })!.items.single;

void main() {
  group('the target screens of the server', () {
    test('each one has a rule or is declared without a phone screen, never both', () {
      final Set<String> targets = _serverTargets();
      expect(targets.length, greaterThan(50), reason: 'the scan of the server sources found too little: its patterns need a look');
      final Set<String> decided = <String>{...kAlertTargets.keys, ...kAlertTargetsWithoutPhoneScreen};
      expect(targets.difference(decided), isEmpty, reason: 'a target screen of the server that nobody decided: add a rule or declare it without a phone screen');
      expect(kAlertTargets.keys.toSet().intersection(kAlertTargetsWithoutPhoneScreen), isEmpty);
    });

    test('a screen declared without a phone screen is still a screen the server writes, and exists in the catalogue', () {
      final Map<String, Map<String, Object?>> screens = _screens();
      final Set<String> targets = _serverTargets();
      for (final String id in kAlertTargetsWithoutPhoneScreen) {
        expect(screens, contains(id), reason: '$id is not in the screen catalogue');
        expect(targets, contains(id), reason: '$id is declared but the server does not write it: remove it from the list');
      }
    });

    test('each rule opens a screen of the phone that is in the catalogue, and a rule key is a screen of the catalogue', () {
      final Map<String, Map<String, Object?>> screens = _screens();
      for (final MapEntry<String, AlertTargetRule> rule in kAlertTargets.entries) {
        expect(screens, contains(rule.key), reason: '${rule.key} is not in the screen catalogue');
        expect(screens[rule.value.screenId]?['platform'], 'mobile', reason: '${rule.key} opens ${rule.value.screenId}, which is not a phone screen');
      }
    });
  });

  group('where the sources of the work open', () {
    bool has(String id) => <String>{'MOB-27', 'MOB-60', 'MOB-61', 'MOB-59', 'MOB-22', 'MOB-75'}.contains(id);

    test('a payment clock opens the payment tracking, a Treasury reconciliation its screen', () {
      expect(alertScreenOf(_item('PAYMENT_CLOCK', 'PAY-22', 'pr-1'), has: has), (screenId: 'MOB-27', pathSuffix: ''));
      expect(alertScreenOf(_item('ADVANCE', 'PAY-12', 'a-1'), has: has), (screenId: 'MOB-27', pathSuffix: ''));
      expect(alertScreenOf(_item('TREASURY_RECON', 'PAY-20', 'r-1'), has: has), (screenId: 'MOB-60', pathSuffix: ''));
    });

    test('contract sources open the contracts list, the missing diary opens the diary of the contract', () {
      for (final String screen in <String>['CTR-03', 'CTR-05', 'CTR-33', 'CTR-35', 'CTR-36', 'CTR-38', 'CTR-39']) {
        expect(alertScreenOf(_item('CONTRACT_CLAIM', screen, 'c-1'), has: has), (screenId: 'MOB-61', pathSuffix: ''), reason: screen);
      }
      expect(alertScreenOf(_item('SITE_DIARY', 'QMS-11', 'c-1'), has: has, available: (String id) => id == 'MOB-62'), (screenId: 'MOB-62', pathSuffix: '/c-1'));
      expect(alertScreenOf(_item('SITE_DIARY', 'QMS-11', ''), has: has), isNull, reason: 'a diary alert without a contract opens nothing');
    });

    test('issues, returned reports and the cover of an absence open their phone lists', () {
      expect(alertScreenOf(_item('ISSUE', 'ISS-03', 'i-1'), has: has), (screenId: 'MOB-59', pathSuffix: ''));
      expect(alertScreenOf(_item('REPORT', 'DIS-03', 'r-1'), has: has), (screenId: 'MOB-22', pathSuffix: ''));
      expect(alertScreenOf(_item('COVERAGE', 'ADM-28', 'c-1'), has: has), (screenId: 'MOB-75', pathSuffix: ''));
    });

    test('a task of the workflow of a project that is due opens the task on the phone, by its id', () {
      expect(alertScreenOf(_item('PROJECT_TASK', 'PWF-04', 'task-1'), has: has, available: (String id) => id == 'MOB-79'), (screenId: 'MOB-79', pathSuffix: '/task-1'));
      expect(alertScreenOf(_item('PROJECT_TASK', 'PWF-04', 'task-1'), has: has, available: (String id) => false), isNull, reason: 'a build without the workflow opens nothing');
      expect(alertScreenOf(_item('PROJECT_TASK', 'PWF-04', ''), has: has), isNull, reason: 'a task alert without a task opens nothing');
    });

    test('permits and audit have no phone screen: the alert is handled from its actions', () {
      for (final String screen in <String>['PMT-02', 'AUD-11', 'AUD-13', 'AUD-15']) {
        expect(alertScreenOf(_item('PERMIT', screen, 'x-1'), has: has), isNull, reason: screen);
      }
    });

    test('a screen that is not part of the build opens nothing', () {
      expect(alertScreenOf(_item('PAYMENT_CLOCK', 'PAY-22', 'pr-1'), has: (String id) => false), isNull);
    });
  });
}
