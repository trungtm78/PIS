import '../../read_support/wire.dart';
import 'report_cells.dart';

/// What the server says about one cell of the report: the money the plan allocated to it and what the period before had
/// reached. Both are reference data (read only; the phone never writes them).
final class CellReference {
  const CellReference({required this.allocated, this.previous});

  final String allocated;

  /// The cumulative figure of the period before, null when there is no period to compare with.
  final String? previous;

  Map<String, Object?> toJson() => <String, Object?>{'allocated_vnd': allocated, if (previous != null) 'previous_cumulative_vnd': previous};
}

/// The project, the period and the plan of a report, and the allocation and the previous figures of its cells, as the server
/// gave them at [fetchedAt]. It is kept with the draft, so a report started in the field still shows what it is about when the
/// phone has no network; the cells are empty until the server has been asked once.
final class ReportContext {
  const ReportContext({
    required this.projectCode,
    required this.projectName,
    required this.periodCode,
    required this.periodType,
    required this.periodStart,
    required this.periodEnd,
    required this.fiscalYear,
    this.periodStatus,
    this.planFiscalYear,
    this.planRevision,
    this.cells = const <String, CellReference>{},
    this.fetchedAt,
  });

  factory ReportContext.fromJson(Map<String, Object?> json) => ReportContext(
        projectCode: text(json['project_code']) ?? '',
        projectName: text(json['project_name']) ?? '',
        periodCode: text(json['period_code']) ?? '',
        periodType: text(json['period_type']) ?? '',
        periodStart: text(json['period_start']) ?? '',
        periodEnd: text(json['period_end']) ?? '',
        fiscalYear: whole(json['fiscal_year']) ?? 0,
        periodStatus: text(json['period_status']),
        planFiscalYear: whole(json['plan_fiscal_year']),
        planRevision: whole(json['plan_revision']),
        cells: <String, CellReference>{
          for (final MapEntry<String, Object?> entry in (asRecord(json['cells']) ?? const <String, Object?>{}).entries)
            if (asRecord(entry.value) case final Json value when dong(value['allocated_vnd']) != null)
              entry.key: CellReference(allocated: dong(value['allocated_vnd'])!, previous: dong(value['previous_cumulative_vnd'])),
        },
        fetchedAt: text(json['fetched_at']),
      );

  final String projectCode;
  final String projectName;
  final String periodCode;
  final String periodType;
  final String periodStart;
  final String periodEnd;
  final int fiscalYear;
  final String? periodStatus;
  final int? planFiscalYear;
  final int? planRevision;
  final Map<String, CellReference> cells;

  /// When the phone got the reference figures, an ISO instant; null while it has only what the choice of the period gave.
  final String? fetchedAt;

  /// Whether the server has given the allocation of the cells (a report that exists on the server).
  bool get hasReference => cells.isNotEmpty;

  CellReference? reference(CellKey key) => cells[key.id];

  /// The allocation of the six cells added up, or null while it is not known.
  String? get allocatedTotal => hasReference ? sumTyped(<String>[for (final CellKey key in kCells) reference(key)?.allocated ?? '0']) : null;

  /// The cumulative figure of the period before for the six cells, or null when no cell has one.
  String? get previousTotal {
    final List<String> known = <String>[for (final CellKey key in kCells) if (reference(key)?.previous != null) reference(key)!.previous!];
    return known.isEmpty ? null : sumTyped(known);
  }

  Map<String, Object?> toJson() => <String, Object?>{
        'project_code': projectCode,
        'project_name': projectName,
        'period_code': periodCode,
        'period_type': periodType,
        'period_start': periodStart,
        'period_end': periodEnd,
        'fiscal_year': fiscalYear,
        if (periodStatus != null) 'period_status': periodStatus,
        if (planFiscalYear != null) 'plan_fiscal_year': planFiscalYear,
        if (planRevision != null) 'plan_revision': planRevision,
        if (cells.isNotEmpty) 'cells': <String, Object?>{for (final MapEntry<String, CellReference> entry in cells.entries) entry.key: entry.value.toJson()},
        if (fetchedAt != null) 'fetched_at': fetchedAt,
      };

  /// The same context with the reference figures the server gave at [at]; what the choice of the period said stays.
  ReportContext withReference({required Map<String, CellReference> cells, required String at, String? periodStatus, int? planFiscalYear, int? planRevision}) => ReportContext(
        projectCode: projectCode,
        projectName: projectName,
        periodCode: periodCode,
        periodType: periodType,
        periodStart: periodStart,
        periodEnd: periodEnd,
        fiscalYear: fiscalYear,
        periodStatus: periodStatus ?? this.periodStatus,
        planFiscalYear: planFiscalYear ?? this.planFiscalYear,
        planRevision: planRevision ?? this.planRevision,
        cells: cells,
        fetchedAt: at,
      );
}

/// The month the registration of a report is for: the one after the month the period ends in (`2026-10-30` gives `2026-11`).
({int year, int month})? nextMonthOf(String endDate) {
  final RegExpMatch? matched = RegExp(r'^(\d{4})-(\d{2})-\d{2}$').firstMatch(endDate);
  if (matched == null) return null;
  final int year = int.parse(matched.group(1)!);
  final int month = int.parse(matched.group(2)!);
  return month == 12 ? (year: year + 1, month: 1) : (year: year, month: month + 1);
}
