import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/directives/directive_models.dart';

import 'directive_fixtures.dart';

void main() {
  group('the directive line', () {
    test('reads the status, the clock the server counted, the unit, the person and the pending request', () {
      final DirectiveLine? line = parseDirectiveLine(threeDirectives[0]);
      expect(line, isNotNull);
      expect(line!.status, DirectiveStatus.overdue);
      expect(line.phase, DirectivePhase.escalated);
      expect(line.escalated, isTrue);
      expect(line.overdueDays, 10);
      expect(line.assigneeUnit, 'Ban QLDA giao thông');
      expect(line.assignee, 'Nguyễn Văn An');
      expect(line.projectCode, 'DA-001');
      expect(line.extensionPending, isFalse);
      final DirectiveLine soon = parseDirectiveLine(threeDirectives[1])!;
      expect(soon.daysToDue, 2);
      expect(soon.extensionPending, isTrue);
      final DirectiveLine unit = parseDirectiveLine(threeDirectives[2])!;
      expect(unit.assignee, isNull);
      expect(unit.projectCode, isNull);
      expect(unit.status, DirectiveStatus.inProgress);
    });

    test('a row that lacks what makes it citable is refused as a whole, never half a row', () {
      for (final String key in <String>['id', 'code', 'text', 'status', 'phase', 'due_on', 'assignee_unit']) {
        expect(parseDirectiveLine(<String, Object?>{...threeDirectives[0], key: null}), isNull, reason: key);
      }
      expect(parseDirectiveLine(<String, Object?>{...threeDirectives[0], 'status': 'LATE'}), isNull);
      expect(parseDirectiveLine(<String, Object?>{...threeDirectives[0], 'phase': 'SOON'}), isNull);
      expect(parseDirectiveLine(<String, Object?>{...threeDirectives[0], 'due_on': '08/11/2026'}), isNull);
      expect(parseDirectiveLine('x'), isNull);
    });

    test('every status and phase of the contract is known', () {
      for (final String status in <String>['OPEN', 'IN_PROGRESS', 'DONE', 'OVERDUE', 'CANCELLED']) {
        expect(directiveStatusOf(status), isNotNull, reason: status);
      }
      for (final String phase in <String>['DUE_LATER', 'DUE_SOON', 'DUE_TODAY', 'OVERDUE', 'ESCALATED', 'ENDED']) {
        expect(directivePhaseOf(phase), isNotNull, reason: phase);
      }
    });
  });

  group('the views of the list', () {
    test('mine asks for the directives given to the reader, overdue for the late ones, all for none of the two', () {
      expect(directiveQuery(DirectiveFilter.mine), <String, Object?>{'limit': 50, 'assigned_to_me': 'true'});
      expect(directiveQuery(DirectiveFilter.overdue), <String, Object?>{'limit': 50, 'overdue': 'true'});
      expect(directiveQuery(DirectiveFilter.all), <String, Object?>{'limit': 50});
    });
  });

  group('the counts', () {
    test('open counts the open and the in progress directives; the policy is unverified unless the server says it was approved', () {
      final DirectiveSummary summary = parseDirectiveSummary(directiveSummary())!;
      expect(summary.overdue, 1);
      expect(summary.dueSoon, 1);
      expect(summary.escalated, 1);
      expect(summary.open, 2);
      expect(summary.policy.unverified, isTrue);
      expect(summary.definitions.keys, containsAll(<String>['by_status', 'due_soon', 'escalated']));
      expect(parseDirectiveSummary(directiveSummary(unverified: false))!.policy.unverified, isFalse);
    });

    test('an answer without the counts is refused as a whole', () {
      expect(parseDirectiveSummary(<String, Object?>{'total': 1}), isNull);
      expect(parseDirectiveSummary(null), isNull);
    });
  });

  group('the read of the screen', () {
    test('holds the lines, the counts and whether the list was cut; a counts answer that is not one marks the counts as not read', () {
      final DirectiveList list = parseDirectiveList(<String, Object?>{'list': directivePage(threeDirectives, next: 'c2'), 'summary': directiveSummary(), 'summary_failed': false})!;
      expect(list.lines, hasLength(3));
      expect(list.more, isTrue);
      expect(list.summary, isNotNull);
      expect(list.summaryFailed, isFalse);
      expect(list.asOf, directivesAsOf);
      final DirectiveList failed = parseDirectiveList(<String, Object?>{'list': directivePage(threeDirectives), 'summary': null, 'summary_failed': true})!;
      expect(failed.summary, isNull);
      expect(failed.summaryFailed, isTrue);
      expect(failed.more, isFalse);
      expect(parseDirectiveList(<String, Object?>{'list': directivePage(threeDirectives), 'summary': <String, Object?>{'x': 1}})!.summaryFailed, isTrue);
    });

    test('one bad row refuses the whole answer', () {
      expect(parseDirectiveList(<String, Object?>{'list': directivePage(<Object?>[threeDirectives[0], <String, Object?>{'id': 'x'}])}), isNull);
      expect(parseDirectiveList(<String, Object?>{'list': <String, Object?>{'items': 'no'}}), isNull);
      expect(parseDirectiveList(null), isNull);
    });
  });

  group('the detail', () {
    test('reads the timeline in order, the requests and the evidence', () {
      final DirectiveDetail detail = parseDirectiveDetail(directiveDetailJson())!;
      expect(detail.directive.code, 'GB-2026-014/CD-01');
      expect(detail.originalDueOn, '2026-10-20');
      expect(detail.meetingCode, 'GB-2026-014');
      expect(detail.events.map((DirectiveEvent e) => e.kind), <DirectiveEventKind>[DirectiveEventKind.created, DirectiveEventKind.progress, DirectiveEventKind.extensionApproved]);
      expect(detail.events[1].progressPct, 40);
      expect(detail.events[2].toDueOn, '2026-10-29');
      expect(detail.events[0].toUnit, 'Ban QLDA giao thông');
      expect(detail.extensions.single.state, ExtensionState.approved);
      expect(detail.extensions.single.decidedBy, 'Trần Thị Bình');
      expect(detail.evidence.single.title, 'Biên bản bàn giao mặt bằng');
      expect(detail.asOf, directivesAsOf);
    });

    test('an event or a request of a kind the phone does not know refuses the whole answer', () {
      final Map<String, Object?> json = directiveDetailJson();
      expect(parseDirectiveDetail(<String, Object?>{...json, 'timeline': <Object?>[<String, Object?>{'type': 'TELEPORTED', 'occurred_at': '2026-10-01T02:00:00Z'}]}), isNull);
      expect(parseDirectiveDetail(<String, Object?>{...json, 'extensions': <Object?>[<String, Object?>{'status': 'MAYBE'}]}), isNull);
      expect(parseDirectiveDetail(<String, Object?>{...json, 'timeline': null}), isNull);
    });
  });
}
