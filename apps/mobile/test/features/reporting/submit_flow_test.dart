import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/queue/queue_results.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/features/reporting/data/report_drafts.dart';
import 'package:machvon_mobile/features/reporting/data/submit_flow.dart';
import 'package:machvon_mobile/features/reporting/model/report_cells.dart';
import 'package:machvon_mobile/features/reporting/model/report_form.dart';

import 'reporting_fixtures.dart';
import 'reporting_harness.dart';

List<QueuedCommand> commandsOf(FlowRig rig, String type) => <QueuedCommand>[for (final QueuedCommand c in rig.queue.commands()) if (c.commandType == type) c];

/// The draft saved on the server and marked as such, ready to be submitted: the save command was carried out.
Future<DraftSnapshot> savedDraft(FlowRig rig) async {
  final DraftSnapshot written = await rig.complete();
  final QueuedCommand save = rig.queue.enqueue(
    commandType: kSaveCommand,
    payload: written.form.toPayload(written.reportId!),
    baseServerVersion: written.draft.baseServerVersion,
    draftId: written.id,
  );
  await rig.queue.flush();
  expect(rig.queue.command(save.id)!.state, CommandState.accepted);
  return rig.drafts.read(written.id)!;
}

void main() {
  group('AC-ST-MOB-012-1 UAT-AC502 the connection drops before the answer: result unknown, then accepted, and the server holds one report', () {
    test('the save and the submit are two commands in order; the answer of the submit is lost; the lookup finds it accepted; nothing is sent twice', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete();
      rig.server.dropSubmitAnswer = true;

      final SubmitResult result = await rig.flow.submit(draft.id);
      expect(result.outcome, SubmitOutcome.submitted);
      expect(rig.server.sentTypes(), <String>[kSaveCommand, kSubmitCommand]);
      final SubmitStatus unknown = rig.flow.statusOf(draft.id);
      expect(unknown.stage, SubmitStage.unknown, reason: 'MOB-41 says "Chưa xác định kết quả"');
      expect(unknown.isSubmit, isTrue);
      expect(rig.server.only().submissions, 1, reason: 'the server did the work whose answer was lost');
      expect(rig.server.only().status, 'SUBMITTED');
      expect(rig.store.drafts.byId(draft.id), isNotNull, reason: 'the draft stays until the server is known to have it');

      final FlushResult checked = await rig.flow.check();
      expect(checked.looked, 1);
      final SubmitStatus done = rig.flow.statusOf(draft.id);
      expect(done.stage, SubmitStage.submitted);
      expect(rig.server.only().submissions, 1);
      expect(commandsOf(rig, kSubmitCommand), hasLength(1), reason: 'no second command was made');
      expect(commandsOf(rig, kSaveCommand), hasLength(1));
      expect(rig.server.sync.batchPosts, 2, reason: 'the save and the submit; the lookup is a read');
      expect(rig.server.sync.effectsOf(unknown.command!.idempotencyKey), 1);
      expect(rig.store.drafts.byId(draft.id), isNull, reason: 'the draft is released once the server accepted the report');
      expect(rig.server.created, 1);
    });

    test('the submit carries the server\'s version of the last save as its base, and is released with the draft', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete();
      await rig.flow.submit(draft.id);
      final QueuedCommand save = commandsOf(rig, kSaveCommand).single;
      final QueuedCommand submit = commandsOf(rig, kSubmitCommand).single;
      expect(save.baseServerVersion, 1);
      expect(submit.baseServerVersion, 2, reason: 'the version the save produced');
      expect(submit.releaseDraft, isTrue);
      expect(save.releaseDraft, isFalse);
      expect(save.state, CommandState.accepted);
      expect(submit.state, CommandState.accepted);
      expect(submit.idempotencyKey, isNot(save.idempotencyKey));
      expect(rig.server.only().form.cell(kCells.first).cumulative, '100000000', reason: 'the server holds the figures of the draft');
      expect(rig.server.only().submittedAt, rig.server.serverTime);
      expect(rig.server.only().version, 3);
    });

    test('a phone known to be offline queues the command and sends nothing; it is sent when the network is back', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await savedDraft(rig);
      rig.online = false;
      rig.server.offline = true;

      final SubmitResult result = await rig.flow.submit(draft.id);
      expect(result.outcome, SubmitOutcome.submitted);
      expect(result.blocker, FlushBlocker.offline);
      expect(rig.flow.statusOf(draft.id).stage, SubmitStage.queued);
      expect(rig.server.sync.batchPosts, 1, reason: 'only the save went');
      expect(rig.server.only().submissions, 0);

      rig.online = true;
      rig.server.offline = false;
      rig.clock.advance(const Duration(minutes: 1));
      await rig.flow.check();
      expect(rig.flow.statusOf(draft.id).stage, SubmitStage.submitted);
      expect(rig.server.only().submissions, 1);
    });

    test('a draft the server does not hold yet is saved first; offline that save waits in the queue and the submit is not made', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete();
      rig.online = false;
      rig.server.offline = true;

      final SubmitResult result = await rig.flow.submit(draft.id);
      expect(result.outcome, SubmitOutcome.savePending);
      expect(commandsOf(rig, kSaveCommand).single.state, CommandState.queued);
      expect(commandsOf(rig, kSubmitCommand), isEmpty);
      expect(rig.flow.statusOf(draft.id).stage, SubmitStage.queued);
      expect(rig.flow.statusOf(draft.id).isSubmit, isFalse);

      rig.online = true;
      rig.server.offline = false;
      await rig.flow.check();
      expect(rig.store.drafts.byId(draft.id)!.status, DraftStatus.synced);
      final SubmitResult again = await rig.flow.submit(draft.id);
      expect(again.outcome, SubmitOutcome.submitted);
      expect(rig.flow.statusOf(draft.id).stage, SubmitStage.submitted);
      expect(commandsOf(rig, kSaveCommand), hasLength(1), reason: 'the draft was saved once');
      expect(rig.server.only().submissions, 1);
    });

    test('a save whose answer is lost is looked up, not made again, and the submit follows', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete();
      rig.server.sync.dropNextBatchAnswer = true;
      final SubmitResult first = await rig.flow.submit(draft.id);
      expect(first.outcome, SubmitOutcome.savePending);
      expect(rig.flow.statusOf(draft.id).stage, SubmitStage.unknown);
      await rig.flow.check();
      expect(commandsOf(rig, kSaveCommand).single.state, CommandState.accepted);
      final SubmitResult second = await rig.flow.submit(draft.id);
      expect(second.outcome, SubmitOutcome.submitted);
      expect(commandsOf(rig, kSaveCommand), hasLength(1));
      expect(rig.server.only().submissions, 1);
      expect(commandsOf(rig, kSubmitCommand).single.baseServerVersion, 2, reason: 'the version the lost save made, read from the server because the lookup does not give it');
    });

    test('when somebody else changed the report after the save whose answer was lost, nothing is submitted and the draft is kept', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete();
      rig.server.sync.dropNextBatchAnswer = true;
      await rig.flow.submit(draft.id);
      await rig.flow.check();
      rig.server.only().form = rig.server.only().form.copyWith(construction: '1');
      rig.server.only().version += 1;

      final SubmitResult result = await rig.flow.submit(draft.id);
      expect(result.outcome, SubmitOutcome.moved);
      expect(commandsOf(rig, kSubmitCommand), isEmpty);
      expect(rig.server.only().submissions, 0);
      expect(rig.drafts.read(draft.id)!.form.construction, '300000000');
    });

    test('when the server cannot be asked for the version of the lost save, the submit waits for the next try', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete();
      rig.server.sync.dropNextBatchAnswer = true;
      await rig.flow.submit(draft.id);
      await rig.flow.check();
      rig.server.api.offline = true;

      final SubmitResult result = await rig.flow.submit(draft.id);
      expect(result.outcome, SubmitOutcome.savePending);
      expect(commandsOf(rig, kSubmitCommand), isEmpty);
      rig.server.api.offline = false;
      expect((await rig.flow.submit(draft.id)).outcome, SubmitOutcome.submitted);
      expect(rig.server.only().submissions, 1);
    });
  });

  group('AC-ST-MOB-012-2 UAT-AC01 a tap that is repeated, or a restart, finds the command that exists', () {
    test('two taps at once make one pair of commands and one submission', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete();
      final List<SubmitResult> both = await Future.wait(<Future<SubmitResult>>[rig.flow.submit(draft.id), rig.flow.submit(draft.id)]);
      expect(both.map((SubmitResult r) => r.outcome), containsAll(<SubmitOutcome>[SubmitOutcome.submitted, SubmitOutcome.alreadyPending]));
      expect(commandsOf(rig, kSubmitCommand), hasLength(1));
      expect(commandsOf(rig, kSaveCommand), hasLength(1));
      expect(rig.server.only().submissions, 1);
    });

    test('two taps at once on a draft that is not on the server yet make the report once, one save and one submit', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete(onServer: false);
      final List<SubmitResult> both = await Future.wait(<Future<SubmitResult>>[rig.flow.submit(draft.id), rig.flow.submit(draft.id)]);
      expect(both.map((SubmitResult r) => r.outcome), containsAll(<SubmitOutcome>[SubmitOutcome.submitted, SubmitOutcome.alreadyPending]));
      expect(rig.server.created, 1);
      expect(commandsOf(rig, kSaveCommand), hasLength(1));
      expect(commandsOf(rig, kSubmitCommand), hasLength(1));
      expect(rig.server.only().submissions, 1);
    });

    test('a submit that is waiting or whose answer was lost is not made again after the app is started again', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete();
      rig.server.dropSubmitAnswer = true;
      await rig.flow.submit(draft.id);
      final String key = commandsOf(rig, kSubmitCommand).single.idempotencyKey;

      final SubmitFlow restarted = SubmitFlow(drafts: rig.drafts, queue: rig.queue, isOnline: () => true);
      expect((await restarted.submit(draft.id)).outcome, SubmitOutcome.alreadyPending);
      expect(commandsOf(rig, kSubmitCommand), hasLength(1));
      await restarted.check();
      expect(restarted.statusOf(draft.id).stage, SubmitStage.submitted);
      expect(commandsOf(rig, kSubmitCommand).single.idempotencyKey, key);
      expect(rig.server.only().submissions, 1);
      expect(rig.server.sync.effectsOf(key), 1);
    });

    test('the same key sent again with the same body gets the same answer from the server and is carried out once', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete();
      await rig.flow.submit(draft.id);
      final QueuedCommand submit = commandsOf(rig, kSubmitCommand).single;
      final HttpCall batch = rig.server.sync.batches.last;
      final HttpResult first = await rig.server.send(batch);
      final HttpResult second = await rig.server.send(batch);
      expect(second.body, first.body);
      expect(jsonDecode(first.body), containsPair('results', isNotEmpty));
      expect(rig.server.sync.effectsOf(submit.idempotencyKey), 1);
      expect(rig.server.only().submissions, 1);
    });
  });

  group('AC-ST-MOB-012-3 UAT-AC03 a closed period: PERIOD_LOCKED is told, and the draft is kept', () {
    test('the submit is refused with PERIOD_LOCKED, nothing was handed in, and the draft keeps every figure', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await savedDraft(rig);
      final ReportForm before = draft.form;
      rig.server.periodLocked = true;

      await rig.flow.submit(draft.id);
      final SubmitStatus status = rig.flow.statusOf(draft.id);
      expect(status.stage, SubmitStage.rejected);
      expect(status.code, 'PERIOD_LOCKED');
      expect(status.isSubmit, isTrue);
      expect(rig.server.only().submissions, 0);
      expect(rig.server.only().status, 'DRAFT');
      final LocalDraft kept = rig.store.drafts.byId(draft.id)!;
      expect(kept.status, DraftStatus.blocked);
      expect(kept.blockedCode, 'PERIOD_LOCKED');
      expect(ReportForm.fromFields(kept.fields), before, reason: 'nothing the person entered was lost');
    });

    test('after the period is reopened, Send again sends the same command once, under a new key', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await savedDraft(rig);
      rig.server.periodLocked = true;
      await rig.flow.submit(draft.id);
      final QueuedCommand refused = commandsOf(rig, kSubmitCommand).single;
      rig.server.periodLocked = false;

      await rig.flow.resend(refused.id);
      final QueuedCommand again = rig.queue.command(refused.id)!;
      expect(again.state, CommandState.accepted);
      expect(again.idempotencyKey, isNot(refused.idempotencyKey));
      expect(again.supersededKeys, contains(refused.idempotencyKey));
      expect(rig.server.only().submissions, 1);
      expect(commandsOf(rig, kSubmitCommand), hasLength(1));
      expect(rig.flow.statusOf(draft.id).stage, SubmitStage.submitted);
    });

    test('when the person changes the draft after a refusal, the refused command leaves the queue and the new entry replaces it', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await savedDraft(rig);
      rig.server.periodLocked = true;
      await rig.flow.submit(draft.id);
      rig.server.periodLocked = false;
      rig.drafts.writeForm(draft.id, rig.drafts.read(draft.id)!.form.copyWith(construction: '301000000'));

      await rig.flow.submit(draft.id);
      expect(rig.flow.statusOf(draft.id).stage, SubmitStage.submitted);
      expect(rig.queue.commands(states: <CommandState>{CommandState.rejected}), isEmpty);
      expect(rig.queue.commands(states: <CommandState>{CommandState.discarded}), hasLength(1));
      expect(rig.server.only().form.construction, '301000000');
      expect(rig.server.only().submissions, 1);
    });

    test('a save that the server refuses keeps the draft too, and the submit is not made', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete();
      rig.server.periodLocked = true;
      final SubmitResult result = await rig.flow.submit(draft.id);
      expect(result.outcome, SubmitOutcome.savePending);
      final SubmitStatus status = rig.flow.statusOf(draft.id);
      expect(status.stage, SubmitStage.rejected);
      expect(status.isSubmit, isFalse);
      expect(commandsOf(rig, kSubmitCommand), isEmpty);
      expect(rig.store.drafts.byId(draft.id)!.status, DraftStatus.blocked);
    });
  });

  group('AC-ST-MOB-012-4 the report is judged where the server is the authority', () {
    test('a report that moved on since the draft was based on it is a conflict the person decides; the draft is not overwritten and nothing is submitted', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete();
      rig.server.only().version = 5;
      await rig.flow.submit(draft.id);
      final SubmitStatus status = rig.flow.statusOf(draft.id);
      expect(status.stage, SubmitStage.conflict);
      expect(status.command!.serverVersion, 5);
      expect(rig.server.only().submissions, 0);
      expect(rig.server.only().form.isPristine, isTrue, reason: 'the figures of the other copy were not overwritten');
      expect(rig.store.drafts.byId(draft.id)!.status, DraftStatus.blocked);
    });

    test('the review stops the sending before anything is queued', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete();
      rig.drafts.writeForm(draft.id, rig.drafts.read(draft.id)!.form.copyWith(preparing: ''));
      final SubmitResult result = await rig.flow.submit(draft.id);
      expect(result.outcome, SubmitOutcome.blocked);
      expect(result.findings.map((f) => f.code), contains('VALIDATION_FAILED'));
      expect(rig.queue.commands(), isEmpty);
      expect(rig.server.sync.batchPosts, 0);
    });

    test('a draft that is not on the phone any more is told so', () async {
      final FlowRig rig = await FlowRig.create();
      expect((await rig.flow.submit('gone')).outcome, SubmitOutcome.missing);
    });
  });

  group('the report is made on the server when the submit needs it', () {
    test('a draft started with no network is made on the server at the submit, then saved and submitted', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete(onServer: false);
      expect(draft.reportId, isNull);
      final SubmitResult result = await rig.flow.submit(draft.id);
      expect(result.outcome, SubmitOutcome.submitted);
      expect(rig.server.created, 1);
      expect(rig.server.only().clientOperationId, draft.id);
      expect(rig.server.only().submissions, 1);
    });

    test('with no network the report cannot be made: the draft is kept as it is and the error is the network\'s', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = await rig.complete(onServer: false);
      rig.server.offline = true;
      await expectLater(rig.flow.submit(draft.id), throwsA(isA<ApiError>().having((ApiError e) => e.code, 'code', networkErrorCode)));
      expect(rig.queue.commands(), isEmpty);
      expect(rig.drafts.read(draft.id)!.form, draft.form);
      rig.server.offline = false;
      expect((await rig.flow.submit(draft.id)).outcome, SubmitOutcome.submitted);
      expect(rig.server.created, 1);
    });

    test('the project already has a draft on the server: the person is told, nothing is queued, and the draft is kept', () async {
      final FlowRig rig = await FlowRig.create();
      rig.server.existing = ServerReport(id: reportId, clientOperationId: 'someone-else', form: const ReportForm(projectId: projectId, periodId: periodId));
      final DraftSnapshot draft = await rig.complete(onServer: false);
      await expectLater(rig.flow.submit(draft.id), throwsA(isA<DraftExists>()));
      expect(rig.queue.commands(), isEmpty);
      expect(rig.drafts.read(draft.id)!.form, draft.form);
    });
  });

  group('the stage of the sending is read from the commands of the draft', () {
    QueuedCommand command(String type, CommandState state, {int at = 1, String draft = 'd1', String? error, String? result}) => QueuedCommand(
          id: '$type-$at-${state.name}',
          tenantId: 't',
          userId: 'u',
          commandType: type,
          payload: null,
          payloadBytes: 0,
          baseServerVersion: 1,
          idempotencyKey: 'k-$type-$at-${state.name}-0000',
          state: state,
          createdAt: at,
          updatedAt: at,
          draftId: draft,
          errorCode: error,
          resultRef: result,
        );

    test('no command, or only a save the server accepted, is idle: ready to submit', () {
      expect(submitStatusOf(const <QueuedCommand>[], 'd1').stage, SubmitStage.idle);
      expect(submitStatusOf(<QueuedCommand>[command(kSaveCommand, CommandState.accepted)], 'd1').stage, SubmitStage.idle);
      expect(const SubmitStatus(SubmitStage.idle).isPending, isFalse);
    });

    test('each state of the decisive command is a stage; the last submit decides over the saves', () {
      final Map<CommandState, SubmitStage> expected = <CommandState, SubmitStage>{
        CommandState.queued: SubmitStage.queued,
        CommandState.sending: SubmitStage.sending,
        CommandState.unknown: SubmitStage.unknown,
        CommandState.accepted: SubmitStage.submitted,
        CommandState.rejected: SubmitStage.rejected,
        CommandState.conflict: SubmitStage.conflict,
        CommandState.discarded: SubmitStage.idle,
      };
      for (final MapEntry<CommandState, SubmitStage> entry in expected.entries) {
        final SubmitStatus status = submitStatusOf(<QueuedCommand>[command(kSaveCommand, CommandState.accepted, at: 1), command(kSubmitCommand, entry.key, at: 2, result: 'r1')], 'd1');
        expect(status.stage, entry.value, reason: entry.key.name);
      }
      expect(submitStatusOf(<QueuedCommand>[command(kSubmitCommand, CommandState.accepted, result: 'r1')], 'd1').reportId, 'r1');
      expect(<SubmitStage>[for (final SubmitStage s in SubmitStage.values) if (s.isPending) s], <SubmitStage>[SubmitStage.queued, SubmitStage.sending, SubmitStage.unknown]);
    });

    test('a pending save is pending; the commands of other drafts and other types are not looked at', () {
      final List<QueuedCommand> commands = <QueuedCommand>[
        command(kSaveCommand, CommandState.queued, at: 3),
        command(kSubmitCommand, CommandState.accepted, at: 9, draft: 'd2'),
        command('issue.create', CommandState.rejected, at: 8),
      ];
      final SubmitStatus status = submitStatusOf(commands, 'd1');
      expect(status.stage, SubmitStage.queued);
      expect(status.isPending, isTrue);
      expect(status.isSubmit, isFalse);
      expect(status.code, isNull);
      expect(submitStatusOf(commands, 'd2').stage, SubmitStage.submitted);
    });

    test('a submit the person discarded leaves the draft ready to submit again, whatever was refused before it', () {
      final List<QueuedCommand> commands = <QueuedCommand>[
        command(kSaveCommand, CommandState.rejected, at: 1, error: 'PERIOD_LOCKED'),
        command(kSubmitCommand, CommandState.discarded, at: 2),
      ];
      expect(submitStatusOf(commands, 'd1').stage, SubmitStage.idle);
      expect(submitStatusOf(<QueuedCommand>[...commands, command(kSubmitCommand, CommandState.queued, at: 3)], 'd1').stage, SubmitStage.queued);
    });

    test('a refused command tells its code', () {
      final SubmitStatus status = submitStatusOf(<QueuedCommand>[command(kSubmitCommand, CommandState.rejected, error: 'PERIOD_LOCKED')], 'd1');
      expect(status.stage, SubmitStage.rejected);
      expect(status.code, 'PERIOD_LOCKED');
    });
  });
}
