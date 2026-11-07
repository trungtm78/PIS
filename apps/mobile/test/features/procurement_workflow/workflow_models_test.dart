import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/procurement_workflow/workflow_models.dart';

import 'prc_fixtures.dart';

PrcWorkflow _workflow({String status = 'IN_PROGRESS', bool late = true}) => parsePrcDetail(detailJson(status: status, late: late))!.workflow!;

void main() {
  group('the process tree', () {
    test('is read with its nodes, edges, KPIs and period; the first level is the methods', () {
      final PrcTree tree = parsePrcTree(treeJson())!;
      expect(tree.totalCount, 10);
      expect(tree.methods.map((PrcNode node) => node.id), <String>['M:OPEN_BIDDING']);
      expect(tree.childrenOf('M:OPEN_BIDDING').map((PrcNode node) => node.id), <String>[
        'T:OPEN_BIDDING:NOT_STARTED',
        'S:OPEN_BIDDING:DOC_PREPARE',
        'S:OPEN_BIDDING:EVALUATE',
        'T:OPEN_BIDDING:COMPLETED',
        'T:OPEN_BIDDING:CANCELLED',
      ]);
      expect([tree.running, tree.late, tree.stalled, tree.onHold, tree.noOwner], <int>[7, 2, 1, 1, 1]);
      expect(tree.periodFrom, '2026-10-13');
      expect(tree.byId('S:OPEN_BIDDING:EVALUATE')!.medianWorking, isFalse);
      expect(tree.byId('S:OPEN_BIDDING:EVALUATE')!.medianDays, 9.5);
      expect(tree.byId('S:OPEN_BIDDING:DOC_PREPARE')!.shareFraction, 0.4);
    });

    test('counts the moves of the period as text for the outline: into a node, and sent back from it', () {
      final PrcTree tree = parsePrcTree(treeJson())!;
      expect(tree.movedInto('S:OPEN_BIDDING:DOC_PREPARE'), 3);
      expect(tree.movedInto('S:OPEN_BIDDING:EVALUATE'), 2);
      expect(tree.returnedFrom('S:OPEN_BIDDING:EVALUATE'), 1);
      expect(tree.returnedFrom('S:OPEN_BIDDING:DOC_PREPARE'), 0);
    });

    test('says the health in words: no late package is ok, some late needs attention, all late is late, a hold says so, an empty node has none', () {
      final PrcTree tree = parsePrcTree(treeJson())!;
      expect(healthOf(tree.byId('S:OPEN_BIDDING:EVALUATE')!), PrcHealth.ok);
      expect(healthOf(tree.byId('S:OPEN_BIDDING:DOC_PREPARE')!), PrcHealth.attention);
      expect(healthOf(tree.byId('S:OPEN_BIDDING:DOC_PREPARE:LATE')!), PrcHealth.late);
      expect(healthOf(tree.byId('S:OPEN_BIDDING:EVALUATE:ON_HOLD')!), PrcHealth.hold);
      expect(healthOf(tree.byId('S:OPEN_BIDDING:DOC_PREPARE:ON_HOLD')!), PrcHealth.none);
      expect(healthOf(tree.byId('T:OPEN_BIDDING:COMPLETED')!), PrcHealth.ok);
      expect(healthOf(tree.byId('T:OPEN_BIDDING:CANCELLED')!), PrcHealth.none);
      const PrcNode allLate = PrcNode(id: 'S:X:Y', parentId: 'M:X', kind: PrcNodeKind.step, count: 2, valueVnd: '1', lateCount: 2);
      expect(healthOf(allLate), PrcHealth.late);
    });

    test('is refused as a whole when a node has no amount, an edge has no end or the period is missing', () {
      expect(parsePrcTree(null), isNull);
      final Map<String, Object?> noAmount = treeJson();
      ((noAmount['nodes']! as List<Object?>)[1]! as Map<String, Object?>)['value_vnd'] = 12;
      expect(parsePrcTree(noAmount), isNull);
      final Map<String, Object?> noEnd = treeJson();
      ((noEnd['edges']! as List<Object?>)[0]! as Map<String, Object?>).remove('to');
      expect(parsePrcTree(noEnd), isNull);
      final Map<String, Object?> noPeriod = treeJson()..remove('period');
      expect(parsePrcTree(noPeriod), isNull);
    });
  });

  group('the packages of a node', () {
    test('a page keeps the rows in the order the server sent, with the cursor and the cut flag', () {
      final PrcRowPage page = parsePrcRowPage(rowPage(<Object?>[rowJson('a', 'G-001', late: true, lateDays: 3, stalled: true), rowJson('b', 'G-002', status: 'ON_HOLD', owner: null)], next: 'c1', truncated: true))!;
      expect(page.items.map((PrcPackageRow row) => row.code), <String>['G-001', 'G-002']);
      expect(page.nextCursor, 'c1');
      expect(page.truncated, isTrue);
      final PrcPackageRow late = page.items.first;
      expect([late.late, late.lateDays, late.stalled, late.daysWorking, late.daysCalendar, late.daysLeft], <Object>[true, 3, true, 5, 7, 3]);
      expect(late.stepName, 'Lập hồ sơ mời thầu');
      final PrcPackageRow held = page.items.last;
      expect([held.held, held.hasOwner, held.running], <bool>[true, false, true]);
    });

    test('a row without a code, an amount or a state refuses the page', () {
      expect(parsePrcRowPage(rowPage(<Object?>[rowJson('a', 'G-1')..remove('package_code')])), isNull);
      expect(parsePrcRowPage(rowPage(<Object?>[rowJson('a', 'G-1')..['value_vnd'] = '12.5'])), isNull);
      expect(parsePrcRowPage(rowPage(<Object?>[rowJson('a', 'G-1')..['status'] = 'SLEEPING'])), isNull);
      expect(parsePrcRowPage(<String, Object?>{'next_cursor': null}), isNull);
    });
  });

  group('one package', () {
    test('is read with its stepper, blockers, checklist, summary and the timeline days', () {
      final PrcDetail detail = parsePrcDetail(detailJson())!;
      expect(detail.code, 'G-001');
      final PrcWorkflow workflow = detail.workflow!;
      expect(workflow.steps, hasLength(4));
      expect(workflow.blockers.map((PrcBlocker blocker) => blocker.reason), <String>['REQUIRED_ITEMS_OPEN', 'STEP_OVERDUE']);
      expect(workflow.checklist.map((PrcChecklistItem item) => item.status), <String>['DONE', 'OPEN']);
      expect(workflow.checklist.first.evidence.single.kind, 'ATTESTATION');
      expect(workflow.checklist.last.ownerName, 'Lê Văn Cường');
      expect(workflow.timeline.map((PrcTimelineDay day) => day.day), <String>['2026-11-04', '2026-11-03', '2026-11-02']);
      expect(workflow.stepNameOf('EVALUATE'), 'Đánh giá hồ sơ dự thầu');
      expect(workflow.stepNameOf('NOPE'), 'NOPE', reason: 'a code the definition does not have is shown as it came');
      expect(workflow.daysInStep, 6);
      expect(workflow.petitionsOpen, 1);
      expect(workflow.milestones.single.kind, 'BID_OPENING');
    });

    test('a package with no workflow keeps what it would follow; a body that lacks the package, or has a broken workflow, is refused', () {
      final PrcDetail detail = parsePrcDetail(detailJson(withWorkflow: false))!;
      expect(detail.workflow, isNull);
      expect(detail.startable, isTrue);
      expect(detail.definitionSteps, hasLength(4));
      expect(parsePrcDetail(<String, Object?>{'as_of': asOf}), isNull);
      final Map<String, Object?> broken = detailJson();
      (broken['workflow']! as Map<String, Object?>).remove('progress');
      expect(parsePrcDetail(broken), isNull);
    });
  });

  group('the stepper', () {
    test('steps before the current one are done, the current one is late when the server says so, the rest are upcoming, with the standard and the actual days', () {
      final List<PrcStepRow> rows = stepperOf(_workflow());
      expect(rows.map((PrcStepRow row) => row.state), <PrcStepState>[PrcStepState.done, PrcStepState.done, PrcStepState.late, PrcStepState.upcoming]);
      expect([rows[1].plannedDays, rows[1].actualDays], <int?>[2, 2]);
      expect([rows[2].plannedDays, rows[2].actualDays, rows[2].daysOver], <int?>[4, 6, 2]);
      expect(rows[3].actualDays, isNull);
    });

    test('is current when the step is not late, hold when the package is on hold, and all done when completed', () {
      expect(stepperOf(_workflow(late: false))[2].state, PrcStepState.current);
      expect(stepperOf(_workflow(status: 'ON_HOLD'))[2].state, PrcStepState.hold);
    });
  });

  group('the timeline rows', () {
    test('lists the days newest first with their entries and a gap for the wait since the last change up to today (the step the package waits in)', () {
      final PrcWorkflow workflow = _workflow();
      final List<PrcTimelineRow> rows = timelineRowsOf(workflow, today: '2026-11-12', onlyStateChanges: false);
      expect(rows.map((PrcTimelineRow row) => row.runtimeType.toString()), <String>[
        'PrcGapRow',
        'PrcDayHeaderRow',
        'PrcEntryRow',
        'PrcDayHeaderRow',
        'PrcEntryRow',
        'PrcDayHeaderRow',
        'PrcEntryRow',
      ]);
      final PrcGapRow gap = rows.first as PrcGapRow;
      // 5 to 11 November are quiet and today (the 12th) is part of the wait: 8 days.
      expect(gap.days, 8);
      expect(gap.quietDays.first, '2026-11-05');
      expect(gap.quietDays.last, '2026-11-12');
      expect(gap.waitingStep, 'EVALUATE');
      expect((rows[1] as PrcDayHeaderRow).day, '2026-11-04');
      expect((rows[1] as PrcDayHeaderRow).changes, 1);
      expect((rows[3] as PrcDayHeaderRow).changes, 0, reason: 'a day with only an item done has no change of state');
    });

    test('with only the changes of state the day with an item disappears and the gap between the other two is counted again, naming the step the package was in then', () {
      final List<PrcTimelineRow> rows = timelineRowsOf(_workflow(), today: '2026-11-12', onlyStateChanges: true);
      expect(rows.whereType<PrcEntryRow>().map((PrcEntryRow row) => row.entry.kind), <String>['STATE_CHANGE', 'START']);
      final List<PrcGapRow> gaps = rows.whereType<PrcGapRow>().toList();
      expect(gaps.map((PrcGapRow gap) => gap.days), <int>[8, 1]);
      expect(gaps.last.quietDays, <String>['2026-11-03']);
      expect(gaps.last.waitingStep, 'DOC_PREPARE');
    });

    test('a package that is no longer running has no wait up to today; a timeline with nothing kept is empty', () {
      final PrcWorkflow done = _workflow(status: 'COMPLETED');
      expect(timelineRowsOf(done, today: '2026-11-12', onlyStateChanges: false).first, isA<PrcDayHeaderRow>());
      final Map<String, Object?> empty = detailJson();
      ((empty['workflow']! as Map<String, Object?>)['timeline']! as Map<String, Object?>)['days'] = <Object?>[];
      expect(timelineRowsOf(parsePrcDetail(empty)!.workflow!, today: '2026-11-12', onlyStateChanges: false), isEmpty);
    });

    test('the day of an answer is the Vietnam day, and the weekday and the difference of days are exact', () {
      expect(dayOfAnswer('2026-11-12T18:30:00Z'), '2026-11-13', reason: 'seven hours ahead');
      expect(weekdayOf('2026-11-04'), DateTime.wednesday);
      expect(daysBetween('2026-10-30', '2026-11-02'), 3);
    });
  });
}
