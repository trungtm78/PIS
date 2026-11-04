import '../read_support/wire.dart';

/// The stages of the life cycle of a project (PRJ 3.1 section 4), in the words of the server.
enum ProjectStage { concept, appraisal, pipeline, budgeted, implementation, suspended, completed, settled, closed, rejected, cancelled }

const Map<String, ProjectStage> _stages = <String, ProjectStage>{
  'CONCEPT': ProjectStage.concept,
  'APPRAISAL': ProjectStage.appraisal,
  'PIPELINE': ProjectStage.pipeline,
  'BUDGETED': ProjectStage.budgeted,
  'IMPLEMENTATION': ProjectStage.implementation,
  'SUSPENDED': ProjectStage.suspended,
  'COMPLETED': ProjectStage.completed,
  'SETTLED': ProjectStage.settled,
  'CLOSED': ProjectStage.closed,
  'REJECTED': ProjectStage.rejected,
  'CANCELLED': ProjectStage.cancelled,
};

/// One project of the register in the scope of the reader (`/resources/project`).
final class ProjectLine {
  const ProjectLine({
    required this.id,
    required this.code,
    required this.name,
    required this.stage,
    required this.ownerUnitName,
    this.investorUnitName,
    this.projectGroup,
    this.nationalCode,
    this.leaderName,
  });

  final String id;
  final String code;
  final String name;
  final ProjectStage stage;
  final String ownerUnitName;
  final String? investorUnitName;
  final String? projectGroup;
  final String? nationalCode;
  final String? leaderName;

  /// The unit the project is looked after by: the investor when there is one.
  String get unitName => investorUnitName ?? ownerUnitName;
}

ProjectLine? parseProjectLine(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = text(row?['code']);
  final String? name = text(row?['name']);
  final ProjectStage? stage = _stages[row?['status']];
  if (row == null || id == null || code == null || name == null || stage == null) return null;
  return ProjectLine(
    id: id,
    code: code,
    name: name,
    stage: stage,
    ownerUnitName: text(row['owner_unit_name']) ?? '',
    investorUnitName: filled(row['investor_unit_name']),
    projectGroup: filled(row['project_group']),
    nationalCode: filled(row['national_project_code']),
    leaderName: filled(asRecord(row['leader_in_charge'])?['display_name']),
  );
}

/// The register as the list reads it, and the moment it describes.
final class ProjectRegister {
  const ProjectRegister({required this.projects, required this.truncated, this.asOf});

  final List<ProjectLine> projects;

  /// The register has more projects than the pages that were read.
  final bool truncated;
  final String? asOf;
}

ProjectRegister? parseProjectRegister(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  return ProjectRegister(
    projects: <ProjectLine>[for (final Object? row in listOf(body['items'])) ?parseProjectLine(row)],
    truncated: filled(body['next_cursor']) != null,
    asOf: filled(body['as_of']),
  );
}

/// Vietnamese lower-case letters with marks (written as unicode escapes, including U+0111 the d with a stroke) and the plain letter each stands for.
final Map<String, String> _plain = <String, String>{
  '\u00e0': 'a', '\u00e1': 'a', '\u1ea3': 'a', '\u00e3': 'a', '\u1ea1': 'a', '\u0103': 'a', '\u1eb1': 'a', '\u1eaf': 'a', '\u1eb3': 'a', '\u1eb5': 'a', '\u1eb7': 'a', '\u00e2': 'a', '\u1ea7': 'a', '\u1ea5': 'a', '\u1ea9': 'a', '\u1eab': 'a', '\u1ead': 'a',
  '\u00e8': 'e', '\u00e9': 'e', '\u1ebb': 'e', '\u1ebd': 'e', '\u1eb9': 'e', '\u00ea': 'e', '\u1ec1': 'e', '\u1ebf': 'e', '\u1ec3': 'e', '\u1ec5': 'e', '\u1ec7': 'e',
  '\u00ec': 'i', '\u00ed': 'i', '\u1ec9': 'i', '\u0129': 'i', '\u1ecb': 'i',
  '\u00f2': 'o', '\u00f3': 'o', '\u1ecf': 'o', '\u00f5': 'o', '\u1ecd': 'o', '\u00f4': 'o', '\u1ed3': 'o', '\u1ed1': 'o', '\u1ed5': 'o', '\u1ed7': 'o', '\u1ed9': 'o', '\u01a1': 'o', '\u1edd': 'o', '\u1edb': 'o', '\u1edf': 'o', '\u1ee1': 'o', '\u1ee3': 'o',
  '\u00f9': 'u', '\u00fa': 'u', '\u1ee7': 'u', '\u0169': 'u', '\u1ee5': 'u', '\u01b0': 'u', '\u1eeb': 'u', '\u1ee9': 'u', '\u1eed': 'u', '\u1eef': 'u', '\u1ef1': 'u',
  '\u1ef3': 'y', '\u00fd': 'y', '\u1ef7': 'y', '\u1ef9': 'y', '\u1ef5': 'y', '\u0111': 'd',
};

/// Lower case without diacritics, so that a search for "duong" finds the street named with its marks: people on a phone do not type the marks.
String plainText(String value) {
  final StringBuffer out = StringBuffer();
  for (final int rune in value.toLowerCase().runes) {
    final String char = String.fromCharCode(rune);
    out.write(_plain[char] ?? char);
  }
  return out.toString();
}

/// What the list is narrowed by: a search text and a stage.
final class ProjectFilter {
  const ProjectFilter({this.query = '', this.stage});

  final String query;
  final ProjectStage? stage;

  bool get isEmpty => query.trim().isEmpty && stage == null;

  ProjectFilter copyWith({String? query, ProjectStage? stage, bool clearStage = false}) =>
      ProjectFilter(query: query ?? this.query, stage: clearStage ? null : (stage ?? this.stage));
}

/// The projects a filter leaves: the search runs on the code, the name, the unit, the leader and the national code.
List<ProjectLine> filterProjects(List<ProjectLine> projects, ProjectFilter filter) {
  final String needle = plainText(filter.query.trim());
  return <ProjectLine>[
    for (final ProjectLine project in projects)
      if ((filter.stage == null || project.stage == filter.stage) &&
          (needle.isEmpty ||
              plainText('${project.code} ${project.name} ${project.unitName} ${project.leaderName ?? ''} ${project.nationalCode ?? ''}').contains(needle)))
        project,
  ];
}

/// One milestone of the plan of a project.
final class Milestone {
  const Milestone({required this.id, required this.name, required this.plannedDate, required this.status, required this.delayDays, required this.delayed, this.actualDate});

  final String id;
  final String name;
  final String plannedDate;
  final String? actualDate;
  final String status;
  final int delayDays;
  final bool delayed;
}

Milestone? _milestone(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? name = text(row?['name']);
  final String? planned = day(row?['planned_date']);
  final String? status = text(row?['status']);
  if (row == null || id == null || name == null || planned == null || status == null) return null;
  return Milestone(id: id, name: name, plannedDate: planned, actualDate: day(row['actual_date']), status: status, delayDays: count(row['delay_days']), delayed: row['delayed'] == true);
}

/// One risk of the register of a project; the score and the band are the server's.
final class ProjectRisk {
  const ProjectRisk({required this.id, required this.code, required this.title, required this.score, required this.level, required this.overdue, required this.status});

  final String id;
  final String code;
  final String title;
  final int score;
  final String level;
  final bool overdue;
  final String status;
}

ProjectRisk? _risk(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = text(row?['code']);
  final String? title = text(row?['title']);
  final int? score = whole(row?['score']);
  final String? level = text(row?['level']);
  final String? status = text(row?['status']);
  if (row == null || id == null || code == null || title == null || score == null || level == null || status == null) return null;
  return ProjectRisk(id: id, code: code, title: title, score: score, level: level, overdue: row['overdue'] == true, status: status);
}

/// The risk register as the project detail shows it: the counts of the server and the highest risks.
final class RiskSummary {
  const RiskSummary({required this.live, required this.critical, required this.overdue, required this.top});

  final int live;
  final int critical;
  final int overdue;
  final List<ProjectRisk> top;
}

/// The workspace of one project (PRJ-03) for the phone: the stage, the investment, the plan and the risks. A part the
/// reader may not read is null, and the screen says so instead of showing nothing or zero.
final class ProjectDetail {
  const ProjectDetail({
    required this.line,
    required this.totalInvestmentVnd,
    required this.milestones,
    required this.risks,
    this.areaLabel,
    this.sectorLabel,
    this.startYear,
    this.endYear,
    this.asOf,
  });

  final ProjectLine line;
  final String totalInvestmentVnd;
  final String? areaLabel;
  final String? sectorLabel;
  final int? startYear;
  final int? endYear;
  final List<Milestone>? milestones;
  final RiskSummary? risks;
  final String? asOf;
}

/// The detail from `{project, milestones, risks}`; the project is required, the other two are null when they could not be
/// read.
ProjectDetail? parseProjectDetail(Object? raw) {
  final Json? body = asRecord(raw);
  final Json? project = asRecord(body?['project']);
  final ProjectLine? line = parseProjectLine(project);
  final String? total = unsignedDong(project?['total_investment_vnd']);
  if (body == null || project == null || line == null || total == null) return null;
  final Json? milestones = asRecord(body['milestones']);
  final Json? risks = asRecord(body['risks']);
  return ProjectDetail(
    line: line,
    totalInvestmentVnd: total,
    areaLabel: filled(asRecord(project['area'])?['label']),
    sectorLabel: filled(asRecord(project['sector'])?['label']),
    startYear: whole(project['start_year']),
    endYear: whole(project['end_year']),
    milestones: milestones == null ? null : <Milestone>[for (final Object? item in listOf(milestones['items'])) ?_milestone(item)],
    risks: risks == null
        ? null
        : RiskSummary(
            live: count(risks['live_count']),
            critical: count(risks['critical_count']),
            overdue: count(risks['overdue_count']),
            top: <ProjectRisk>[for (final Object? item in listOf(risks['items'])) ?_risk(item)],
          ),
    asOf: filled(milestones?['as_of']) ?? filled(risks?['as_of']),
  );
}
