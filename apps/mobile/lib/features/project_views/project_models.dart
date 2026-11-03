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

final Map<String, String> _plain = <String, String>{
  'à': 'a', 'á': 'a', 'ả': 'a', 'ã': 'a', 'ạ': 'a', 'ă': 'a', 'ằ': 'a', 'ắ': 'a', 'ẳ': 'a', 'ẵ': 'a', 'ặ': 'a', 'â': 'a', 'ầ': 'a', 'ấ': 'a', 'ẩ': 'a', 'ẫ': 'a', 'ậ': 'a',
  'è': 'e', 'é': 'e', 'ẻ': 'e', 'ẽ': 'e', 'ẹ': 'e', 'ê': 'e', 'ề': 'e', 'ế': 'e', 'ể': 'e', 'ễ': 'e', 'ệ': 'e',
  'ì': 'i', 'í': 'i', 'ỉ': 'i', 'ĩ': 'i', 'ị': 'i',
  'ò': 'o', 'ó': 'o', 'ỏ': 'o', 'õ': 'o', 'ọ': 'o', 'ô': 'o', 'ồ': 'o', 'ố': 'o', 'ổ': 'o', 'ỗ': 'o', 'ộ': 'o', 'ơ': 'o', 'ờ': 'o', 'ớ': 'o', 'ở': 'o', 'ỡ': 'o', 'ợ': 'o',
  'ù': 'u', 'ú': 'u', 'ủ': 'u', 'ũ': 'u', 'ụ': 'u', 'ư': 'u', 'ừ': 'u', 'ứ': 'u', 'ử': 'u', 'ữ': 'u', 'ự': 'u',
  'ỳ': 'y', 'ý': 'y', 'ỷ': 'y', 'ỹ': 'y', 'ỵ': 'y', 'đ': 'd',
};

/// Lower case without diacritics, so that a search for "duong" finds "Đường": people on a phone do not type the marks.
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
