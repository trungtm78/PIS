import '../read_support/moment.dart';
import '../read_support/wire.dart';
import 'project_models.dart';

/// A reporting period of the calendar of the tenant.
final class ReportingPeriod {
  const ReportingPeriod({required this.id, required this.code, required this.startDate, required this.endDate, required this.deadlineAt});

  final String id;
  final String code;
  final String startDate;
  final String endDate;

  /// The deadline as the calendar of the tenant gives it (an instant); shown in Vietnam time.
  final String deadlineAt;
}

/// A period of the calendar, or null when the row is not one.
ReportingPeriod? parseReportingPeriod(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = text(row?['code']);
  final String? start = day(row?['start_date']);
  final String? end = day(row?['end_date']);
  final String? deadline = filled(row?['deadline_at']);
  if (row == null || id == null || code == null || start == null || end == null || deadline == null) return null;
  return ReportingPeriod(id: id, code: code, startDate: start, endDate: end, deadlineAt: deadline);
}

/// The period to open when the reader named none: the newest one that has started, else the first. The day is the Vietnam
/// calendar day of the instant given; the clock only chooses which period is shown first, the reader may pick another.
ReportingPeriod? defaultPeriod(List<ReportingPeriod> periods, DateTime now) {
  if (periods.isEmpty) return null;
  final List<ReportingPeriod> sorted = <ReportingPeriod>[...periods]..sort((ReportingPeriod a, ReportingPeriod b) => b.startDate.compareTo(a.startDate));
  final String today = vietnamDayOf(now);
  for (final ReportingPeriod period in sorted) {
    if (period.startDate.compareTo(today) <= 0) return period;
  }
  return sorted.last;
}

/// What a project owes in a period.
enum ReportState { submitted, draft, notStarted }

/// One project that must report in the period.
final class ProgressProject {
  const ProgressProject({required this.projectId, required this.code, required this.name, required this.unitId, required this.unitName, required this.state, required this.late, required this.overdue, this.leaderName});

  final String projectId;
  final String code;
  final String name;
  final String unitId;
  final String unitName;
  final ReportState state;
  final bool late;

  /// The deadline passed and nothing was handed in (the server judges it, not the phone's clock).
  final bool overdue;

  /// The leader in charge of the project in the register, when the register could be read.
  final String? leaderName;
}

ProgressProject? _project(Object? raw, Map<String, String> leaders) {
  final Json? row = asRecord(raw);
  final Json? project = asRecord(row?['project']);
  final Json? unit = asRecord(row?['unit']);
  final String? id = filled(project?['id']);
  final String? unitId = filled(unit?['id']);
  final ReportState? state = switch (row?['state']) {
    'SUBMITTED' => ReportState.submitted,
    'DRAFT' => ReportState.draft,
    'NOT_STARTED' => ReportState.notStarted,
    _ => null,
  };
  if (row == null || project == null || unit == null || id == null || unitId == null || state == null) return null;
  return ProgressProject(
    projectId: id,
    code: text(project['code']) ?? '',
    name: text(project['name']) ?? '',
    unitId: unitId,
    unitName: text(unit['name']) ?? '',
    state: state,
    late: row['is_late'] == true,
    overdue: row['overdue'] == true,
    leaderName: leaders[id],
  );
}

/// The projects of the period that have not handed a report in, with the deadline of the period.
final class UnreportedProjects {
  const UnreportedProjects({this.period, required this.periods, required this.deadlinePassed, required this.mustReport, required this.projects, this.asOf});

  /// The period whose board is listed; null when the calendar has no period yet.
  final ReportingPeriod? period;
  final List<ReportingPeriod> periods;
  final bool deadlinePassed;

  /// How many projects must report in all (the total of the board, in the scope of the reader).
  final int mustReport;

  /// Only the projects whose unit is in the scope the board counted: a project of another unit is never listed.
  final List<ProgressProject> projects;
  final String? asOf;
}

/// The list from `{periods: [...], progress: {period, deadline_passed, total, units, projects, as_of} | null, leaders: {items: [project line, ...]} | null}`, or null when it is
/// not one. A project that has handed a report in is left out; one whose unit is not among the units of the board is left out
/// too, since the board counted only the scope of the reader.
UnreportedProjects? parseUnreported(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['periods'] is! List) return null;
  final List<ReportingPeriod> periods = <ReportingPeriod>[for (final Object? item in listOf(body['periods'])) ?parseReportingPeriod(item)];
  if (body['progress'] == null) return UnreportedProjects(periods: periods, deadlinePassed: false, mustReport: 0, projects: const <ProgressProject>[]);
  final Json? progress = asRecord(body['progress']);
  final ReportingPeriod? period = parseReportingPeriod(progress?['period']);
  final Json? total = asRecord(progress?['total']);
  if (progress == null || period == null || total == null || progress['projects'] is! List) return null;
  final Map<String, String> leaders = <String, String>{
    for (final Object? row in listOf(asRecord(body['leaders'])?['items']))
      if (parseProjectLine(row) case final ProjectLine line when line.leaderName != null) line.id: line.leaderName!,
  };
  final Set<String> unitsInScope = <String>{
    for (final Object? unit in listOf(progress['units'])) ?filled(asRecord(asRecord(unit)?['unit'])?['id']),
  };
  return UnreportedProjects(
    period: period,
    periods: periods,
    deadlinePassed: progress['deadline_passed'] == true,
    mustReport: count(total['must_report']),
    projects: <ProgressProject>[
      for (final Object? item in listOf(progress['projects']))
        if (_project(item, leaders) case final ProgressProject project when project.state != ReportState.submitted && unitsInScope.contains(project.unitId)) project,
    ],
    asOf: filled(progress['as_of']),
  );
}
