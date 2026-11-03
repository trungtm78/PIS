import '../../read_support/wire.dart';
import 'report_cells.dart';
import 'report_context.dart';
import 'report_form.dart';
import 'report_review.dart';

/// A report as the server shows it (`GET /reports/{id}`): what the phone needs to continue a draft or to show a report that was
/// handed in. The answer is refused as a whole, and the screen shows a contract mismatch, when it lacks what makes a figure
/// citable (the id, the version, the status, the project and the period).
final class ReportView {
  const ReportView({
    required this.id,
    required this.version,
    required this.revision,
    required this.status,
    required this.form,
    required this.context,
    this.submittedAt,
    this.isLate = false,
    this.review,
    this.cumulativeTotal = '0',
    this.ctmtqgTotal = '0',
  });

  final String id;
  final int version;
  final int revision;
  final String status;
  final ReportForm form;
  final ReportContext context;

  /// The time the server received the report, an ISO instant. The phone's clock is never used for it.
  final String? submittedAt;
  final bool isLate;

  /// The review of a draft; null for a report that was handed in.
  final ServerReview? review;
  final String cumulativeTotal;
  final String ctmtqgTotal;

  bool get isDraft => status == 'DRAFT';
}

/// Reads the answer of `GET /reports/{id}` taken at [fetchedAt].
ReportView? parseReportView(Object? raw, {required String fetchedAt}) {
  final Json? row = asRecord(raw);
  final Json? project = asRecord(row?['project']);
  final Json? period = asRecord(row?['period']);
  final Json? plan = asRecord(row?['plan_version']);
  final String? id = filled(row?['id']);
  final int? version = whole(row?['version']);
  final int? revision = whole(row?['revision']);
  final String? status = filled(row?['status']);
  final String? projectId = filled(project?['id']);
  final String? periodId = filled(period?['id']);
  if (row == null || id == null || version == null || revision == null || status == null || projectId == null || periodId == null) return null;
  final Json progress = asRecord(row['progress']) ?? const <String, Object?>{};
  final Json totals = asRecord(row['totals']) ?? const <String, Object?>{};
  final Map<String, CellReference> references = <String, CellReference>{};
  final List<Object?> lines = listOf(row['funding_lines']);
  for (final Object? raw in lines) {
    final Json? line = asRecord(raw);
    final String? bucket = text(line?['bucket']);
    final String? level = text(line?['budget_level']);
    final String? allocated = dong(line?['allocated_vnd']);
    if (line == null || bucket == null || level == null || allocated == null) continue;
    references.putIfAbsent(CellKey(bucket, level).id, () => CellReference(allocated: allocated, previous: dong(line['previous_cumulative_vnd'])));
  }
  final Map<String, Object?> fields = <String, Object?>{
    'project_id': projectId,
    'period_id': periodId,
    if (plan?['id'] case final String planId) 'plan_version_id': planId,
    'report_type': text(row['report_type']) ?? kWeekly,
    'measurement_basis': text(row['measurement_basis']) ?? 'YTD',
    'funding_lines': lines,
    for (final String key in const <String>['construction_vnd', 'acceptance_vnd', 'treasury_submitted_vnd', 'preparing_dossier_vnd', 'physical_progress_pct'])
      if (text(progress[key]) case final String value) key: value,
    if (text(row['negative_delta_explanation']) case final String explanation) 'negative_delta_explanation': explanation,
    'narrative': asRecord(row['narrative']) ?? const <String, Object?>{},
  };
  final ReportContext context = ReportContext(
    projectCode: text(project?['code']) ?? '',
    projectName: text(project?['name']) ?? '',
    periodCode: text(period?['code']) ?? '',
    periodType: text(period?['period_type']) ?? '',
    periodStart: day(period?['start_date']) ?? '',
    periodEnd: day(period?['end_date']) ?? '',
    fiscalYear: whole(period?['fiscal_year']) ?? 0,
    periodStatus: text(period?['status']),
    planFiscalYear: whole(plan?['fiscal_year']),
    planRevision: whole(plan?['revision']),
    cells: references,
    fetchedAt: fetchedAt,
  );
  return ReportView(
    id: id,
    version: version,
    revision: revision,
    status: status,
    form: ReportForm.fromFields(fields),
    context: context,
    submittedAt: text(row['submitted_at']),
    isLate: row['is_late'] == true,
    review: ServerReview.fromJson(row['review']),
    cumulativeTotal: dong(totals['cumulative_vnd']) ?? '0',
    ctmtqgTotal: dong(totals['ctmtqg_vnd']) ?? '0',
  );
}
