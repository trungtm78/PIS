import '../../read_support/wire.dart';

/// A reporting period the person can choose (`/resources/reporting_period`).
final class PeriodOption {
  const PeriodOption({required this.id, required this.code, required this.type, required this.startDate, required this.endDate, required this.fiscalYear, required this.status});

  final String id;
  final String code;

  /// `WEEK` or `MONTH`; the calendar can produce others, which are not reported on here.
  final String type;
  final String startDate;
  final String endDate;
  final int fiscalYear;

  /// `OPEN`, `SOFT_CLOSED` or `LOCKED`, as the server judged it when the list was read; the server judges again when the report is made.
  final String status;

  bool get isLocked => status == 'LOCKED';
}

/// A project the person can report on (`/resources/project`, only what their scope reaches).
final class ProjectOption {
  const ProjectOption({required this.id, required this.code, required this.name});

  final String id;
  final String code;
  final String name;
}

/// The two lists the choice of a report is made from.
final class StartOptions {
  const StartOptions({required this.periods, required this.projects});

  final List<PeriodOption> periods;
  final List<ProjectOption> projects;

  /// The periods of a type, the newest first.
  List<PeriodOption> periodsOf(String type) =>
      <PeriodOption>[for (final PeriodOption period in periods) if (period.type == type) period]..sort((PeriodOption a, PeriodOption b) => b.startDate.compareTo(a.startDate));
}

PeriodOption? parsePeriodOption(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = text(row?['code']);
  final String? type = text(row?['period_type']);
  final String? start = day(row?['start_date']);
  final String? end = day(row?['end_date']);
  final int? year = whole(row?['fiscal_year']);
  final String? status = text(row?['status']);
  if (row == null || id == null || code == null || type == null || start == null || end == null || year == null || status == null) return null;
  return PeriodOption(id: id, code: code, type: type, startDate: start, endDate: end, fiscalYear: year, status: status);
}

ProjectOption? parseProjectOption(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = text(row?['code']);
  final String? name = text(row?['name']);
  if (row == null || id == null || code == null || name == null) return null;
  return ProjectOption(id: id, code: code, name: name);
}

/// Reads `{periods: [...], projects: [...]}`; a row that is not one is left out rather than shown half-filled.
StartOptions? parseStartOptions(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null || row['periods'] is! List || row['projects'] is! List) return null;
  return StartOptions(
    periods: <PeriodOption>[for (final Object? item in listOf(row['periods'])) ?parsePeriodOption(item)],
    projects: <ProjectOption>[for (final Object? item in listOf(row['projects'])) ?parseProjectOption(item)],
  );
}
