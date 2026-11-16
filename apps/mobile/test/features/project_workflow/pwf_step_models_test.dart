import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/project_workflow/pwf_models.dart';

import 'pwf_fixtures.dart';
import 'pwf_step_fixtures.dart';

PwfWorkflow _read(Map<String, Object?> json) => (parsePwfWorkflowView(json)! as PwfWorkflowPresent).workflow;

void main() {
  group('an answer from before the step table (R67: the phone of a customer is older than the server)', () {
    test('a workflow, a task of it, a task of mine and the detail of a task parse with no new member and say nothing of them', () {
      final PwfWorkflow workflow = _read(workflowJson());
      expect(workflow.overallDeadline, isNull);
      expect(workflow.canProposeReschedule, isFalse);
      expect(workflow.version, 4);
      for (final PwfTaskRow row in workflow.tasks) {
        expect(row.facts.bandTier, isNull);
        expect(row.facts.unclaimed, isFalse);
        expect(row.facts.extension, isNull);
        expect(row.facts.unitName, isNull);
        expect(row.tracked, isTrue);
      }
      final PwfMyTasks mine = parsePwfMyTasks(myTasksJson())!;
      expect(mine.items.first.facts.bandTier, isNull);
      expect(mine.items.first.facts.unclaimed, isFalse);
      final PwfTaskDetail detail = parsePwfTaskDetail(taskDetailJson(TaskState()))!;
      expect(detail.canClaim, isFalse);
      expect(detail.facts.duration, isNull);
    });

    test('the recorded answer of the enterprise server (none of the new members) still parses', () {
      final PwfMyTasks? mine = parsePwfMyTasks(<String, Object?>{
        'items': <Object?>[myTask('7f3a0000-0000-4000-8000-000000000031', 'Việc')],
        'total': 1,
        'as_of': kAsOf,
      });
      expect(mine, isNotNull);
      expect(mine!.items.single.facts.receivingUnits, isEmpty);
    });
  });

  group('an answer of the server that has the step table', () {
    test('the row carries the tier, the thresholds, the time limit, the receiving unit, the extension and the star', () {
      final PwfWorkflow workflow = _read(workflowJson(tasks: <Map<String, Object?>>[
        <String, Object?>{...taskRow('7f3a0000-0000-4000-8000-000000000012', 'Thẩm định'), ...stepFields(unclaimed: true, overall: true, duration: <String, Object?>{'value': 1, 'unit': 'MONTH', 'roll_to_working_day': true})},
      ]));
      final PwfStepFacts facts = workflow.tasks.single.facts;
      expect(facts.bandTier, PwfBandTier.step);
      expect(facts.bandThresholds!.green, 5);
      expect(facts.bandThresholds!.yellow, 2);
      expect(facts.bandThresholds!.red, 0);
      expect(facts.duration!.value, 1);
      expect(facts.duration!.unit, PwfDurationUnit.month);
      expect(facts.duration!.rollToWorkingDay, isTrue);
      expect(facts.effectiveWorkingDays, 6);
      expect(facts.unitName, 'Phòng Kế hoạch');
      expect(facts.receivingUnits.single.lead, isTrue);
      expect(facts.receivingUnits.single.role, 'Chuyên viên');
      expect(facts.unclaimed, isTrue);
      expect(facts.isOverallDeadline, isTrue);
      expect(facts.extension!.allowed, isTrue);
      expect(facts.extension!.timesUsed, 1);
      expect(facts.extension!.valueUsed, 2);
      expect(facts.extension!.maxTimes, 2);
      expect(facts.extension!.valueLeft, 3);
      expect(facts.extension!.capped, isFalse);
    });

    test('the four tiers are read and a tier this phone does not know is left out (never guessed)', () {
      expect(PwfBandTier.parse('STEP'), PwfBandTier.step);
      expect(PwfBandTier.parse('POLICY_OVERRIDE'), PwfBandTier.policyOverride);
      expect(PwfBandTier.parse('POLICY'), PwfBandTier.policy);
      expect(PwfBandTier.parse('SYSTEM'), PwfBandTier.system);
      expect(PwfBandTier.parse('TENANT_DEFAULT'), isNull);
    });

    test('an extension with no limit is never capped, and one at its limit is', () {
      final PwfExtension open = parsePwfExtension(<String, Object?>{'allowed': true, 'max_times': null, 'max_value': null, 'unit': 'CALENDAR_DAY', 'times_used': 9, 'value_used': 99})!;
      expect(open.capped, isFalse);
      expect(open.valueLeft, isNull);
      expect(parsePwfExtension(<String, Object?>{'allowed': true, 'max_times': 2, 'max_value': null, 'unit': 'WORKING_DAY', 'times_used': 2, 'value_used': 4})!.capped, isTrue);
      expect(parsePwfExtension(<String, Object?>{'allowed': true, 'max_times': null, 'max_value': 5, 'unit': 'WORKING_DAY', 'times_used': 1, 'value_used': 5})!.capped, isTrue);
      expect(parsePwfExtension(<String, Object?>{'allowed': false, 'unit': 'WORKING_DAY', 'times_used': 0, 'value_used': 0})!.allowed, isFalse);
    });

    test('a member of a shape this phone does not know is left out, the rest of the row is read', () {
      final PwfWorkflow workflow = _read(workflowJson(tasks: <Map<String, Object?>>[
        <String, Object?>{
          ...taskRow('7f3a0000-0000-4000-8000-000000000012', 'Thẩm định'),
          'duration': <String, Object?>{'value': 3, 'unit': 'FORTNIGHT'},
          'extension': 'yes',
          'band_thresholds': <String, Object?>{'yellow_days': 'two'},
          'receiving_units': 'Phòng Kế hoạch',
        },
      ]));
      expect(workflow.tasks.single.facts.duration, isNull);
      expect(workflow.tasks.single.facts.extension, isNull);
      expect(workflow.tasks.single.facts.bandThresholds, isNull);
      expect(workflow.tasks.single.facts.receivingUnits, isEmpty);
      expect(workflow.tasks.single.name, 'Thẩm định');
    });

    test('the deadline of the whole file, with the days left and the tier of its colour', () {
      final PwfWorkflow workflow = _read(<String, Object?>{...workflowJson(), 'overall_deadline': overallJson(), 'can_propose_reschedule': true});
      expect(workflow.overallDeadline!.band, 'YELLOW');
      expect(workflow.overallDeadline!.remainingDays, 2);
      expect(workflow.overallDeadline!.bandTier, PwfBandTier.policy);
      expect(workflow.overallDeadline!.dueOn, '2026-11-14');
      expect(workflow.canProposeReschedule, isTrue);
      expect(_read(<String, Object?>{...workflowJson(), 'overall_deadline': null}).overallDeadline, isNull);
      expect(_read(<String, Object?>{...workflowJson(), 'overall_deadline': <String, Object?>{'task_id': 'x'}}).overallDeadline, isNull);
    });

    test('the detail of a task says whether the person may take it, and the unit that receives it', () {
      final PwfTaskDetail detail = parsePwfTaskDetail(<String, Object?>{...taskDetailJson(TaskState(assignee: false)), ...stepFields(unclaimed: true), 'can_claim': true})!;
      expect(detail.canClaim, isTrue);
      expect(detail.facts.unclaimed, isTrue);
      expect(detail.facts.unitName, 'Phòng Kế hoạch');
    });

    test('a task of mine carries the tier of its colour and whether nobody has taken it', () {
      final PwfMyTasks mine = parsePwfMyTasks(<String, Object?>{
        'items': <Object?>[<String, Object?>{...myTask('7f3a0000-0000-4000-8000-000000000031', 'Việc'), ...stepFields(tier: 'SYSTEM', unclaimed: true)}],
        'total': 1,
        'as_of': kAsOf,
      })!;
      expect(mine.items.single.facts.bandTier, PwfBandTier.system);
      expect(mine.items.single.facts.unclaimed, isTrue);
    });
  });
}
