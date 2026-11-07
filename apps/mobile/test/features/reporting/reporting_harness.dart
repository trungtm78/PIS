import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/api/dart_io_transport.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/backoff.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:machvon_mobile/features/attachments/attachments_feature.dart' as attachments;
import 'package:machvon_mobile/features/offline/offline_feature.dart' as offline;
import 'package:machvon_mobile/features/read_support/clock.dart';
import 'package:machvon_mobile/features/read_support/read_support_feature.dart' as read_support;
import 'package:machvon_mobile/features/read_support/widgets.dart';
import 'package:machvon_mobile/features/reporting/data/report_drafts.dart';
import 'package:machvon_mobile/features/reporting/data/report_providers.dart';
import 'package:machvon_mobile/features/reporting/data/submit_flow.dart';
import 'package:machvon_mobile/features/reporting/model/report_cells.dart';
import 'package:machvon_mobile/features/reporting/model/report_form.dart';
import 'package:machvon_mobile/features/reporting/reporting_feature.dart' as reporting;

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../../support/queue_rig.dart';
import '../support/scripted_server.dart';
import 'reporting_fixtures.dart';

/// A report as the fake server holds it.
class ServerReport {
  ServerReport({required this.id, required this.form, required this.clientOperationId});

  final String id;
  final String clientOperationId;
  ReportForm form;
  int version = 1;
  int revision = 1;
  String status = 'DRAFT';
  String? submittedAt;

  /// How often the report was handed in: the server must hold exactly one.
  int submissions = 0;
}

/// The server of the weekly report as the phone sees it: the lists of periods and projects, the report (made, read, saved and handed
/// in through the sync endpoint exactly as `docs/mob-sync.md` says), and the capital plan. It keeps the reports, so a test can say
/// "the server holds one report, handed in once", and it can be cut off, locked, or made to answer another way.
class ReportingServer implements HttpTransport {
  ReportingServer() {
    sync = FakeSyncServer(decide: _decide);
    api
      ..on('GET', '/resources/reporting_period', (HttpCall call) => <String, Object?>{'items': periodRows(), 'next_cursor': null})
      ..on('GET', '/resources/project', (HttpCall call) => <String, Object?>{'items': projectRows(), 'next_cursor': null})
      ..answer('POST', '/reports', _create)
      ..answer('GET', '/reports/:id', _read)
      ..answer('POST', '/disbursement-schedules', _schedule);
  }

  late final FakeSyncServer sync;
  final ScriptedServer api = ScriptedServer();
  final Map<String, ServerReport> reports = <String, ServerReport>{};
  final List<Map<String, Object?>> schedules = <Map<String, Object?>>[];
  final List<HttpCall> calls = <HttpCall>[];

  /// The period is locked: a report cannot be made, a save or a submit is refused with `PERIOD_LOCKED`.
  bool periodLocked = false;

  /// The report that already stands for the project and the period (answered to a creation as `DRAFT_EXISTS`).
  ServerReport? existing;

  /// The next batch that carries a submit is carried out and then its answer is lost (the connection is cut after the work was done).
  bool dropSubmitAnswer = false;

  /// The next creation of a report is carried out and then its answer is lost.
  bool dropCreateAnswer = false;

  /// While set, the requests of the sync endpoint wait for it before they are answered: a command that is on its way.
  Future<void>? hold;

  /// The time the server gives a report it receives; the clock of the phone has nothing to do with it.
  String serverTime = '2026-11-03T03:20:00.000Z';

  /// The previous cumulative figures the server shows (`previous_cumulative_vnd`).
  Map<String, String>? previous;

  /// The review the server answers with for a draft.
  Map<String, Object?>? review;

  int _next = 1;

  set offline(bool value) {
    sync.offline = value;
    api.offline = value;
  }

  bool get offline => api.offline;

  /// How many reports were made: a draft made twice from the same phone is one.
  int get created => reports.length;

  ServerReport only() => reports.values.single;

  @override
  Future<HttpResult> send(HttpCall call) async {
    calls.add(call);
    if (!call.url.path.contains('/sync/')) {
      final HttpResult answer = await api.send(call);
      if (dropCreateAnswer && call.method == 'POST' && call.url.path.endsWith('/reports')) {
        dropCreateAnswer = false;
        throw const SocketException('connection reset after the server did the work');
      }
      return answer;
    }
    final Future<void>? waiting = hold;
    if (waiting != null) await waiting;
    final HttpResult answer = await sync.send(call);
    if (dropSubmitAnswer && call.method == 'POST' && (call.body ?? '').contains('report.submit')) {
      dropSubmitAnswer = false;
      throw const SocketException('connection reset after the server did the work');
    }
    return answer;
  }

  Map<String, Object?> _body(HttpCall call) => jsonDecode(call.body!) as Map<String, Object?>;

  HttpResult _problem(int status, String code, [Map<String, Object?> extra = const <String, Object?>{}]) => HttpResult(
        status: status,
        headers: const <String, String>{'content-type': 'application/problem+json'},
        body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': code, 'status': status, 'code': code, ...extra}),
      );

  HttpResult _create(HttpCall call) {
    final Map<String, Object?> body = _body(call);
    if (periodLocked) return _problem(409, 'PERIOD_LOCKED');
    final String operation = body['client_operation_id']! as String;
    for (final ServerReport report in reports.values) {
      if (report.clientOperationId == operation) return _result(report);
    }
    if (existing != null) return _problem(409, 'DRAFT_EXISTS', <String, Object?>{'report_id': existing!.id});
    final String id = '7a1f0000-0000-4000-8000-0000000001${(_next++).toString().padLeft(2, '0')}';
    final ServerReport report = ServerReport(id: id, clientOperationId: operation, form: ReportForm.fromFields(body));
    reports[id] = report;
    return _result(report);
  }

  HttpResult _result(ServerReport report) => FakeTransport.json(200, <String, Object?>{
        'operation_id': 'op-${report.id}',
        'status': report.status,
        'resource_version': report.version,
        'resource_id': report.id,
      });

  HttpResult _read(HttpCall call) {
    final ServerReport? report = reports[call.url.pathSegments.last] ?? (existing?.id == call.url.pathSegments.last ? existing : null);
    if (report == null) return _problem(404, 'RESOURCE_NOT_FOUND');
    return FakeTransport.json(
      200,
      serverReport(
        id: report.id,
        version: report.version,
        revision: report.revision,
        status: report.status,
        form: report.form,
        previous: previous,
        submittedAt: report.submittedAt,
        review: review,
        reportType: report.form.reportType,
      ),
    );
  }

  HttpResult _schedule(HttpCall call) {
    schedules.add(_body(call));
    return FakeTransport.json(200, <String, Object?>{'operation_id': 'op-schedule', 'status': 'REGISTERED', 'resource_version': 1, 'resource_id': 'schedule-${schedules.length}'});
  }

  ServerOutcome _decide(Map<String, Object?> item) {
    final Map<String, Object?> payload = item['payload']! as Map<String, Object?>;
    final ServerReport? report = reports[payload['report_id']];
    if (report == null) return const ServerOutcome.rejected('RESOURCE_NOT_FOUND');
    if (periodLocked) return const ServerOutcome.rejected('PERIOD_LOCKED');
    if (item['base_server_version'] != report.version) return ServerOutcome.conflict(version: report.version);
    switch (item['command_type']) {
      case 'report.draft.save':
        report.form = ReportForm.fromFields(payload);
        report.version += 1;
        return ServerOutcome.accepted(version: report.version, resultRef: report.id);
      case 'report.submit':
        report.status = 'SUBMITTED';
        report.submittedAt = serverTime;
        report.submissions += 1;
        report.version += 1;
        return ServerOutcome.accepted(version: report.version, resultRef: report.id);
    }
    return const ServerOutcome.rejected('VALIDATION_FAILED');
  }

  /// The commands the phone sent through `POST /sync/batches`, in order, by type.
  List<String> sentTypes() => <String>[
        for (final HttpCall batch in sync.batches)
          for (final Object? item in (jsonDecode(batch.body!) as Map<String, Object?>)['items']! as List<Object?>) (item! as Map<String, Object?>)['command_type']! as String,
      ];
}

/// The application on the weekly report, with the real encrypted store and queue and the fake server of [ReportingServer] as the
/// network. The store is opened before the application starts, so a test can leave drafts and commands in any state first.
class ReportingApp {
  ReportingApp._(this.storage, this.server);

  final TestStorage storage;
  final ReportingServer server;
  late ProviderContainer container;

  static ReportingApp create() => ReportingApp._(TestStorage.create(), ReportingServer());

  Future<LocalStore> get store async {
    final LocalStore opened = await storage.open();
    opened.deviceId = '11111111-1111-4111-8111-111111111111';
    return opened;
  }

  /// A client on the fake server, for the tests of the services.
  MachvonApiClient client({int keyStart = 1}) {
    int counter = keyStart;
    return MachvonApiClient(
      baseUrl: Uri.parse('https://api.test/v1'),
      transport: server,
      token: () async => 'test-token',
      newKey: () => 'a0000000-0000-4000-8000-${(counter++).toString().padLeft(12, '0')}',
      delay: (Duration _) async {},
    );
  }

  Future<ProviderContainer> open(
    WidgetTester tester, {
    String location = '/projects/mob-22',
    FakeSession? session,
    Locale locale = const Locale('vi'),
    List<Override> overrides = const <Override>[],
    DateTime? now,
  }) async {
    await store;
    container = await pumpApp(
      tester,
      features: <MobileFeature>[read_support.feature, attachments.feature, offline.feature, reporting.feature],
      session: session,
      locale: locale,
      location: location,
      overrides: <Override>[
        httpTransportProvider.overrideWith((Ref ref) => ObservingTransport(server, ref.read(reachabilityProvider.notifier).report)),
        offlineStorageProvider.overrideWithValue(storage.storage),
        clockProvider.overrideWithValue(() => now ?? DateTime.utc(2026, 11, 3, 3)),
        ...overrides,
      ],
    );
    return container;
  }

  Future<ReportDrafts> get drafts => container.read(reportDraftsProvider.future);

  /// Kills the application: the widget tree is gone and the store of the phone is closed, so the next start opens it again from
  /// its file, as after a process kill. What was on the screen is gone; what the phone wrote is all that is left.
  Future<void> kill(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    (await storage.open()).close();
  }
}

/// A draft with FX-DIS-001 in it, on the phone and (unless [onServer] is false) on the server, as it stands after the person has entered it all.
Future<DraftSnapshot> completeDraft(ReportingApp app, {bool onServer = true}) async {
  final ReportDrafts drafts = await app.drafts;
  DraftSnapshot current = drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
  if (onServer) current = await drafts.ensureRecord(current.id);
  return drafts.writeForm(current.id, completeForm().copyWith(planVersionId: current.form.planVersionId));
}

/// The services of the weekly report on a real encrypted store and queue, talking to [ReportingServer] through the real generated
/// client, with no screen. The clock and the keys are deterministic; [online] says whether the phone is known to be offline.
class FlowRig {
  FlowRig._(this.storage, this.store, this.server, this.queue, this.drafts, this.client, this.clock);

  final TestStorage storage;
  final LocalStore store;
  final ReportingServer server;
  final CommandQueue queue;
  final ReportDrafts drafts;
  final MachvonApiClient client;
  final FakeClock clock;
  bool online = true;
  late final SubmitFlow flow = SubmitFlow(drafts: drafts, queue: queue, isOnline: () => online);

  static Future<FlowRig> create({ReportingServer? server, TestStorage? storage}) async {
    final TestStorage test = storage ?? TestStorage.create();
    final LocalStore store = await test.open();
    store.deviceId = '11111111-1111-4111-8111-111111111111';
    final ReportingServer fake = server ?? ReportingServer();
    final FakeClock time = FakeClock();
    int counter = 1;
    final MachvonApiClient client = MachvonApiClient(
      baseUrl: Uri.parse('https://api.test/v1'),
      transport: fake,
      token: () async => 'test-token',
      newKey: () => 'a0000000-0000-4000-8000-${(counter++).toString().padLeft(12, '0')}',
      delay: (Duration _) async {},
    );
    final CommandQueue queue = CommandQueue(
      store: store,
      client: client,
      session: () => kSignedInA,
      deviceId: () async => store.deviceId,
      clock: time.call,
      newKey: () => 'b0000000-0000-4000-8000-${(counter++).toString().padLeft(12, '0')}',
      backoff: Backoff(),
    );
    final ReportDrafts drafts = ReportDrafts(store: store, client: client, now: () => DateTime.utc(2026, 11, 3, 3));
    return FlowRig._(test, store, fake, queue, drafts, client, time);
  }

  /// A draft with FX-DIS-001 in it, on the phone and (unless [onServer] is false) on the server.
  Future<DraftSnapshot> complete({bool onServer = true}) async {
    DraftSnapshot current = drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: 'YTD', reportType: kWeekly);
    if (onServer) current = await drafts.ensureRecord(current.id);
    return drafts.writeForm(current.id, completeForm().copyWith(planVersionId: current.form.planVersionId));
  }
}

/// A phone as tall as the longest screen, so that a list built lazily is built whole and a test can read all of it.
const Size kTallPhone = Size(390, 3600);

/// Types into the box with this label (the label of a box is its name for a screen reader too).
Future<void> typeInto(WidgetTester tester, String label, String text) async {
  final Finder box = find.widgetWithText(TextField, label);
  expect(box, findsOneWidget, reason: 'the box "$label"');
  await tester.ensureVisible(box);
  await tester.enterText(box, text);
  await tester.pump();
}

/// The text of a box, by its label.
String textOf(WidgetTester tester, String label) => tester.widget<TextField>(find.widgetWithText(TextField, label)).controller!.text;

/// Whether the box with this label can be typed into.
bool isEnabled(WidgetTester tester, String label) => tester.widget<TextField>(find.widgetWithText(TextField, label)).enabled ?? true;

/// Taps a button or a link by its words, after scrolling it into view.
Future<void> press(WidgetTester tester, String label) async {
  final Finder target = find.text(label).hitTestable().evaluate().isNotEmpty ? find.text(label).hitTestable().first : find.text(label).first;
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

/// The id of the one draft of the weekly report on the phone.
Future<String> onlyDraftId(ReportingApp app) async => (await app.drafts).all().single.id;

/// Replaces the opening of the drafts of the signed-in user, to try the screens when the store is slow, cannot be opened or has no
/// session behind it.
Override reportDraftsProviderOverride(Future<ReportDrafts> Function() build) => reportDraftsProvider.overrideWith((Ref ref) => build());

/// A draft on the phone: started with the context of the choice of the period, made on the server unless [onServer] is false, with the
/// form shaped by [shape].
Future<String> newDraft(ReportingApp app, {bool onServer = true, ReportForm Function(ReportForm form)? shape, String type = kWeekly}) async {
  final ReportDrafts drafts = await app.drafts;
  DraftSnapshot current = drafts.start(context: chosenOnly, projectId: projectId, periodId: periodId, basis: type == kMonthly ? 'PERIOD' : 'YTD', reportType: type);
  if (onServer) current = await drafts.ensureRecord(current.id);
  if (shape != null) drafts.writeForm(current.id, shape(current.form));
  return current.id;
}

/// A label and its value on a screen: a line of facts, or a figure of a [KpiTile] (the headline figures of a block).
Finder fact(String label, String value) =>
    find.byWidgetPredicate((Widget w) => (w is FactLine && w.label == label && w.value == value) || (w is KpiTile && w.label == label && w.value == value), description: '$label: $value');
