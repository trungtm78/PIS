import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/features/dashboard/alerts.dart';
import 'package:machvon_mobile/features/dashboard/dashboard_strings.dart';
import 'package:machvon_mobile/features/dashboard/widgets/alert_card.dart' show alertSourceLabel;

import '../../support/widget_host.dart';
import 'dashboard_fixtures.dart';

/// The sources of the alert centre on the phone: every module source of the contract has a label, a target that opens a phone screen where
/// the phone has one, and the severity, the consequence and the expected action come from the server and are shown as they come.

const String _contract = '../../Design/MACHVON_Design/03_Engineering/openapi.json';

List<String> _contractSources() {
  final Map<String, Object?> document = jsonDecode(File(_contract).readAsStringSync()) as Map<String, Object?>;
  final Map<String, Object?> schemas = (document['components']! as Map<String, Object?>)['schemas']! as Map<String, Object?>;
  final Map<String, Object?> target = schemas['WorkActionTarget']! as Map<String, Object?>;
  final Map<String, Object?> source = (target['properties']! as Map<String, Object?>)['source']! as Map<String, Object?>;
  return <String>[for (final Object? value in source['enum']! as List<Object?>) value! as String];
}

AlertItem _item(String source, {String screen = 'ADM-06', String id = 'x-1', String severity = 'ACTION', String? consequence}) =>
    parseAlertFeed(<String, Object?>{
      'items': <Object?>[
        alertItem('a-1', source: source, severity: severity, consequence: consequence, screen: screen)..['target'] = <String, Object?>{'screen': screen, 'id': id},
      ],
    })!.items.single;

void main() {
  group('the sources of the contract', () {
    test('the list of the phone is the list of the contract, no more, no less', () {
      expect(kAlertSources.toSet(), _contractSources().toSet(), reason: 'a source added to the contract must be added to kAlertSources and labelled');
      expect(kAlertSources.toSet(), hasLength(kAlertSources.length), reason: 'no source twice');
    });

    for (final Locale locale in const <Locale>[Locale('vi'), Locale('en')]) {
      testWidgets('each source has its own label in ${locale.languageCode}, never the bare code', (WidgetTester tester) async {
        late BuildContext context;
        await tester.pumpWidget(hostWidget(Builder(builder: (BuildContext c) {
          context = c;
          return const SizedBox();
        }), locale: locale, tables: <StringTable>[dashboardStrings]));
        final Set<String> seen = <String>{};
        for (final String source in _contractSources()) {
          final String label = alertSourceLabel(context, source);
          expect(label, isNotEmpty);
          expect(label, isNot(contains(source)), reason: '$source shows its code');
          expect(label, isNot(startsWith(locale.languageCode == 'vi' ? 'Nguồn khác' : 'Other source')), reason: '$source is labelled as unknown');
          seen.add(label);
        }
        // OBLIGATION and the M&E obligation kind share a label, EXPLANATION and EXPLANATION_CONCLUDE share one: every other source has its own.
        expect(seen.length, greaterThanOrEqualTo(_contractSources().length - 2));
      });
    }

    testWidgets('a source newer than the phone is shown with its code, and a missing one as the other source', (WidgetTester tester) async {
      late BuildContext context;
      await tester.pumpWidget(hostWidget(Builder(builder: (BuildContext c) {
        context = c;
        return const SizedBox();
      }), tables: <StringTable>[dashboardStrings]));
      expect(alertSourceLabel(context, 'FUTURE_SOURCE'), contains('FUTURE_SOURCE'));
      expect(alertSourceLabel(context, ''), 'Nguồn khác');
    });
  });

  group('the new sources reach the list as they are sent', () {
    test('severity, consequence, expected action and the web target of the new sources are kept', () {
      for (final String source in <String>['RED_FLAG', 'CONTRACT_CLOCK', 'DOC_REVIEW', 'DATA_FRESHNESS', 'ANOMALY', 'ALERT_FEEDBACK', 'CONNECTOR', 'EGP_POSTING', 'VENDOR', 'CONTRACT_CLAIM', 'ESCALATION', 'COVERAGE', 'PROJECT_RISK', 'COMMITTEE']) {
        final AlertItem item = _item(source, screen: 'VND-11', severity: 'URGENT', consequence: 'Hậu quả của $source');
        expect(item.source, source);
        expect(item.severity, AlertSeverity.urgent);
        expect(item.consequence, 'Hậu quả của $source');
        expect(item.canSnooze, isFalse, reason: 'an urgent alert is never snoozed, whatever its source');
        expect(item.canClaim, isTrue);
      }
    });
  });

  group('where a target opens on the phone', () {
    bool has(String id) => id == 'MOB-72' || id == 'DIR-06' || id == 'MOB-57';
    bool available(String id) => id != 'MOB-74';

    test('a package opens its progress, a project its workspace, a contractor its risk, the committee its dashboard, a directive the directives', () {
      expect(alertScreenOf(_item('PROCUREMENT_WORKFLOW', screen: 'BID-29', id: 'pk-1'), has: has), (screenId: 'MOB-70', pathSuffix: '/pk-1'));
      for (final String screen in <String>['PRJ-03', 'PRJ-26', 'PRJ-28', 'PRJ-29', 'PRJ-30']) {
        expect(alertScreenOf(_item('PROJECT_RISK', screen: screen, id: 'p-1'), has: has), (screenId: 'MOB-10', pathSuffix: '/p-1'), reason: screen);
      }
      expect(alertScreenOf(_item('COMMITTEE', screen: 'BAN-05', id: 'al-1'), has: has), (screenId: 'MOB-72', pathSuffix: ''));
      expect(alertScreenOf(_item('DIRECTIVE', screen: 'DIR-04', id: 'd-1'), has: has), (screenId: 'DIR-06', pathSuffix: ''));
      expect(alertScreenOf(_item('VENDOR', screen: 'VND-11', id: 'c-1'), has: has), (screenId: 'MOB-74', pathSuffix: '/c-1'));
      expect(alertScreenOf(_item('VENDOR', screen: 'VND-12', id: 'c-1'), has: has), (screenId: 'MOB-74', pathSuffix: '/c-1'));
    });

    test('an id that is not a plain token never opens, and a screen that is not part of the build does not either', () {
      expect(alertScreenOf(_item('VENDOR', screen: 'VND-11', id: 'c 1'), has: has), isNull);
      expect(alertScreenOf(_item('VENDOR', screen: 'VND-11', id: 'c-1'), has: has, available: available), isNull);
      expect(alertScreenOf(_item('PROCUREMENT_WORKFLOW', screen: 'BID-29', id: 'pk-1'), has: (String id) => false, available: available), (screenId: 'MOB-70', pathSuffix: '/pk-1'));
      expect(alertScreenOf(_item('COMMITTEE', screen: 'BAN-05'), has: (String id) => false), isNull, reason: 'the dashboard is not in this build');
    });

    test('a web screen the phone has no counterpart for opens nothing; the alert is handled from its actions', () {
      for (final String screen in <String>['BID-22', 'BID-32', 'VND-07', 'VND-10', 'CTR-33', 'FEED-01', 'DOC-02']) {
        expect(alertScreenOf(_item('CONNECTOR', screen: screen, id: 'x-1'), has: has), isNull, reason: screen);
      }
    });
  });
}
