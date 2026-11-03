import '../../read_support/wire.dart';
import 'report_cells.dart';

/// What a person typed in the four boxes of one cell. The texts are kept as they were typed (`1.250.000.000`), so a draft
/// restores exactly what was on the screen; they become whole dong only when a command is made.
final class CellEntry {
  const CellEntry({this.cumulative = '0', this.ctmtqg = '', this.nextMonth = '0', this.nextCtmtqg = ''});

  /// The cumulative disbursement of the cell. A new cell reads zero, as on the web: the person writes 0 when nothing was paid.
  final String cumulative;

  /// The part of the cumulative that belongs to the national target programmes; empty when there is none.
  final String ctmtqg;

  /// The registration for next month and the part of it that belongs to the programmes.
  final String nextMonth;
  final String nextCtmtqg;

  CellEntry copyWith({String? cumulative, String? ctmtqg, String? nextMonth, String? nextCtmtqg}) => CellEntry(
        cumulative: cumulative ?? this.cumulative,
        ctmtqg: ctmtqg ?? this.ctmtqg,
        nextMonth: nextMonth ?? this.nextMonth,
        nextCtmtqg: nextCtmtqg ?? this.nextCtmtqg,
      );
}

const int kExplanationMin = 10;
const int kExplanationMax = 2000;
const int kNoteMax = 4000;

/// The report as the person is entering it: the same fields as the `ReportDraft` of the contract that the web fills, held as
/// typed. The server judges again on every save; the rules here only tell the person early (TK-MOB-011-4).
final class ReportForm {
  const ReportForm({
    required this.projectId,
    required this.periodId,
    this.planVersionId,
    this.reportType = kWeekly,
    this.basis = 'YTD',
    this.cells = const <String, CellEntry>{},
    this.construction = '',
    this.acceptance = '',
    this.treasury = '',
    this.preparing = '',
    this.percent = '',
    this.explanation = '',
    this.results = '',
    this.causes = '',
    this.solutions = '',
    this.proposals = '',
    this.linkedIssueIds = const <String>[],
  });

  /// Reads the fields of a draft (see [toFields]) or of the payload of a command made from it: both have the same names.
  factory ReportForm.fromFields(Map<String, Object?> fields) {
    final Json narrative = asRecord(fields['narrative']) ?? const <String, Object?>{};
    final Map<String, CellEntry> cells = <String, CellEntry>{};
    for (final Object? raw in listOf(fields['funding_lines'])) {
      final Json? line = asRecord(raw);
      final String? bucket = text(line?['bucket']);
      final String? level = text(line?['budget_level']);
      if (line == null || bucket == null || level == null) continue;
      cells[CellKey(bucket, level).id] = CellEntry(
        cumulative: text(line['cumulative_vnd']) ?? '0',
        ctmtqg: text(line['ctmtqg_subset_vnd']) ?? '',
        nextMonth: text(line['next_month_vnd']) ?? '0',
        nextCtmtqg: text(line['next_month_ctmtqg_subset_vnd']) ?? '',
      );
    }
    return ReportForm(
      projectId: text(fields['project_id']) ?? '',
      periodId: text(fields['period_id']) ?? '',
      planVersionId: text(fields['plan_version_id']),
      reportType: text(fields['report_type']) ?? kWeekly,
      basis: text(fields['measurement_basis']) ?? 'YTD',
      cells: cells,
      construction: text(fields['construction_vnd']) ?? '',
      acceptance: text(fields['acceptance_vnd']) ?? '',
      treasury: text(fields['treasury_submitted_vnd']) ?? '',
      preparing: text(fields['preparing_dossier_vnd']) ?? '',
      percent: text(fields['physical_progress_pct']) ?? '',
      explanation: text(fields['negative_delta_explanation']) ?? '',
      results: text(narrative['results']) ?? '',
      causes: text(narrative['causes']) ?? '',
      solutions: text(narrative['solutions']) ?? '',
      proposals: text(narrative['proposals']) ?? '',
      linkedIssueIds: <String>[for (final Object? id in listOf(narrative['linked_issue_ids'])) if (id is String) id],
    );
  }

  final String projectId;
  final String periodId;
  final String? planVersionId;
  final String reportType;
  final String basis;
  final Map<String, CellEntry> cells;
  final String construction;
  final String acceptance;
  final String treasury;
  final String preparing;
  final String percent;
  final String explanation;
  final String results;
  final String causes;
  final String solutions;
  final String proposals;

  /// The issues the notes speak about, kept as the server named them so that a save does not drop them.
  final List<String> linkedIssueIds;

  bool get isMonthly => reportType == kMonthly;

  CellEntry cell(CellKey key) => cells[key.id] ?? const CellEntry();

  ReportForm withCell(CellKey key, CellEntry entry) => copyWith(cells: <String, CellEntry>{...cells, key.id: entry});

  /// Whether nothing was entered yet: a new draft, or one the server just made.
  bool get isPristine => this == ReportForm(projectId: projectId, periodId: periodId, planVersionId: planVersionId, reportType: reportType, basis: basis);

  ReportForm copyWith({
    String? planVersionId,
    String? basis,
    Map<String, CellEntry>? cells,
    String? construction,
    String? acceptance,
    String? treasury,
    String? preparing,
    String? percent,
    String? explanation,
    String? results,
    String? causes,
    String? solutions,
    String? proposals,
    List<String>? linkedIssueIds,
  }) =>
      ReportForm(
        projectId: projectId,
        periodId: periodId,
        planVersionId: planVersionId ?? this.planVersionId,
        reportType: reportType,
        basis: basis ?? this.basis,
        cells: cells ?? this.cells,
        construction: construction ?? this.construction,
        acceptance: acceptance ?? this.acceptance,
        treasury: treasury ?? this.treasury,
        preparing: preparing ?? this.preparing,
        percent: percent ?? this.percent,
        explanation: explanation ?? this.explanation,
        results: results ?? this.results,
        causes: causes ?? this.causes,
        solutions: solutions ?? this.solutions,
        proposals: proposals ?? this.proposals,
        linkedIssueIds: linkedIssueIds ?? this.linkedIssueIds,
      );

  /// The form as the draft keeps it: the names of the `ReportDraft` of the contract, the texts as they were typed.
  Map<String, Object?> toFields() => <String, Object?>{
        'project_id': projectId,
        'period_id': periodId,
        if (planVersionId != null) 'plan_version_id': planVersionId,
        'report_type': reportType,
        'measurement_basis': basis,
        'funding_lines': <Object?>[
          for (final CellKey key in kCells)
            <String, Object?>{
              'bucket': key.bucket,
              'budget_level': key.level,
              'cumulative_vnd': cell(key).cumulative,
              if (cell(key).ctmtqg.isNotEmpty) 'ctmtqg_subset_vnd': cell(key).ctmtqg,
              'next_month_vnd': cell(key).nextMonth,
              if (cell(key).nextCtmtqg.isNotEmpty) 'next_month_ctmtqg_subset_vnd': cell(key).nextCtmtqg,
            },
        ],
        if (construction.isNotEmpty) 'construction_vnd': construction,
        if (acceptance.isNotEmpty) 'acceptance_vnd': acceptance,
        if (treasury.isNotEmpty) 'treasury_submitted_vnd': treasury,
        if (preparing.isNotEmpty) 'preparing_dossier_vnd': preparing,
        if (percent.isNotEmpty) 'physical_progress_pct': percent,
        if (explanation.isNotEmpty) 'negative_delta_explanation': explanation,
        'narrative': _narrative(trim: false),
      };

  Map<String, Object?> _narrative({required bool trim}) {
    String shaped(String value) => trim ? value.trim() : value;
    final Map<String, String> sections = <String, String>{
      'results': shaped(results),
      'causes': shaped(causes),
      'solutions': shaped(solutions),
      'proposals': shaped(proposals),
    };
    return <String, Object?>{
      for (final MapEntry<String, String> section in sections.entries)
        if (section.value.trim().isNotEmpty) section.key: section.value,
      if (linkedIssueIds.isNotEmpty) 'linked_issue_ids': linkedIssueIds,
    };
  }

  /// The body of `report.draft.save` for a form that passed the review: whole dong written out, the texts trimmed, the volumes
  /// only when all four are given (a save without them leaves the server's as they are). [reportId] names the report in the path.
  Map<String, Object?> toPayload(String reportId) {
    final bool hasVolumes = <String>[construction, acceptance, treasury, preparing].every((String value) => digitsOf(value) != null);
    final String percentText = percent.trim().replaceAll(',', '.');
    final String words = explanation.trim();
    return <String, Object?>{
      'report_id': reportId,
      'project_id': projectId,
      'period_id': periodId,
      if (planVersionId != null) 'plan_version_id': planVersionId,
      'report_type': reportType,
      'measurement_basis': basis,
      'funding_lines': <Object?>[
        for (final CellKey key in kCells)
          <String, Object?>{
            'bucket': key.bucket,
            'budget_level': key.level,
            'cumulative_vnd': digitsOf(cell(key).cumulative) ?? '0',
            if (digitsOf(cell(key).ctmtqg) != null) 'ctmtqg_subset_vnd': digitsOf(cell(key).ctmtqg),
            'next_month_vnd': digitsOf(cell(key).nextMonth) ?? '0',
            if (digitsOf(cell(key).nextCtmtqg) != null) 'next_month_ctmtqg_subset_vnd': digitsOf(cell(key).nextCtmtqg),
          },
      ],
      if (hasVolumes) ...<String, Object?>{
        'construction_vnd': digitsOf(construction),
        'acceptance_vnd': digitsOf(acceptance),
        'treasury_submitted_vnd': digitsOf(treasury),
        'preparing_dossier_vnd': digitsOf(preparing),
        if (percentText.isNotEmpty) 'physical_progress_pct': percentText,
      },
      if (words.isNotEmpty) 'negative_delta_explanation': words,
      'narrative': _narrative(trim: true),
    };
  }

  @override
  bool operator ==(Object other) => other is ReportForm && _sameJson(other.toFields(), toFields());

  @override
  int get hashCode => Object.hashAll(<Object?>[projectId, periodId, basis, construction, results]);
}

bool _sameJson(Object? a, Object? b) {
  if (a is Map && b is Map) return a.length == b.length && a.entries.every((MapEntry<Object?, Object?> e) => b.containsKey(e.key) && _sameJson(e.value, b[e.key]));
  if (a is List && b is List) return a.length == b.length && List<bool>.generate(a.length, (int i) => _sameJson(a[i], b[i])).every((bool same) => same);
  return a == b;
}

/// Whether two forms hold the same report: the same cells, volumes and words, the amounts compared as exact dong and the percent as a
/// number, so that `40,5` and `40.50` are the same. It tells a copy the server holds from the draft it was made from.
bool sameFigures(ReportForm a, ReportForm b) {
  bool amount(String x, String y) => (digitsOf(x) ?? x.trim()) == (digitsOf(y) ?? y.trim());
  bool number(String x, String y) {
    final double? left = double.tryParse(x.trim().replaceAll(',', '.'));
    final double? right = double.tryParse(y.trim().replaceAll(',', '.'));
    return left == null || right == null ? x.trim() == y.trim() : left == right;
  }

  for (final CellKey key in kCells) {
    final CellEntry left = a.cell(key);
    final CellEntry right = b.cell(key);
    if (!amount(left.cumulative, right.cumulative) || !amount(left.ctmtqg, right.ctmtqg) || !amount(left.nextMonth, right.nextMonth) || !amount(left.nextCtmtqg, right.nextCtmtqg)) return false;
  }
  return a.reportType == b.reportType &&
      a.basis == b.basis &&
      amount(a.construction, b.construction) &&
      amount(a.acceptance, b.acceptance) &&
      amount(a.treasury, b.treasury) &&
      amount(a.preparing, b.preparing) &&
      number(a.percent, b.percent) &&
      a.explanation.trim() == b.explanation.trim() &&
      a.results.trim() == b.results.trim() &&
      a.causes.trim() == b.causes.trim() &&
      a.solutions.trim() == b.solutions.trim() &&
      a.proposals.trim() == b.proposals.trim();
}
