import 'package:machvon_api_client/machvon_api_client.dart';

import '../../../core/api/answer.dart';
import '../../../core/offline/drafts/draft_store.dart';
import '../../../core/offline/drafts/local_draft.dart';
import '../../../core/offline/store/local_store.dart';
import '../../read_support/attempts.dart';
import '../../read_support/wire.dart';
import '../model/estimate_entry.dart';
import '../model/report_context.dart';
import '../model/report_form.dart';
import '../model/report_view.dart';

/// What a draft of the weekly report is called in the local store.
const String kReportKind = 'report';

/// What an estimate of the disbursement (MOB-56) is called in the local store; its `recordId` is the draft of the report it was started from.
const String kEstimateKind = 'estimate';

/// The key of the reference data inside the fields of a draft. It is not part of any command: the payload of a command is made
/// from the form alone.
const String kContextKey = '_ctx';

/// A draft with its form and its context read out of its fields.
final class DraftSnapshot {
  const DraftSnapshot({required this.draft, required this.form, required this.context});

  factory DraftSnapshot.of(LocalDraft draft) {
    final Json? context = asRecord(draft.fields[kContextKey]);
    return DraftSnapshot(draft: draft, form: ReportForm.fromFields(draft.fields), context: context == null ? null : ReportContext.fromJson(context));
  }

  final LocalDraft draft;
  final ReportForm form;
  final ReportContext? context;

  String get id => draft.id;

  /// The id of the report on the server; null while the draft exists on this phone only.
  String? get reportId => draft.recordId;

  /// A short form of the local UUID, the one the person can read out.
  String get shortId => draft.id.substring(0, 8);
}

/// The project already has a draft in this period on the server and the draft of this phone holds entries: the person decides
/// which one to keep, nothing is merged and nothing is overwritten.
final class DraftExists implements Exception {
  const DraftExists(this.reportId);

  final String reportId;

  @override
  String toString() => 'DraftExists($reportId)';
}

/// The drafts of the weekly report on this phone and what links them to the server (ST-MOB-011).
///
/// A draft is a local record with a UUID (MOB.md 3). It is written at every step, offline or not. The report on the server is
/// made once, while online, with the UUID as `client_operation_id`: the same draft sent again is the same report. Everything
/// after that goes to the server through the offline queue (see `SubmitFlow`), so this class never changes a figure of the server.
class ReportDrafts {
  ReportDrafts({required LocalStore store, required MachvonApiClient client, required DateTime Function() now, AttemptRegistry? attempts})
      : _local = store,
        _store = DraftStore(store),
        _client = client,
        _now = now,
        _attempts = attempts ?? AttemptRegistry();

  final LocalStore _local;
  final DraftStore _store;
  final MachvonApiClient _client;
  final DateTime Function() _now;
  final AttemptRegistry _attempts;

  DraftSnapshot? read(String id) {
    final LocalDraft? draft = _store.byId(id);
    return draft == null || draft.kind != kReportKind ? null : DraftSnapshot.of(draft);
  }

  DraftSnapshot _require(String id) => read(id) ?? (throw ArgumentError.value(id, 'id', 'is not a draft of the weekly report'));

  /// The reports being drafted on this phone, the last saved first.
  List<DraftSnapshot> all() => <DraftSnapshot>[for (final LocalDraft draft in _store.list(kind: kReportKind)) DraftSnapshot.of(draft)];

  /// The draft of a project and a period that is already on this phone, if there is one.
  DraftSnapshot? existingFor({required String projectId, required String periodId}) {
    for (final DraftSnapshot snapshot in all()) {
      if (snapshot.form.projectId == projectId && snapshot.form.periodId == periodId) return snapshot;
    }
    return null;
  }

  /// Starts a draft for a project and a period. It exists on this phone only, so it can be started with no network.
  DraftSnapshot start({required ReportContext context, required String projectId, required String periodId, required String basis, required String reportType}) {
    final ReportForm form = ReportForm(projectId: projectId, periodId: periodId, reportType: reportType, basis: basis);
    return _write(null, form, context, recordId: null, version: 0);
  }

  /// Writes the form of a draft, as typed. Nothing else of the draft changes.
  DraftSnapshot writeForm(String id, ReportForm form) {
    final DraftSnapshot current = _require(id);
    return _write(id, form, current.context, recordId: current.reportId, version: current.draft.baseServerVersion);
  }

  /// Makes the report on the server if it does not exist yet. Needs a network; a lost answer is retried with the same key. When
  /// the project already has a draft in the period, a draft with no entries takes it over and one with entries is [DraftExists].
  Future<DraftSnapshot> ensureRecord(String id) async {
    final DraftSnapshot current = _require(id);
    if (current.reportId != null) return current;
    final ReportDraft body = ReportDraft(
      projectId: current.form.projectId,
      periodId: current.form.periodId,
      measurementBasis: current.form.basis,
      reportType: current.form.reportType,
      fundingLines: const <FundingLine>[],
      clientOperationId: id,
    );
    final Object? answer;
    try {
      answer = await _client.postReports(body, attempt: _attempts.forPayload(id));
    } on ApiError catch (error) {
      _attempts.ended(error);
      final Object? existing = error.extensions['report_id'];
      if (error.code == 'DRAFT_EXISTS' && existing is String) {
        if (!current.form.isPristine) throw DraftExists(existing);
        final ReportView view = await fetch(existing);
        return _write(id, view.form, view.context, recordId: view.id, version: view.version);
      }
      rethrow;
    }
    _attempts.done();
    final CommandResultResponse made = decodeAnswer('post_reports', answer)! as CommandResultResponse;
    final String reportId = made.resourceId ?? (throw const ContractMismatch('post_reports.resource_id', 'is missing'));
    final ReportView view = await fetch(reportId);
    return _write(id, _withPlan(current.form, view), _withReference(current.context, view), recordId: reportId, version: view.version);
  }

  /// Reads the report from the server.
  Future<ReportView> fetch(String reportId) async {
    final Object? answer = await _client.getReportRevision(id: reportId);
    final ReportView? view = parseReportView(answer, fetchedAt: _now().toUtc().toIso8601String());
    if (view == null) throw const ContractMismatch('getReportRevision', 'does not hold what the screen needs');
    return view;
  }

  /// Takes the reference figures (the allocation, the period before, the plan) from the server into the draft. The figures the
  /// person entered, the version the draft is based on and its status stay as they are: a report that moved on is found by the
  /// save, which is refused with the versions, never by silently taking the newer one as the base.
  Future<DraftSnapshot> refreshReference(String id) async {
    final DraftSnapshot current = _require(id);
    final String target = current.reportId ?? (throw StateError('the draft has no report on the server'));
    final ReportView view = await fetch(target);
    final LocalDraft old = current.draft;
    final LocalDraft draft = LocalDraft(
      id: old.id,
      tenantId: old.tenantId,
      userId: old.userId,
      kind: old.kind,
      recordId: old.recordId,
      fields: <String, Object?>{...current.form.toFields(), kContextKey: _withReference(current.context, view).toJson()},
      baseServerVersion: old.baseServerVersion,
      status: old.status,
      blockedCode: old.blockedCode,
      createdAt: old.createdAt,
      updatedAt: old.updatedAt,
    );
    _local.drafts.upsert(draft);
    return DraftSnapshot.of(draft);
  }

  ReportContext _withReference(ReportContext? known, ReportView view) => known == null
      ? view.context
      : known.withReference(
          cells: view.context.cells,
          at: view.context.fetchedAt!,
          periodStatus: view.context.periodStatus,
          planFiscalYear: view.context.planFiscalYear,
          planRevision: view.context.planRevision,
        );

  ReportForm _withPlan(ReportForm form, ReportView view) => form.planVersionId == view.form.planVersionId ? form : form.copyWith(planVersionId: view.form.planVersionId);

  /// Records that the server holds this draft at [version]: the base of the next command, and the draft is the server's copy. Used
  /// when the answer to a save was lost and the server, asked for it, holds exactly what the phone sent.
  void markSynced(String id, int version) {
    final LocalDraft old = _require(id).draft;
    _local.drafts.upsert(
      LocalDraft(
        id: old.id,
        tenantId: old.tenantId,
        userId: old.userId,
        kind: old.kind,
        recordId: old.recordId,
        fields: old.fields,
        baseServerVersion: version,
        status: DraftStatus.synced,
        createdAt: old.createdAt,
        updatedAt: old.updatedAt,
      ),
    );
  }

  /// Opens the draft that the server holds as a draft of this phone: its figures, its plan and its version. A draft of this
  /// phone that already stands for that report is returned as it is.
  Future<DraftSnapshot> adoptServerDraft(String reportId) async {
    for (final DraftSnapshot snapshot in all()) {
      if (snapshot.reportId == reportId) return snapshot;
    }
    final ReportView view = await fetch(reportId);
    return _write(null, view.form, view.context, recordId: view.id, version: view.version);
  }

  /// The estimate being entered for a draft, or an empty one.
  EstimateEntry readEstimate(String draftId) {
    final LocalDraft? kept = _estimateOf(draftId);
    return kept == null ? const EstimateEntry() : EstimateEntry.fromJson(kept.fields);
  }

  /// Keeps the estimate being entered, so that it survives the app being closed; an empty one is not kept.
  void writeEstimate(String draftId, EstimateEntry entry) {
    final LocalDraft? kept = _estimateOf(draftId);
    if (entry.isEmpty) {
      if (kept != null) _store.delete(kept.id);
      return;
    }
    _store.save(id: kept?.id, kind: kEstimateKind, fields: entry.toJson(), recordId: draftId);
  }

  LocalDraft? _estimateOf(String draftId) => _store.list(kind: kEstimateKind).where((LocalDraft draft) => draft.recordId == draftId).firstOrNull;

  /// Drops a draft of this phone. The report on the server, if there is one, is not touched.
  void discard(String id) {
    writeEstimate(id, const EstimateEntry());
    _store.delete(id);
  }

  DraftSnapshot _write(String? id, ReportForm form, ReportContext? context, {required String? recordId, required int version}) {
    final LocalDraft draft = _store.save(
      id: id,
      kind: kReportKind,
      fields: <String, Object?>{...form.toFields(), if (context != null) kContextKey: context.toJson()},
      recordId: recordId,
      baseServerVersion: version,
    );
    return DraftSnapshot.of(draft);
  }
}
