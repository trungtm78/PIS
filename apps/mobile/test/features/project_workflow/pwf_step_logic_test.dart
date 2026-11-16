import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/project_workflow/pwf_models.dart';
import 'package:machvon_mobile/features/project_workflow/pwf_step_logic.dart';

import 'pwf_fixtures.dart';
import 'pwf_process_test.dart' show steppedWorkflow;
import 'pwf_step_fixtures.dart';

PwfWorkflow _read(Map<String, Object?> json) => (parsePwfWorkflowView(json)! as PwfWorkflowPresent).workflow;

PwfTaskRow _row(Map<String, Object?> json) => parsePwfTaskRow(json)!;

PwfTaskDetail _detail({String status = 'IN_PROGRESS', bool claim = false, bool complete = true, List<Map<String, Object?>>? blockers, Map<String, Object?>? extra}) =>
    parsePwfTaskDetail(<String, Object?>{
      ...taskDetailJson(TaskState(status: status), blockers: blockers),
      'can_claim': claim,
      'can_complete': complete,
      ...?extra,
    })!;

void main() {
  group('what a step waits for', () {
    test('the approver of its completion, the evidence still to hand in, the step that drives its start', () {
      final PwfTaskRow awaiting = _row(taskRow('7f3a0000-0000-4000-8000-000000000011', 'Việc', status: 'AWAITING_APPROVAL'));
      expect(pwfWaitingFor(awaiting), <PwfWaitingFor>[const PwfWaitingFor(PwfWaitKind.approval)]);
      final PwfTaskRow working = _row(<String, Object?>{...taskRow('7f3a0000-0000-4000-8000-000000000011', 'Việc'), 'checklist_total': 3, 'checklist_done': 1});
      expect(pwfWaitingFor(working), <PwfWaitingFor>[const PwfWaitingFor(PwfWaitKind.evidence, count: 2)]);
      final PwfTaskRow before = _row(taskRow('7f3a0000-0000-4000-8000-000000000011', 'Thẩm định'));
      final PwfTaskRow next = _row(taskRow('7f3a0000-0000-4000-8000-000000000012', 'Ký', status: 'NOT_STARTED'));
      final PwfScheduleHints hints = PwfScheduleHints(drivingPredecessor: <String, String>{next.code: before.code});
      expect(pwfWaitingFor(next, hints: hints, byCode: <String, PwfTaskRow>{before.code: before}), <PwfWaitingFor>[const PwfWaitingFor(PwfWaitKind.step, name: 'Thẩm định')]);
    });

    test('a task that is over, left out, not followed, or whose driving step is done waits for nothing; without the schedule nothing is guessed', () {
      final PwfTaskRow done = _row(taskRow('7f3a0000-0000-4000-8000-000000000011', 'Xong', status: 'DONE'));
      final PwfTaskRow next = _row(taskRow('7f3a0000-0000-4000-8000-000000000012', 'Ký', status: 'NOT_STARTED'));
      expect(pwfWaitingFor(done), isEmpty);
      expect(pwfWaitingFor(_row(<String, Object?>{...taskRow('7f3a0000-0000-4000-8000-000000000012', 'Ký', status: 'AWAITING_APPROVAL'), 'tracked': false})), isEmpty);
      expect(pwfWaitingFor(_row(taskRow('7f3a0000-0000-4000-8000-000000000012', 'Ký', status: 'AWAITING_APPROVAL', excluded: true))), isEmpty);
      expect(pwfWaitingFor(next, byCode: <String, PwfTaskRow>{done.code: done}), isEmpty);
      expect(pwfWaitingFor(next, hints: PwfScheduleHints(drivingPredecessor: <String, String>{next.code: done.code}), byCode: <String, PwfTaskRow>{done.code: done}), isEmpty);
    });
  });

  group('the schedule hints', () {
    test('the driving step and the slip of each task are read by code; an answer that is not a schedule gives nothing', () {
      final PwfScheduleHints hints = parsePwfScheduleHints(<String, Object?>{
        'tasks': <Object?>[
          <String, Object?>{'task_code': 'T-12', 'driving_predecessor': 'T-11', 'finish_variance_days': 3},
          <String, Object?>{'task_code': 'T-13', 'driving_predecessor': null, 'finish_variance_days': null},
          <String, Object?>{'name': 'no code'},
        ],
      })!;
      expect(hints.drivingPredecessor, <String, String>{'T-12': 'T-11'});
      expect(hints.finishVariance, <String, int>{'T-12': 3});
      expect(parsePwfScheduleHints(<String, Object?>{'as_of': 'x'}), isNull);
      expect(parsePwfScheduleHints('x'), isNull);
    });

    test('the slip of the whole file is the one of the task that carries it, and is not said when the schedule is not read', () {
      final PwfWorkflow workflow = _read(<String, Object?>{...workflowJson(), 'overall_deadline': overallJson()});
      expect(pwfOverallSlip(workflow, const PwfScheduleHints(finishVariance: <String, int>{'T-12': 3})), 3);
      expect(pwfOverallSlip(workflow, const PwfScheduleHints(finishVariance: <String, int>{'T-99': 3})), isNull);
      expect(pwfOverallSlip(workflow, null), isNull);
      expect(pwfOverallSlip(_read(workflowJson()), const PwfScheduleHints(finishVariance: <String, int>{'T-12': 3})), isNull);
    });
  });

  group('the rows of a phase', () {
    test('a step of several tasks has a header, a step of one task is one row, a task of no step is a row after the steps; the order is the template', () {
      final List<PwfPhaseRows> phases = pwfPhaseRows(_read(steppedWorkflow()));
      final PwfPhaseRows open = phases.firstWhere((PwfPhaseRows phase) => phase.phase.code == 'P2');
      expect(open.entries.map((PwfStepEntry entry) => (entry.step?.code, entry.tasks.length, entry.hasHeader)), <(String?, int, bool)>[('S_BID', 2, true), ('S_CONTRACT', 1, false), (null, 1, false)]);
      expect(open.tasks.map((PwfTaskRow task) => task.code), <String>['T-11', 'T-12', 'T-13', 'T-14']);
    });

    test('a workflow from before steps existed lists every task of the phase as a row', () {
      final List<PwfPhaseRows> phases = pwfPhaseRows(_read(workflowJson()));
      expect(phases.firstWhere((PwfPhaseRows phase) => phase.phase.code == 'P2').entries.every((PwfStepEntry entry) => entry.step == null && entry.tasks.length == 1), isTrue);
      expect(phases.map((PwfPhaseRows phase) => phase.tasks.length), <int>[1, 4, 1], reason: 'the task of a branch the project does not have is not a row');
    });

    test('the progress counts steps when there are some, else tasks', () {
      expect(pwfProgress(_read(steppedWorkflow())).ofSteps, isTrue);
      expect(pwfProgress(_read(steppedWorkflow())).total, 2);
      final ({int done, int total, bool ofSteps}) tasks = pwfProgress(_read(workflowJson()));
      expect((tasks.ofSteps, tasks.total, tasks.done), (false, 6, 1));
    });
  });

  group('what a person may do on a row', () {
    test('take it only when the server says the person may; nothing on a task that is over', () {
      expect(pwfRowActions(_detail(status: 'NOT_STARTED', claim: true, complete: false), canPropose: false).claim, isTrue);
      expect(pwfRowActions(_detail(status: 'NOT_STARTED', claim: false, complete: false), canPropose: false).any, isFalse);
      expect(pwfRowActions(_detail(status: 'DONE', claim: true), canPropose: true).any, isFalse);
    });

    test('hand in evidence while something blocks the completion, complete when nothing does', () {
      final PwfRowActions blocked = pwfRowActions(_detail(blockers: <Map<String, Object?>>[<String, Object?>{'code': 'CHECKLIST_ITEM_OPEN', 'subject': 'C1'}]), canPropose: false);
      expect((blocked.submit, blocked.complete, blocked.pendingRequirements), (true, false, 1));
      final PwfRowActions clear = pwfRowActions(_detail(), canPropose: false);
      expect((clear.submit, clear.complete), (false, true));
      expect(pwfRowActions(_detail(complete: false), canPropose: false).any, isFalse, reason: 'not the person\'s task');
    });

    test('an extension is offered for a step whose template allows it and a person who may propose, and says when its limit is reached', () {
      const PwfExtension open = PwfExtension(allowed: true, unit: PwfDurationUnit.workingDay, timesUsed: 1, valueUsed: 2, maxTimes: 2, maxValue: 5);
      const PwfExtension full = PwfExtension(allowed: true, unit: PwfDurationUnit.workingDay, timesUsed: 2, valueUsed: 2, maxTimes: 2, maxValue: 5);
      const PwfExtension refused = PwfExtension(allowed: false, unit: PwfDurationUnit.workingDay, timesUsed: 0, valueUsed: 0);
      expect(pwfRowActions(_detail(), canPropose: true, extension: open).extend!.capped, isFalse);
      expect(pwfRowActions(_detail(), canPropose: true, extension: full).extend!.capped, isTrue);
      expect(pwfRowActions(_detail(), canPropose: false, extension: open).extend, isNull);
      expect(pwfRowActions(_detail(), canPropose: true, extension: refused).extend, isNull);
      expect(pwfRowActions(_detail(), canPropose: true).extend, isNull, reason: 'a step that names no extension has none');
    });
  });
}
