import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/api/answer.dart';
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

    test('one stage is where the project is: the stage the server names, never every stage that still has required work', () {
      Map<String, Object?> phase(String code, int order, String standing) => <String, Object?>{'code': code, 'name': code, 'order': order, 'required_total': 2, 'required_done': standing == 'DONE' ? 2 : 0, 'open': standing != 'DONE', 'current': standing == 'CURRENT', 'standing': standing};
      final PwfWorkflow parallel = (parsePwfWorkflowView(workflowJson()..['phases'] = <Object?>[phase('A', 1, 'DONE'), phase('B', 2, 'CURRENT'), phase('C', 3, 'STARTED'), phase('D', 4, 'UPCOMING')]..['open_phase'] = 'B')! as PwfWorkflowPresent).workflow;
      expect(parallel.phases.map((PwfPhase p) => p.standing), <PwfPhaseStanding>[PwfPhaseStanding.done, PwfPhaseStanding.current, PwfPhaseStanding.started, PwfPhaseStanding.upcoming]);
      expect(parallel.currentIndex, 2);
      expect(parallel.phases.where((PwfPhase p) => p.standing == PwfPhaseStanding.current), hasLength(1));
      // An answer from before the server said where each stage stands: the earliest stage that is still open is the current one, the ones before it are done, the ones after it are ahead.
      final PwfWorkflow older = (parsePwfWorkflowView(workflowJson())! as PwfWorkflowPresent).workflow;
      expect(older.phases.map((PwfPhase p) => p.standing), <PwfPhaseStanding>[PwfPhaseStanding.done, PwfPhaseStanding.current, PwfPhaseStanding.upcoming]);
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
      expect(tasks.items.first.personal?.kind, PwfBandKind.red);
      expect(tasks.items.first.own.kind, PwfBandKind.red);
      expect(tasks.items.first.personalDiffers, isTrue);
      expect(tasks.items[1].personalDiffers, isFalse);
    });

    test('the groups follow the band the list is coloured by, and a task that is over is its own group', () {
      final PwfMyTasks tasks = parsePwfMyTasks(myTasksJson())!;
      // Red by the person's ladder with two days left is due, not late: only a deadline that has passed is under "late" (R49).
      expect(pwfGroupOf(tasks.items.first, PwfColourMode.personal), PwfGroup.due);
      expect(pwfGroupOf(tasks.items[1], PwfColourMode.personal), PwfGroup.late);
      expect(pwfGroupOf(tasks.items[1], PwfColourMode.official), PwfGroup.late);
      expect(pwfGroupOf(tasks.items.first, PwfColourMode.official), PwfGroup.soon);
      expect(pwfGroupOf(tasks.items[3], PwfColourMode.personal), PwfGroup.far);
      expect(pwfGroupOf(tasks.items.last, PwfColourMode.personal), PwfGroup.done);
    });

    test('B7: the band says whether the deadline has passed and whether it is today, as the server counted (the weekend after a Friday is overdue with no working day of lateness)', () {
      final PwfBand saturday = parsePwfBand(<String, Object?>{'band': 'RED', 'remaining_days': 0, 'unit': 'WORKING', 'overdue': true, 'due_today': false})!;
      expect(saturday.overdue, isTrue);
      expect(saturday.dueToday, isFalse);
      final PwfBand friday = parsePwfBand(<String, Object?>{'band': 'RED', 'remaining_days': 0, 'unit': 'WORKING', 'overdue': false, 'due_today': true})!;
      expect(friday.overdue, isFalse);
      expect(friday.dueToday, isTrue);
      // A copy kept before the server said so tells nothing of today.
      expect(parsePwfBand(<String, Object?>{'band': 'RED', 'remaining_days': 0, 'unit': 'WORKING', 'overdue': false})!.dueToday, isNull);
    });

    test('a row without its two bands is refused', () {
      final Map<String, Object?> json = myTasksJson();
      ((json['items']! as List<Object?>).first! as Map<String, Object?>).remove('personal_band');
      expect(parsePwfMyTasks(json), isNull);
      // A personal band that is there and is no band is a mismatch as well; only null means "none".
      final Map<String, Object?> wrong = myTasksJson();
      ((wrong['items']! as List<Object?>).first! as Map<String, Object?>)['personal_band'] = <String, Object?>{'band': 'PURPLE', 'unit': 'WORKING'};
      expect(parsePwfMyTasks(wrong), isNull);
      final Map<String, Object?> noOfficial = myTasksJson();
      ((noOfficial['items']! as List<Object?>).first! as Map<String, Object?>)['official_band'] = null;
      expect(parsePwfMyTasks(noOfficial), isNull);
    });

    test('the real answer of the enterprise stack is read: a person with no level of their own has no personal band, and each task follows the official one', () {
      final Object? json = jsonDecode(kEnterpriseMyTasksAnswer);
      // The decoder generated from the contract accepts the answer (the contract says the member may be null) ...
      expect(() => decodeAnswer('getMyTasks', json), returnsNormally);
      // ... and so does the reader of the screen.
      final PwfMyTasks? tasks = parsePwfMyTasks(json);
      expect(tasks, isNotNull);
      expect(tasks!.items, hasLength(2));
      expect(tasks.total, 2);
      expect(tasks.asOf, '2026-11-14T10:38:54.753Z');
      final PwfMyTask late = tasks.items.first;
      expect(late.code, 'PREP_NEEDS');
      expect(late.personal, isNull);
      expect(late.official.kind, PwfBandKind.red);
      expect(late.own.kind, PwfBandKind.red, reason: 'the view of the person is coloured by the official band where they have none of their own');
      expect(late.personalDiffers, isFalse);
      expect(tasks.items[1].own.reason, 'FAR');
      // The list groups it under "late" in either colour mode.
      expect(pwfGroupOf(late, PwfColourMode.personal), PwfGroup.late);
      expect(pwfGroupOf(late, PwfColourMode.official), PwfGroup.late);
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

    test('the names the server sends are read: who did what, the title of a document, the people of the task, and the forecast when it is another day than the deadline', () {
      final TaskState state = TaskState()..checklistDone = <String>{'C1'};
      state.evidence.add(<String, Object?>{'id': 'e1', 'item_code': null, 'evidence_kind': 'DOCUMENT', 'document_id': 'd1', 'legal_doc_type': null, 'form_template_code': null, 'external_ref': null, 'note': null, 'attached_by': 'm-1', 'attached_by_name': 'Nguyễn Văn An', 'attached_at': kAsOf, 'document_title': 'Tờ trình chủ trương đầu tư', 'document_symbol': '12/TTr-BQL'});
      state.exceptions.add(<String, Object?>{'id': 'x1', 'task_id': kTaskId, 'kind': 'EXTERNAL_DELAY', 'items': <Object?>[], 'valid_from': '2026-11-10', 'valid_to': '2026-11-12', 'reason': 'Chờ Sở', 'evidence_ref': null, 'status': 'APPROVED', 'requested_by': 'm-1', 'requested_by_name': 'Nguyễn Văn An', 'decided_by': 'm-2', 'decided_by_name': 'Trần Thị Bích', 'decision_note': null, 'version': 2});
      final Map<String, Object?> json = taskDetailJson(state)
        ..['forecast_finish'] = '2026-11-20'
        ..['assignments'] = <Object?>[
          <String, Object?>{'membership_id': 'm-1', 'display_name': 'Nguyễn Văn An', 'role': 'RESPONSIBLE', 'valid_from': '2026-11-01', 'valid_to': null},
          <String, Object?>{'membership_id': 'm-2', 'display_name': 'Trần Thị Bích', 'role': 'ACCOUNTABLE', 'valid_from': '2026-11-01', 'valid_to': null},
          <String, Object?>{'membership_id': 'm-3', 'display_name': 'Người đã thôi', 'role': 'RESPONSIBLE', 'valid_from': '2026-10-01', 'valid_to': '2026-10-31'},
        ]
        ..['history'] = <Object?>[<String, Object?>{'id': 'h1', 'kind': 'START', 'at': kAsOf, 'actor': 'm-1', 'actor_name': 'Nguyễn Văn An', 'reason': null}];
      final PwfTaskDetail task = parsePwfTaskDetail(json)!;
      expect(task.evidence.single.attachedByName, 'Nguyễn Văn An');
      expect(task.evidence.single.documentTitle, 'Tờ trình chủ trương đầu tư');
      expect(task.evidence.single.documentSymbol, '12/TTr-BQL');
      expect(task.exceptions.single.requestedByName, 'Nguyễn Văn An');
      expect(task.exceptions.single.decidedByName, 'Trần Thị Bích');
      expect(task.history.single.actorName, 'Nguyễn Văn An');
      expect(task.forecastFinish, '2026-11-20');
      expect(task.people.map((PwfTaskPerson p) => '${p.role}:${p.name}'), <String>['RESPONSIBLE:Nguyễn Văn An', 'ACCOUNTABLE:Trần Thị Bích'], reason: 'an assignment that ended is not a person of the task now');
      // A row of a list carries the forecast too, and an answer from before these fields existed reads as before.
      expect(parsePwfTaskRow(<String, Object?>{...taskRow(kTaskId, 'Việc', status: 'IN_PROGRESS', official: band('RED', days: -2), finish: '2026-11-10', version: 1), 'forecast_finish': '2026-11-20'})!.forecastFinish, '2026-11-20');
      // The names of the codes a tenant made up itself (owner review of 14/11/2026): the role as its template names it, the type of a legal document as its edition names it.
      final Map<String, Object?> named = taskDetailJson(TaskState())
        ..['responsible_role'] = 'PROVINCE_CLERK'
        ..['responsible_role_name'] = 'Văn thư của tỉnh'
        ..['approver_role'] = 'PROVINCE_LEAD'
        ..['approver_role_name'] = null
        ..['legal_doc_types'] = <Object?>[<String, Object?>{'code': 'PROVINCE_NOTE', 'name': 'Tờ trình của tỉnh', 'satisfied': false}, <String, Object?>{'code': 'OTHER_NOTE', 'satisfied': true}];
      final PwfTaskDetail roles = parsePwfTaskDetail(named)!;
      expect(roles.responsibleRoleName, 'Văn thư của tỉnh');
      expect(roles.approverRoleName, isNull);
      expect(roles.legalDocTypes.map((PwfRequirement r) => r.name), <String?>['Tờ trình của tỉnh', null]);
      expect(parsePwfTaskDetail(taskDetailJson(TaskState()))!.forecastFinish, isNull);
      expect(parsePwfTaskDetail(taskDetailJson(TaskState()))!.people, isEmpty);
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

    test('a point names the project of its task, so two tasks of the same name are told apart; an answer without it reads as before', () {
      final Map<String, Object?> item = scoreItem();
      final Map<String, Object?> line = item['line']! as Map<String, Object?>;
      line['contributions'] = <Object?>[
        <String, Object?>{'task_code': 'T-11', 'task_id': null, 'name': 'Lập hồ sơ', 'project_code': 'DA-01', 'project_name': 'Đường tỉnh 207', 'fraction': 1, 'weight': 2, 'score': 90, 'spans': <Object?>[]},
        <String, Object?>{'task_code': 'T-11', 'task_id': null, 'name': 'Lập hồ sơ', 'project_code': 'DA-02', 'project_name': null, 'fraction': 1, 'weight': 2, 'score': 70, 'spans': <Object?>[]},
        <String, Object?>{'task_code': 'T-12', 'task_id': null, 'name': 'Thẩm định', 'fraction': 1, 'weight': 1, 'score': 70, 'spans': <Object?>[]},
      ];
      final PwfScoreLine read = parsePwfMyScores(scoresJson(items: <Map<String, Object?>>[item]))!.lines.single;
      expect(read.contributions.map((PwfScoreContribution c) => c.project), <String?>['Đường tỉnh 207', 'DA-02', null]);
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
