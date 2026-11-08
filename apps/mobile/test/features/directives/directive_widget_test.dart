import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/features/directives/directive_models.dart';
import 'package:machvon_mobile/features/directives/directives_strings.dart';
import 'package:machvon_mobile/features/directives/widgets/directive_widget.dart';
import 'package:machvon_mobile/features/read_support/read_support_strings.dart';

import '../../support/harness.dart';
import '../../support/widget_host.dart';
import '../dashboard/home_parity_fixtures.dart';
import 'directive_fixtures.dart';

const List<StringTable> _tables = <StringTable>[directivesStrings, readSupportStrings];

/// The summary of the directives for a dashboard (`getDirectiveWidget`): what the phone reads from it, and the card that shows it on its own.
void main() {
  group('the widget of the directives is read the way the web reads it', () {
    test('the counts, the oldest overdue directives, the words of each count and the state of the policy', () {
      final DirectiveWidgetData widget = parseDirectiveWidget(directiveWidget())!;
      expect(widget.overdue, 3);
      expect(widget.dueSoon, 2);
      expect(widget.escalated, 1);
      expect(widget.open, 6);
      expect(widget.items.single.code, 'GB-2026-014/CD-01');
      expect(widget.definitions.keys, <String>['overdue', 'due_soon', 'escalated']);
      expect(widget.policy.unverified, isTrue);
      expect(widget.truncated, isFalse);
      expect(widget.asOf, directivesAsOf);
      expect(parseDirectiveWidget(directiveWidget(unverified: false))!.policy.unverified, isFalse);
    });

    test('an answer that lacks a count, the time or a readable row is not a widget: never half a card, never a 0', () {
      expect(parseDirectiveWidget(null), isNull);
      expect(parseDirectiveWidget(<String, Object?>{...directiveWidget(), 'counts': <String, Object?>{'overdue': 1}}), isNull);
      expect(parseDirectiveWidget(<String, Object?>{...directiveWidget(), 'as_of': null}), isNull);
      expect(parseDirectiveWidget(<String, Object?>{...directiveWidget(), 'items': 'x'}), isNull);
      expect(parseDirectiveWidget(<String, Object?>{...directiveWidget(), 'items': <Object?>[<String, Object?>{'id': 'x'}]}), isNull);
    });

    test('a definition the server did not write is not made up', () {
      final DirectiveWidgetData widget = parseDirectiveWidget(<String, Object?>{...directiveWidget(), 'definitions': <String, Object?>{'overdue': 'Quá hạn.'}})!;
      expect(widget.definitions, <String, String>{'overdue': 'Quá hạn.'});
    });
  });

  group('the card on its own', () {
    testWidgets('a counted widget shows its figures; without a definition a count has no "i"', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[2]);
      final DirectiveWidgetData data = parseDirectiveWidget(<String, Object?>{...directiveWidget(), 'definitions': <String, Object?>{'overdue': 'Quá hạn.'}})!;
      await tester.pumpWidget(hostWidget(SingleChildScrollView(child: DirectiveWidgetCard(data: data, errorCode: null, onRetry: () {})), tables: _tables));
      await tester.pumpAndSettle();

      expect(find.byTooltip('Công thức và nguồn của Chỉ đạo quá hạn'), findsOneWidget);
      expect(find.byTooltip('Công thức và nguồn của Sắp đến hạn'), findsNothing);
      expect(find.text('3'), findsOneWidget);
    });

    testWidgets('a failure says what it is and retries; a refusal says it in words and offers no retry', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      int retries = 0;
      await tester.pumpWidget(hostWidget(SingleChildScrollView(child: DirectiveWidgetCard(data: null, errorCode: 'INTERNAL_ERROR', onRetry: () => retries += 1)), tables: _tables));
      await tester.pumpAndSettle();
      expect(find.textContaining('mã INTERNAL_ERROR'), findsOneWidget);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Thử lại'));
      expect(retries, 1);

      await tester.pumpWidget(hostWidget(SingleChildScrollView(child: DirectiveWidgetCard(data: null, errorCode: 'SCOPE_DENIED', onRetry: () => retries += 1)), tables: _tables));
      await tester.pumpAndSettle();
      expect(find.text('Bạn không có quyền xem chỉ đạo giao ban.'), findsOneWidget);
      expect(find.byType(OutlinedButton), findsNothing);
    });
  });
}
