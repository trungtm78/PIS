import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/features/field_evidence/field_evidence_strings.dart';
import 'package:machvon_mobile/features/field_evidence/field_place.dart';
import 'package:machvon_mobile/features/field_issues/issue_comments.dart';
import 'package:machvon_mobile/features/field_issues/issue_draft.dart';
import 'package:machvon_mobile/features/field_issues/issue_follow_up.dart';
import 'package:machvon_mobile/features/field_issues/issue_labels.dart';
import 'package:machvon_mobile/features/field_issues/issue_strings.dart';
import 'package:machvon_mobile/features/permissions/permission_service.dart' show ManualLocation;

import '../../support/widget_host.dart';

Future<BuildContext> _context(WidgetTester tester, Locale locale) async {
  late BuildContext captured;
  await tester.pumpWidget(hostWidget(Builder(builder: (BuildContext context) {
    captured = context;
    return const SizedBox();
  }), locale: locale, tables: <StringTable>[issueStrings, fieldEvidenceStrings]));
  return captured;
}

void _allWords(List<String> words) {
  for (final String word in words) {
    expect(word, isNotEmpty);
    expect(word.startsWith('mob.'), isFalse, reason: 'a key shows where words should: $word');
  }
  expect(words.toSet(), hasLength(words.length), reason: 'two different cases read the same');
}

final FieldPlace _manual = FieldPlace.none.withManual(ManualLocation.tryParse('Cổng phía bắc')!);

IssueEvent _event(String kind) => IssueEvent(id: 'e', kind: kind, createdAt: '2026-11-03T01:00:00Z', toAssignee: 'Lê Văn C');

void main() {
  for (final Locale locale in const <Locale>[Locale('vi'), Locale('en')]) {
    testWidgets('UI-MOB-28 UI-MOB-29 UI-MOB-30 UI-MOB-31 every severity, status, check, place, event and refusal of the issue screens is in words (${locale.languageCode})', (WidgetTester tester) async {
      final BuildContext context = await _context(tester, locale);
      _allWords(<String>[for (final String s in <String>['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) severityText(context, s)]);
      _allWords(<String>[for (final String s in <String>['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'PENDING_VERIFICATION', 'CLOSED', 'REOPENED']) statusText(context, s)]);
      _allWords(<String>[for (final IssueProblem p in IssueProblem.values) issueProblemText(context, p)]);
      _allWords(<String>[for (final CommentProblem p in CommentProblem.values) commentProblemText(context, p)]);
      _allWords(<String>[for (final CommentFormProblem p in CommentFormProblem.values) commentFormText(context, p)]);
      _allWords(<String>[for (final CheckStatus s in CheckStatus.values) checkStatusText(context, s)]);
      expect(manualPlaceLabel(context), isNotEmpty);

      final List<String> checks = <String>[
        for (final String id in <String>['chosen', 'details', 'photo', 'place', 'metadata'])
          for (final CheckStatus status in <CheckStatus>[CheckStatus.ok, CheckStatus.warning])
            checkText(context, FieldCheck(id, status)),
      ];
      _allWords(checks);

      const DevicePosition here = DevicePosition(latitude: 10.8, longitude: 106.7, accuracyMetres: 9.4);
      _allWords(<String>[
        placeSummary(context, FieldPlace.none),
        placeSummary(context, _manual),
        placeSummary(context, FieldPlace.none.withConsent(true).withDevicePosition(here)),
      ]);
      expect(placeSummary(context, _manual), contains('Cổng phía bắc'));

      final List<String> events = <String>[
        for (final String kind in <String>['CREATED', 'ASSIGNED', 'TRANSFERRED', 'STARTED', 'COMMENTED', 'EVIDENCE_ADDED', 'EXTENDED', 'ESCALATED', 'VERIFICATION_REQUESTED', 'CLOSED', 'REOPENED', 'SLA_BREACHED', 'SOMETHING_NEW'])
          eventText(context, _event(kind)),
      ];
      _allWords(events);
      expect(eventText(context, _event('ASSIGNED')), contains('Lê Văn C'));
      expect(eventText(context, _event('REASSIGNED')), eventText(context, _event('ASSIGNED')));
      expect(eventText(context, _event('EXTENSION_REQUESTED')), eventText(context, _event('EXTENDED')));
      expect(eventText(context, _event('ESCALATION_ACCEPTED')), eventText(context, _event('ESCALATED')));

      expect(draftTitle(context, const IssueDraft(clientOperationId: 'k')), isNotEmpty);
      expect(draftTitle(context, const IssueDraft(clientOperationId: 'k', title: '  Sạt lở  ')), 'Sạt lở');
    });
  }
}
