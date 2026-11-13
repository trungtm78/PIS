import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/features/project_workflow/pwf_commands.dart';
import 'package:machvon_mobile/features/project_workflow/pwf_models.dart';
import 'package:machvon_mobile/features/project_workflow/screens/deadline_preference_screen.dart';
import 'package:machvon_mobile/features/project_workflow/screens/my_tasks_screen.dart';

import 'pwf_fixtures.dart';

QueuedCommand _command(String type, {String task = kTaskId, CommandState state = CommandState.queued, int created = 1, String key = 'k'}) => QueuedCommand(
      id: 'id-$created-$type',
      tenantId: 't',
      userId: 'u',
      commandType: type,
      payload: <String, Object?>{'task_id': task},
      payloadBytes: 10,
      baseServerVersion: 3,
      idempotencyKey: '$key-$created-0000000000',
      state: state,
      createdAt: created,
      updatedAt: created,
    );

void main() {
  group('the bands of a deadline as the server counts them', () {
    test('every kind is read, and a band with an unknown kind or unit is refused as a whole', () {
      expect(parsePwfBand(band('RED', days: -2))!.kind, PwfBandKind.red);
      expect(parsePwfBand(band('NONE', reason: 'FAR'))!.reason, 'FAR');
      expect(parsePwfBand(band('UNKNOWN', reason: 'CALENDAR_UNAVAILABLE'))!.kind, PwfBandKind.unknown);
      expect(parsePwfBand(<String, Object?>{'band': 'PURPLE', 'unit': 'WORKING'}), isNull);
      expect(parsePwfBand(<String, Object?>{'band': 'RED', 'unit': 'HOURS'}), isNull);
      expect(parsePwfBand('RED'), isNull);
    });

    test('the unit decides "days" or "working days"', () {
      expect(parsePwfBand(band('GREEN', days: 3, unit: 'CALENDAR'))!.isWorking, isFalse);
      expect(parsePwfBand(band('GREEN', days: 3))!.isWorking, isTrue);
    });
  });

  group('the workflow of a project', () {
    test('the stages are in order, the open one is the current, and a branch the project does not have is not work', () {
      final PwfWorkflow workflow = (parsePwfWorkflowView(workflowJson())! as PwfWorkflowPresent).workflow;
      expect(workflow.phases.map((PwfPhase p) => p.code), <String>['P1', 'P2', 'P3']);
      expect(workflow.currentIndex, 2);
      expect(workflow.currentPhase!.name, 'Thực hiện đầu tư');
      expect(workflow.requiredDone, 4);
      expect(workflow.requiredTotal, 9);
      expect(workflow.tasks, hasLength(7));
      expect(workflow.visibleTasks, hasLength(6));
      expect(workflow.tasksOf('P3').map((PwfTaskRow t) => t.name), <String>['Quyết toán dự án']);
      expect(workflow.countsByBand[PwfBandKind.red], 1);
    });

    test('the milestones ahead come nearest first and never include a task that is over', () {
      final PwfWorkflow workflow = (parsePwfWorkflowView(workflowJson())! as PwfWorkflowPresent).workflow;
      expect(workflow.upcomingMilestones().map((PwfTaskRow t) => t.name), <String>['Ký hợp đồng thi công']);
    });

    test('a project with no workflow is a result, not a failure; an answer that lacks what makes it citable is refused as a whole', () {
      expect(parsePwfWorkflowView(<String, Object?>{'absent': true}), isA<PwfWorkflowAbsent>());
      expect(parsePwfWorkflowView(<String, Object?>{'status': 'ACTIVE'}), isNull);
      final Map<String, Object?> broken = workflowJson(tasks: <Map<String, Object?>>[<String, Object?>{'id': 'x', 'name': 'no code'}]);
      expect(parsePwfWorkflowView(broken), isNull);
      expect(parsePwfWorkflowView('text'), isNull);
    });

    test('every stage over puts the strip on the last stage', () {
      final Map<String, Object?> json = workflowJson()..['open_phase'] = null;
      for (final Object? phase in json['phases']! as List<Object?>) {
        (phase! as Map<String, Object?>)['open'] = false;
      }
      expect((parsePwfWorkflowView(json)! as PwfWorkflowPresent).workflow.currentIndex, 3);
    });
  });

  group('my tasks', () {
    test('the official and the personal band are both read, and the list says when they differ', () {
      final PwfMyTasks tasks = parsePwfMyTasks(myTasksJson())!;
      expect(tasks.items, hasLength(5));
      expect(tasks.items.first.official.kind, PwfBandKind.yellow);
      expect(tasks.items.first.personal.kind, PwfBandKind.red);
      expect(tasks.items.first.personalDiffers, isTrue);
      expect(tasks.items[1].personalDiffers, isFalse);
    });

    test('the groups follow the band the list is coloured by, and a task that is over is its own group', () {
      final PwfMyTasks tasks = parsePwfMyTasks(myTasksJson())!;
      expect(pwfGroupOf(tasks.items.first, PwfColourMode.personal), PwfGroup.late);
      expect(pwfGroupOf(tasks.items.first, PwfColourMode.official), PwfGroup.soon);
      expect(pwfGroupOf(tasks.items[3], PwfColourMode.personal), PwfGroup.far);
      expect(pwfGroupOf(tasks.items.last, PwfColourMode.personal), PwfGroup.done);
    });

    test('a row without its two bands is refused', () {
      final Map<String, Object?> json = myTasksJson();
      ((json['items']! as List<Object?>).first! as Map<String, Object?>).remove('personal_band');
      expect(parsePwfMyTasks(json), isNull);
    });
  });

  group('a task', () {
    test('its checklist, requirements, evidence, blockers, exceptions and history are read, with what the person may do', () {
      final TaskState state = TaskState()..checklistDone = <String>{'C1'};
      state.evidence.add(<String, Object?>{'id': 'e1', 'item_code': 'C1', 'evidence_kind': 'DOCUMENT', 'document_id': null, 'legal_doc_type': null, 'form_template_code': null, 'external_ref': 'QD-12', 'note': null, 'attached_by': 'x', 'attached_at': kAsOf});
      state.exceptions.add(<String, Object?>{'id': 'x1', 'task_id': kTaskId, 'kind': 'EXTERNAL_DELAY', 'items': <Object?>[], 'valid_from': '2026-11-10', 'valid_to': '2026-11-12', 'reason': 'Chờ Sở', 'evidence_ref': null, 'status': 'REQUESTED', 'requested_by': 'x', 'decided_by': null, 'decided_at': null, 'decision_note': null, 'version': 1});
      final PwfTaskDetail task = parsePwfTaskDetail(taskDetailJson(state, blockers: <Map<String, Object?>>[<String, Object?>{'code': 'CHECKLIST_ITEM_OPEN', 'subject': 'C2'}]))!;
      expect(task.checklist.map((PwfChecklistItem i) => i.done), <bool>[true, false]);
      expect(task.checklist.last.evidenceKinds, <String>['DOCUMENT']);
      expect(task.legalDocTypes.map((PwfRequirement r) => r.satisfied), <bool>[true, false]);
      expect(task.evidence.single.externalRef, 'QD-12');
      expect(task.blockers.single.subject, 'C2');
      expect(task.hasPendingException, isTrue);
      expect(task.history.map((PwfHistoryEntry e) => e.kind), <String>['START', 'RETURNED']);
      expect(task.canComplete, isTrue);
      expect(task.canStart, isFalse);
      expect(task.version, 3);
    });

    test('an answer without a version or a band is refused', () {
      final Map<String, Object?> json = taskDetailJson(TaskState())..remove('version');
      expect(parsePwfTaskDetail(json), isNull);
    });
  });

  group('the personal reminders', () {
    test('the thresholds, the reminder days, the official rule and what the server raised are read', () {
      final PwfPreference preference = parsePwfPreference(preferenceJson(green: 7, yellow: 3, red: 1, reminders: <int>[5, 2, 0], clamped: <String>['red_days']))!;
      expect(preference.green, 7);
      expect(preference.reminderDays, <int>[5, 2, 0]);
      expect(preference.official!.yellow, 2);
      expect(preference.clamped, <String>['red_days']);
      expect(preference.version, 2);
    });

    test('the thresholds typed by the person: blank is "none", anything but a whole number is refused', () {
      expect(parseThresholds('', '3', '1'), (green: null, yellow: 3, red: 1));
      expect(parseThresholds('x', '3', '1'), isNull);
      expect(parseThresholds(' 7 ', ' 3', '-1'), (green: 7, yellow: 3, red: -1));
    });

    test('the reminder days: commas, semicolons or spaces; a word is refused', () {
      expect(parseReminderDays('5, 2; 0 -1'), <int>[5, 2, 0, -1]);
      expect(parseReminderDays(''), <int>[]);
      expect(parseReminderDays('5, soon'), isNull);
    });

    test('a personal setting can remind earlier than the official rule, never later; green above yellow above red', () {
      const PwfThresholds official = PwfThresholds(green: 5, yellow: 2, red: 0);
      expect(checkThresholds((green: 7, yellow: 3, red: 1), official), isNull);
      expect(checkThresholds((green: null, yellow: null, red: null), official), isNull);
      expect(checkThresholds((green: 7, yellow: 1, red: 0), official), PwfPreferenceProblem.notEarlier, reason: 'yellow at 1 is later than the official 2');
      expect(checkThresholds((green: 4, yellow: 2, red: 0), official), PwfPreferenceProblem.notEarlier, reason: 'green at 4 is later than the official 5');
      expect(checkThresholds((green: 7, yellow: 3, red: 3), official), PwfPreferenceProblem.notDescending);
      expect(checkThresholds((green: 3, yellow: 3, red: 1), official), PwfPreferenceProblem.notDescending);
      expect(checkThresholds((green: 7, yellow: 3, red: -2), official), PwfPreferenceProblem.notDescending);
    });
  });

  group('the score of the person', () {
    test('the score, the rating, the way it was worked out, what was left out, the adjustments and the responses', () {
      final PwfScoreLine line = parsePwfMyScores(scoresJson(items: <Map<String, Object?>>[scoreItem(adjusted: 85)]))!.lines.single;
      expect(line.shownScore, 85, reason: 'the adjusted score is shown first');
      expect(line.scoreComputed, 82.5);
      expect(line.contributions, hasLength(2));
      expect(line.excluded.single.taskCode, 'T-13');
      expect(line.adjustments.single.status, 'APPROVED');
      expect(line.responses.single.status, 'OPEN');
      expect(line.canRespond, isTrue);
      expect(line.periodFrom, '2026-07-01');
      expect(line.policyVersion, 1);
    });

    test('a line without its state or version is refused as a whole', () {
      final Map<String, Object?> item = scoreItem();
      (item['line']! as Map<String, Object?>).remove('state');
      expect(parsePwfMyScores(scoresJson(items: <Map<String, Object?>>[item])), isNull);
    });
  });

  group('the commands of the work on a task', () {
    test('a payload leaves out what the person left empty and names the task', () {
      expect(pwfStartPayload(kTaskId, note: ' ', earlyStartReason: null), <String, Object?>{'task_id': kTaskId});
      expect(pwfCompletePayload(kTaskId, note: ' xong '), <String, Object?>{'task_id': kTaskId, 'note': 'xong'});
      expect(pwfChecklistPayload(kTaskId, 'C2', note: 'đã họp'), <String, Object?>{'task_id': kTaskId, 'item_code': 'C2', 'note': 'đã họp'});
      expect(pwfEvidencePayload(kTaskId, evidenceKind: 'DOCUMENT', itemCode: 'C2', externalRef: ' QD-12 '), <String, Object?>{'task_id': kTaskId, 'evidence_kind': 'DOCUMENT', 'item_code': 'C2', 'external_ref': 'QD-12'});
      expect(pwfExceptionPayload(kTaskId, kind: 'EXTERNAL_DELAY', reason: ' Chờ ý kiến của Sở ', validFrom: '2026-11-12', validTo: '2026-11-19'), <String, Object?>{'task_id': kTaskId, 'kind': 'EXTERNAL_DELAY', 'reason': 'Chờ ý kiến của Sở', 'valid_from': '2026-11-12', 'valid_to': '2026-11-19'});
    });

    test('only the commands that change the version of the task are versioned; an approval and a return are not queued at all', () {
      expect(kPwfVersionedCommands, <String>{kPwfStartCommand, kPwfChecklistCommand, kPwfCompleteCommand});
      expect(kPwfQueuedCommands, hasLength(5));
      expect(kPwfQueuedCommands.any((String type) => type.contains('approve') || type.contains('return') || type.contains('sign')), isFalse);
    });

    test('the base version of a new command is the version that was read plus the versioned commands that go before it', () {
      final List<QueuedCommand> pending = <QueuedCommand>[_command(kPwfStartCommand, created: 1), _command(kPwfEvidenceCommand, created: 2), _command(kPwfChecklistCommand, created: 3)];
      expect(pwfBaseVersion(3, const <QueuedCommand>[]), 3);
      expect(pwfBaseVersion(3, pending), 5, reason: 'start and the checklist item count, the evidence does not');
      expect(pwfBaseVersion(3, <QueuedCommand>[_command(kPwfCompleteCommand, state: CommandState.conflict)]), 3, reason: 'a command in conflict does not go before anything');
    });

    test('the commands of one task, oldest first, without the settled ones and without the commands of another task or another feature', () {
      final List<QueuedCommand> all = <QueuedCommand>[
        _command(kPwfCompleteCommand, created: 3),
        _command(kPwfStartCommand, created: 1),
        _command(kPwfStartCommand, task: 'other', created: 2),
        _command(kPwfEvidenceCommand, created: 4, state: CommandState.accepted),
        _command('issue.create', created: 5),
      ];
      expect(pwfCommandsOf(all, kTaskId).map((QueuedCommand c) => c.createdAt), <int>[1, 3]);
    });

    test('a reason shorter than the minimum is not long enough', () {
      expect(pwfReasonIsLongEnough('quá ngắn'), isFalse);
      expect(pwfReasonIsLongEnough('Chờ ý kiến thẩm định của Sở Kế hoạch'), isTrue);
      expect(pwfReasonIsLongEnough('                         '), isFalse);
    });
  });
}
