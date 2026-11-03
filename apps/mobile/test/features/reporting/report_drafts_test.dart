import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/drafts/draft_store.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/features/reporting/data/report_drafts.dart';
import 'package:machvon_mobile/features/reporting/model/estimate_entry.dart';
import 'package:machvon_mobile/features/reporting/model/report_cells.dart';
import 'package:machvon_mobile/features/reporting/model/report_form.dart';

import '../../support/offline_support.dart';
import 'reporting_fixtures.dart';
import 'reporting_harness.dart';

final RegExp _uuid = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

String? keyOf(Iterable<dynamic> calls, int index) => (calls.elementAt(index) as HttpCall).headers['idempotency-key'];

/// A server whose reads of a report are answered only when the test lets them: a slow connection, with the person typing meanwhile.
class SlowReads extends ReportingServer {
  Completer<void>? gate;

  /// Lets the reads that wait go on.
  void open() => gate!.complete();

  @override
  Future<HttpResult> send(HttpCall call) async {
    final Completer<void>? waiting = gate;
    if (waiting != null && call.method == 'GET' && call.url.path.contains('/reports/')) {
      held++;
      await waiting.future;
    }
    return super.send(call);
  }

  /// How many reads of the report are waiting for the gate.
  int held = 0;
}

Future<void> until(bool Function() condition) async {
  for (int i = 0; i < 200 && !condition(); i++) {
    await Future<void>.delayed(Duration.zero);
  }
  expect(condition(), isTrue, reason: 'the request never started');
}

void main() {
  group('AC-ST-MOB-011-1 UI-MOB-15 a draft is a record of the phone with a UUID, and what was written is still there after a kill', () {
    test('a draft started with no network has a UUID, the project and the period, and no report on the server', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot draft = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      expect(draft.id, matches(_uuid));
      expect(draft.reportId, isNull);
      expect(draft.draft.kind, kReportKind);
      expect(draft.draft.status, DraftStatus.editing);
      expect(draft.context!.projectCode, 'DA-2026-002');
      expect(draft.form.isPristine, isTrue);
      expect(rig.server.calls, isEmpty, reason: 'nothing needs the network to start a draft');
    });

    test('the figures written at the last step are the same after the store is closed and opened again from its file', () async {
      final TestStorage storage = TestStorage.create();
      FlowRig rig = await FlowRig.create(storage: storage);
      final DraftSnapshot written = await rig.complete(onServer: false);
      final ReportForm typed = written.form.withCell(kCells.first, const CellEntry(cumulative: '1.250.000', ctmtqg: '40.000', nextMonth: '5'));
      rig.drafts.writeForm(written.id, typed);
      rig.store.close();

      rig = await FlowRig.create(storage: storage);
      final DraftSnapshot restored = rig.drafts.read(written.id)!;
      expect(restored.id, written.id, reason: 'the same local UUID');
      expect(restored.form, typed);
      expect(restored.form.cell(kCells.first).cumulative, '1.250.000', reason: 'as it was typed');
      expect(restored.context!.periodCode, 'W2026-45');
    });

    test('a draft of another kind or another tenant is not a draft of the weekly report', () async {
      final FlowRig rig = await FlowRig.create();
      final LocalDraft other = DraftStore(rig.store).save(kind: 'issue', fields: <String, Object?>{'a': 1});
      expect(rig.drafts.read(other.id), isNull);
      expect(rig.drafts.all(), isEmpty);
      expect(() => rig.drafts.writeForm(other.id, const ReportForm(projectId: projectId, periodId: periodId)), throwsArgumentError);
      expect(() => rig.drafts.writeForm('nope', const ReportForm(projectId: projectId, periodId: periodId)), throwsArgumentError);
    });

    test('the drafts come last saved first and the draft of a project and a period is found', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot a = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      final DraftSnapshot b = rig.drafts.start(context: chosenOnly, projectId: 'other', periodId: periodId, basis: 'YTD', reportType: kWeekly);
      rig.drafts.writeForm(a.id, a.form.copyWith(construction: '1'));
      expect(rig.drafts.all().map((DraftSnapshot s) => s.id), <String>[a.id, b.id]);
      expect(rig.drafts.existingFor(projectId: projectId, periodId: periodId)!.id, a.id);
      expect(rig.drafts.existingFor(projectId: 'none', periodId: periodId), isNull);
    });
  });

  group('AC-ST-MOB-011-1 the report is made on the server once, from the UUID of the draft', () {
    test('the creation carries the UUID as client_operation_id and an idempotency key; the draft takes the id, the version, the plan and the allocation', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot started = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      final DraftSnapshot made = await rig.drafts.ensureRecord(started.id);
      expect(made.reportId, rig.server.only().id);
      expect(made.draft.baseServerVersion, 1);
      expect(made.form.planVersionId, planId);
      expect(made.context!.hasReference, isTrue);
      expect(made.context!.allocatedTotal, '1000000000');
      expect(made.context!.fetchedAt, '2026-11-03T03:00:00.000Z');
      final HttpCall post = rig.server.calls.firstWhere((HttpCall c) => c.method == 'POST');
      final Map<String, Object?> body = jsonDecode(post.body!) as Map<String, Object?>;
      expect(body['client_operation_id'], started.id);
      expect(body['project_id'], projectId);
      expect(body['funding_lines'], isEmpty);
      expect(post.headers['idempotency-key'], isNotEmpty);
    });

    test('a draft that has its report is not made again', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot first = await rig.complete();
      final int calls = rig.server.calls.length;
      final DraftSnapshot again = await rig.drafts.ensureRecord(first.id);
      expect(again.reportId, first.reportId);
      expect(rig.server.calls.length, calls);
      expect(rig.server.created, 1);
    });

    test('a lost answer is retried with the same key and gives the same report, never a second', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot started = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      rig.server.dropCreateAnswer = true;
      await expectLater(rig.drafts.ensureRecord(started.id), throwsA(isA<ApiError>().having((ApiError e) => e.code, 'code', networkErrorCode)));
      expect(rig.drafts.read(started.id)!.reportId, isNull);
      expect(rig.server.created, 1, reason: 'the server did the work');

      final DraftSnapshot made = await rig.drafts.ensureRecord(started.id);
      expect(made.reportId, rig.server.only().id);
      expect(rig.server.created, 1);
      final List<HttpCall> posts = rig.server.calls.where((HttpCall c) => c.method == 'POST').toList();
      expect(posts, hasLength(2));
      expect(keyOf(posts, 1), keyOf(posts, 0), reason: 'the retry keeps the key of the first request');
    });

    test('a restart in the middle gives a new key but the same client_operation_id, so the server still holds one report', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot started = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      rig.server.dropCreateAnswer = true;
      await expectLater(rig.drafts.ensureRecord(started.id), throwsA(isA<ApiError>()));
      final ReportDrafts restarted = ReportDrafts(store: rig.store, client: rig.client, now: () => DateTime.utc(2026, 11, 3, 3));
      final DraftSnapshot made = await restarted.ensureRecord(started.id);
      expect(made.reportId, rig.server.only().id);
      expect(rig.server.created, 1);
    });

    test('a refusal of the server is final: nothing is kept for it, and the same request after the cause is removed is a new command', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot started = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      rig.server.periodLocked = true;
      await expectLater(rig.drafts.ensureRecord(started.id), throwsA(isA<ApiError>().having((ApiError e) => e.code, 'code', 'PERIOD_LOCKED')));
      rig.server.periodLocked = false;
      await rig.drafts.ensureRecord(started.id);
      final List<HttpCall> posts = rig.server.calls.where((HttpCall c) => c.method == 'POST').toList();
      expect(keyOf(posts, 1), isNot(keyOf(posts, 0)));
      expect(rig.server.created, 1);
    });

    test('the project already has a draft: a draft with no entries takes it over, a draft with entries is refused and kept as it is', () async {
      final FlowRig rig = await FlowRig.create();
      final ServerReport theirs = ServerReport(id: reportId, clientOperationId: 'someone-else', form: completeForm().copyWith(planVersionId: planId))..version = 4;
      rig.server.existing = theirs;

      final DraftSnapshot pristine = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      final DraftSnapshot adopted = await rig.drafts.ensureRecord(pristine.id);
      expect(adopted.id, pristine.id);
      expect(adopted.reportId, reportId);
      expect(adopted.draft.baseServerVersion, 4);
      expect(adopted.form.cell(kCells.first).cumulative, '100000000', reason: 'the figures are the ones the server holds');

      final DraftSnapshot mine = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      final ReportForm entered = mine.form.copyWith(construction: '5');
      rig.drafts.writeForm(mine.id, entered);
      await expectLater(rig.drafts.ensureRecord(mine.id), throwsA(isA<DraftExists>().having((DraftExists e) => e.reportId, 'reportId', reportId)));
      expect(rig.drafts.read(mine.id)!.form, entered, reason: 'nothing of mine was overwritten');
      expect(rig.drafts.read(mine.id)!.reportId, isNull);
      expect(const DraftExists('x').toString(), contains('x'));
    });

    test('what the person types while the report is being made is kept in the draft that takes the report', () async {
      final SlowReads server = SlowReads();
      final FlowRig rig = await FlowRig.create(server: server);
      final DraftSnapshot started = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      server.gate = Completer<void>();

      final Future<DraftSnapshot> making = rig.drafts.ensureRecord(started.id);
      await until(() => server.held > 0);
      final ReportForm typed = started.form.copyWith(construction: '5');
      rig.drafts.writeForm(started.id, typed);
      server.open();
      final DraftSnapshot made = await making;

      expect(made.reportId, server.only().id);
      expect(made.form.construction, '5', reason: 'typed while the report was read');
      expect(made.form.planVersionId, planId, reason: 'the plan of the server is taken beside it');
      expect(rig.drafts.read(started.id)!.form.construction, '5');
      expect(rig.drafts.read(started.id)!.context!.hasReference, isTrue);
      expect(rig.drafts.read(started.id)!.draft.baseServerVersion, 1);
    });

    test('the draft that took over the report of the server is not overwritten by it when the person typed meanwhile: they decide', () async {
      final SlowReads server = SlowReads();
      final FlowRig rig = await FlowRig.create(server: server);
      server.existing = ServerReport(id: reportId, clientOperationId: 'someone-else', form: completeForm().copyWith(planVersionId: planId))..version = 4;
      final DraftSnapshot started = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      server.gate = Completer<void>();

      final Future<DraftSnapshot> making = rig.drafts.ensureRecord(started.id);
      await until(() => server.held > 0);
      final ReportForm typed = started.form.copyWith(construction: '5');
      rig.drafts.writeForm(started.id, typed);
      server.open();

      await expectLater(making, throwsA(isA<DraftExists>().having((DraftExists e) => e.reportId, 'reportId', reportId)));
      expect(rig.drafts.read(started.id)!.form, typed);
      expect(rig.drafts.read(started.id)!.reportId, isNull);
    });

    test('another refusal is passed on as it is', () async {
      final FlowRig rig = await FlowRig.create();
      rig.server.api.refuse('POST', '/reports', 422, 'PLAN_VERSION_NOT_EFFECTIVE');
      final DraftSnapshot started = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      await expectLater(rig.drafts.ensureRecord(started.id), throwsA(isA<ApiError>().having((ApiError e) => e.code, 'code', 'PLAN_VERSION_NOT_EFFECTIVE')));
    });

    test('an answer of the server that names no report is a mismatch with the contract', () async {
      final FlowRig rig = await FlowRig.create();
      rig.server.api.on('POST', '/reports', (HttpCall call) => <String, Object?>{'operation_id': 'x', 'status': 'DRAFT', 'resource_version': 1});
      final DraftSnapshot started = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      await expectLater(rig.drafts.ensureRecord(started.id), throwsA(isA<ContractMismatch>()));
    });

    test('a report the server shows without its project is refused whole', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot written = await rig.complete();
      rig.server.api.on('GET', '/reports/:id', (HttpCall call) => <String, Object?>{'id': written.reportId});
      await expectLater(rig.drafts.refreshReference(written.id), throwsA(isA<ContractMismatch>()));
    });
  });

  group('TK-MOB-011-1 the reference figures are read into a draft without changing what the person wrote', () {
    test('the allocation and the period before arrive; the figures, the status and the version of the draft stay', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot written = await rig.complete();
      final LocalDraft before = rig.store.drafts.byId(written.id)!;
      rig.store.drafts.upsert(LocalDraft(
        id: before.id,
        tenantId: before.tenantId,
        userId: before.userId,
        kind: before.kind,
        recordId: before.recordId,
        fields: before.fields,
        baseServerVersion: before.baseServerVersion,
        status: DraftStatus.synced,
        createdAt: before.createdAt,
        updatedAt: 1234,
      ));
      rig.server.only().version = 9;
      rig.server.previous = <String, String>{'CURRENT_YEAR:CENTRAL': '90000000'};

      final DraftSnapshot refreshed = await rig.drafts.refreshReference(written.id);
      expect(refreshed.context!.reference(kCells.first)!.previous, '90000000');
      expect(refreshed.form, written.form);
      expect(refreshed.draft.status, DraftStatus.synced, reason: 'the reference figures are not a change of the draft');
      expect(refreshed.draft.updatedAt, 1234);
      expect(refreshed.draft.baseServerVersion, before.baseServerVersion, reason: 'a report that moved on is found by the save, never taken as the base');
      expect(refreshed.draft.recordId, written.reportId);
    });

    test('a draft whose context was lost, as a retry of the queue rewrites its fields, takes it from the server again', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot written = await rig.complete();
      final LocalDraft before = rig.store.drafts.byId(written.id)!;
      rig.store.drafts.upsert(LocalDraft(
        id: before.id,
        tenantId: before.tenantId,
        userId: before.userId,
        kind: before.kind,
        recordId: before.recordId,
        fields: written.form.toPayload(written.reportId!),
        baseServerVersion: before.baseServerVersion,
        status: DraftStatus.queued,
        createdAt: before.createdAt,
        updatedAt: before.updatedAt,
      ));
      expect(rig.drafts.read(written.id)!.context, isNull);
      final DraftSnapshot restored = await rig.drafts.refreshReference(written.id);
      expect(restored.context!.projectCode, 'DA-2026-002');
      expect(restored.context!.hasReference, isTrue);
      expect(restored.form.toPayload(written.reportId!), written.form.toPayload(written.reportId!));
      expect(restored.draft.status, DraftStatus.queued);
    });

    test('what the person types while the reference figures are on their way is kept, and the reference figures are taken beside it', () async {
      final SlowReads server = SlowReads();
      final FlowRig rig = await FlowRig.create(server: server);
      final DraftSnapshot written = await rig.complete();
      server.previous = <String, String>{'CURRENT_YEAR:CENTRAL': '90000000'};
      server.gate = Completer<void>();

      final Future<DraftSnapshot> refreshing = rig.drafts.refreshReference(written.id);
      await until(() => server.held > 0);
      final ReportForm typed = written.form.copyWith(construction: '777.000.000', percent: '41,5');
      rig.drafts.writeForm(written.id, typed);
      server.open();
      final DraftSnapshot refreshed = await refreshing;

      expect(refreshed.form, typed, reason: 'the answer of the server is not a reason to lose what was typed meanwhile');
      expect(rig.drafts.read(written.id)!.form, typed);
      expect(rig.drafts.read(written.id)!.context!.reference(kCells.first)!.previous, '90000000');
      expect(rig.drafts.read(written.id)!.draft.status, DraftStatus.editing);
    });

    test('a draft dropped while the reference figures are on their way is not brought back by them', () async {
      final SlowReads server = SlowReads();
      final FlowRig rig = await FlowRig.create(server: server);
      final DraftSnapshot written = await rig.complete();
      server.gate = Completer<void>();

      final Future<DraftSnapshot> refreshing = rig.drafts.refreshReference(written.id);
      await until(() => server.held > 0);
      rig.drafts.discard(written.id);
      server.open();
      await expectLater(refreshing, throwsA(isA<DraftDropped>().having((DraftDropped e) => e.id, 'id', written.id)));
      expect(rig.drafts.read(written.id), isNull);
      expect(rig.drafts.all(), isEmpty);
      expect(const DraftDropped('x').toString(), contains('x'));
    });

    test('a draft dropped while its report is being made is not brought back by the answer', () async {
      final SlowReads server = SlowReads();
      final FlowRig rig = await FlowRig.create(server: server);
      final DraftSnapshot started = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      server.gate = Completer<void>();

      final Future<DraftSnapshot> making = rig.drafts.ensureRecord(started.id);
      await until(() => server.held > 0);
      rig.drafts.discard(started.id);
      server.open();
      await expectLater(making, throwsA(isA<DraftDropped>()));
      expect(rig.drafts.all(), isEmpty);
    });

    test('a draft with no report on the server cannot be refreshed', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot local = rig.drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
      await expectLater(rig.drafts.refreshReference(local.id), throwsStateError);
    });

    test('the draft of the server is opened as a draft of the phone once', () async {
      final FlowRig rig = await FlowRig.create();
      rig.server.existing = ServerReport(id: reportId, clientOperationId: 'x', form: completeForm().copyWith(planVersionId: planId))..version = 6;
      final DraftSnapshot first = await rig.drafts.adoptServerDraft(reportId);
      expect(first.reportId, reportId);
      expect(first.draft.baseServerVersion, 6);
      expect(first.form.construction, '300000000');
      final int calls = rig.server.calls.length;
      final DraftSnapshot second = await rig.drafts.adoptServerDraft(reportId);
      expect(second.id, first.id);
      expect(rig.server.calls.length, calls, reason: 'no second copy, and nothing asked again');
      expect(rig.drafts.all(), hasLength(1));
    });
  });

  group('MOB-22 discard and MOB-56 the estimate being entered', () {
    test('a discarded draft is gone from the phone and the report on the server is not touched', () async {
      final FlowRig rig = await FlowRig.create();
      final DraftSnapshot written = await rig.complete();
      rig.drafts.writeEstimate(written.id, const EstimateEntry(month: '11', amount: '5'));
      final int calls = rig.server.calls.length;
      rig.drafts.discard(written.id);
      expect(rig.drafts.read(written.id), isNull);
      expect(rig.drafts.readEstimate(written.id).isEmpty, isTrue, reason: 'the estimate of a dropped draft goes with it');
      expect(rig.store.drafts.all(), isEmpty);
      expect(rig.server.calls.length, calls);
      expect(rig.server.only().status, 'DRAFT');
    });

    test('an estimate is kept per draft, survives the store being reopened, and an empty one is not kept', () async {
      final TestStorage storage = TestStorage.create();
      FlowRig rig = await FlowRig.create(storage: storage);
      final DraftSnapshot a = await rig.complete(onServer: false);
      const EstimateEntry entry = EstimateEntry(month: '11', source: 'OTHER:LOCAL', amount: '1.000', assumption: 'Nghiệm thu', reason: '');
      rig.drafts.writeEstimate(a.id, entry);
      rig.drafts.writeEstimate(a.id, entry.copyWith(amount: '2.000'));
      expect(rig.store.drafts.all().where((LocalDraft d) => d.kind == kEstimateKind), hasLength(1), reason: 'one per draft, rewritten');
      rig.store.close();

      rig = await FlowRig.create(storage: storage);
      expect(rig.drafts.readEstimate(a.id).amount, '2.000');
      expect(rig.drafts.readEstimate('other').isEmpty, isTrue);
      rig.drafts.writeEstimate(a.id, const EstimateEntry());
      expect(rig.store.drafts.all().where((LocalDraft d) => d.kind == kEstimateKind), isEmpty);
      rig.drafts.writeEstimate('another', const EstimateEntry());
      expect(rig.store.drafts.all().where((LocalDraft d) => d.kind == kEstimateKind), isEmpty);
    });
  });
}
