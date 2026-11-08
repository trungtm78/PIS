import '../dashboard/committee_workspace.dart';
import '../read_support/wire.dart';

/// What the full committee dashboard (MOB-72) reads from `getCommitteeWorkspace`, beyond the figures the card on the home already reads: the
/// rows by sector, district, investor and funding source, the whole attention list the server sent, the units that do not report, the
/// directive tracker and the live alerts with their consequence. One read gives all of it, so one view is audited, not five. Every amount is
/// a string of the server and every percentage is shown as written; a figure the server leaves out is unknown, never zero.

/// The four ways the province is cut.
enum CommitteeDimension { sector, district, investor, fundSource }

const Map<CommitteeDimension, String> _rowKeys = <CommitteeDimension, String>{
  CommitteeDimension.sector: 'by_sector',
  CommitteeDimension.district: 'by_district',
  CommitteeDimension.investor: 'by_investor',
  CommitteeDimension.fundSource: 'by_fund_source',
};

/// One row of progress: a sector, a district, an investor unit or a funding source.
final class CommitteeRow {
  const CommitteeRow({
    required this.key,
    required this.label,
    required this.projects,
    required this.attentionProjects,
    required this.planVnd,
    required this.expectedPct,
    required this.rag,
    required this.lastYearKnown,
    required this.lastYearTotal,
    required this.unknownLines,
    this.disbursedVnd,
    this.ratePct,
    this.gapPoints,
    this.planSharePct,
  });

  final String key;
  final String label;
  final int projects;
  final int attentionProjects;
  final String planVnd;
  final String? disbursedVnd;
  final String? ratePct;
  final String expectedPct;
  final String? gapPoints;
  final String? planSharePct;
  final CommitteeRag rag;
  final int lastYearKnown;
  final int lastYearTotal;

  /// How many funding lines have no figure (their share is unknown, and the rate is then held back by the server).
  final int unknownLines;

  /// The server could not judge the row: no colour is said, only that there is no figure.
  bool get hasRate => ratePct != null;
}

CommitteeRow? _row(Object? raw) {
  final Json? row = asRecord(raw);
  final String? key = filled(row?['key']);
  final String? label = filled(row?['label']);
  final String? plan = filled(row?['plan_vnd']);
  final String? expected = filled(row?['expected_pct']);
  final CommitteeRag? rag = parseCommitteeRag(row?['rag']);
  if (row == null || key == null || label == null || plan == null || expected == null || rag == null) return null;
  final Json? coverage = asRecord(row['last_year_coverage']);
  return CommitteeRow(
    key: key,
    label: label,
    projects: count(row['projects']),
    attentionProjects: count(row['attention_projects']),
    planVnd: plan,
    disbursedVnd: text(row['disbursed_vnd']),
    ratePct: text(row['rate_pct']),
    expectedPct: expected,
    gapPoints: text(row['gap_points']),
    planSharePct: text(row['plan_share_pct']),
    rag: rag,
    lastYearKnown: count(coverage?['known']),
    lastYearTotal: count(coverage?['total']),
    unknownLines: count(row['unknown_lines']),
  );
}

/// One signal that put a project on the attention list: the reason and the figure behind it, as the server wrote it.
final class CommitteeSignal {
  const CommitteeSignal({required this.reason, this.value, this.unit});

  final CommitteeReason reason;
  final String? value;

  /// `DAYS`, `PERCENT` or `POINTS`.
  final String? unit;
}

/// One project of the attention list.
final class CommitteeProject {
  const CommitteeProject({
    required this.rank,
    required this.code,
    required this.name,
    required this.signals,
    required this.planVnd,
    required this.expectedPct,
    this.sectorName,
    this.districtName,
    this.investorName,
    this.disbursedVnd,
    this.ratePct,
  });

  final int rank;
  final String code;
  final String name;
  final String? sectorName;
  final String? districtName;
  final String? investorName;
  final String planVnd;
  final String? disbursedVnd;
  final String? ratePct;
  final String expectedPct;
  final List<CommitteeSignal> signals;
}

CommitteeProject? _project(Object? raw) {
  final Json? row = asRecord(raw);
  final int? rank = whole(row?['rank']);
  final String? code = filled(row?['code']);
  final String? name = filled(row?['name']);
  final String? plan = filled(row?['plan_vnd']);
  final String? expected = filled(row?['expected_pct']);
  if (row == null || rank == null || code == null || name == null || plan == null || expected == null) return null;
  final List<CommitteeSignal> signals = <CommitteeSignal>[];
  for (final Object? entry in listOf(row['signals'])) {
    final Json? signal = asRecord(entry);
    final CommitteeReason? reason = parseCommitteeReason(signal?['reason']);
    if (reason == null || signals.any((CommitteeSignal one) => one.reason == reason)) continue;
    signals.add(CommitteeSignal(reason: reason, value: text(signal?['value']), unit: text(signal?['unit'])));
  }
  return CommitteeProject(
    rank: rank,
    code: code,
    name: name,
    sectorName: filled(row['sector_name']),
    districtName: filled(row['district_name']),
    investorName: filled(row['investor_name']),
    planVnd: plan,
    disbursedVnd: text(row['disbursed_vnd']),
    ratePct: text(row['rate_pct']),
    expectedPct: expected,
    signals: signals,
  );
}

/// How a unit stands with its reports.
enum CommitteeUnitReason { neverReported, stale, lowRate, other }

/// One unit that is expected to report and does not (or does so too little or too late).
final class CommitteeUnit {
  const CommitteeUnit({required this.name, required this.expected, required this.received, required this.reason, this.ratePct, this.lastReportedOn, this.daysSince});

  final String name;
  final int expected;
  final int received;
  final String? ratePct;
  final String? lastReportedOn;
  final int? daysSince;
  final CommitteeUnitReason reason;
}

CommitteeUnit? _unit(Object? raw) {
  final Json? row = asRecord(raw);
  final String? name = filled(row?['unit_name']);
  if (row == null || name == null || row['not_reporting'] != true) return null;
  final CommitteeUnitReason reason = switch (row['reason']) {
    'NEVER_REPORTED' => CommitteeUnitReason.neverReported,
    'STALE' => CommitteeUnitReason.stale,
    'LOW_RATE' => CommitteeUnitReason.lowRate,
    _ => CommitteeUnitReason.other,
  };
  return CommitteeUnit(
    name: name,
    expected: count(row['expected']),
    received: count(row['received']),
    ratePct: text(row['reporting_rate_pct']),
    lastReportedOn: filled(row['last_reported_on']),
    daysSince: whole(row['days_since_report']),
    reason: reason,
  );
}

/// An overdue directive, with the phase it has reached.
final class CommitteeDirective {
  const CommitteeDirective({required this.code, required this.text, required this.unitName, required this.dueOn, required this.overdueDays, required this.escalated, required this.extensionCount, this.projectCode});

  final String code;
  final String text;
  final String unitName;
  final String dueOn;
  final int overdueDays;
  final bool escalated;
  final int extensionCount;
  final String? projectCode;
}

/// The directives of the steering meetings that are open, late and escalated, by unit.
final class CommitteeDirectives {
  const CommitteeDirectives({required this.open, required this.overdue, required this.escalated, required this.units, required this.directives, required this.truncated, this.escalateAfterDays});

  final int open;
  final int overdue;
  final int escalated;
  final List<({String unitName, int open, int overdue, int escalated})> units;
  final List<CommitteeDirective> directives;
  final bool truncated;
  final int? escalateAfterDays;
}

CommitteeDirectives? _directives(Object? raw) {
  final Json? row = asRecord(raw);
  final Json? totals = asRecord(row?['totals']);
  if (row == null || totals == null) return null;
  return CommitteeDirectives(
    open: count(totals['open']),
    overdue: count(totals['overdue']),
    escalated: count(totals['escalated']),
    units: <({String unitName, int open, int overdue, int escalated})>[
      for (final Object? entry in listOf(row['units']))
        if (filled(asRecord(entry)?['unit_name']) case final String name)
          (unitName: name, open: count(asRecord(entry)?['open']), overdue: count(asRecord(entry)?['overdue']), escalated: count(asRecord(entry)?['escalated'])),
    ],
    directives: <CommitteeDirective>[
      for (final Object? entry in listOf(row['directives']))
        if (_directive(entry) case final CommitteeDirective directive) directive,
    ],
    truncated: row['truncated'] == true,
    escalateAfterDays: whole(row['escalate_after_days']),
  );
}

CommitteeDirective? _directive(Object? raw) {
  final Json? row = asRecord(raw);
  final String? code = filled(row?['code']);
  final String? body = filled(row?['text']);
  final String? unit = filled(row?['assignee_unit_name']);
  final String? due = filled(row?['due_on']);
  if (row == null || code == null || body == null || unit == null || due == null) return null;
  return CommitteeDirective(
    code: code,
    text: body,
    unitName: unit,
    dueOn: due,
    overdueDays: count(row['overdue_days']),
    escalated: row['phase'] == 'ESCALATED',
    extensionCount: count(row['extension_count']),
    projectCode: filled(row['project_code']),
  );
}

/// A live alert of the committee with what the server says follows from it.
final class CommitteeAlertLine {
  const CommitteeAlertLine({required this.type, required this.severity, required this.acknowledged, required this.openedOn, this.subjectLabel, this.owner, this.expectedAction, this.consequence, this.acknowledgedBy});

  final CommitteeAlertType type;
  final CommitteeSeverity severity;
  final bool acknowledged;
  final String openedOn;
  final String? subjectLabel;
  final String? owner;
  final String? expectedAction;
  final String? consequence;
  final String? acknowledgedBy;
}

CommitteeAlertLine? _alertLine(Object? raw) {
  final Json? row = asRecord(raw);
  final CommitteeAlertType? type = parseCommitteeAlertType(row?['alert_type']);
  final CommitteeSeverity? severity = parseCommitteeSeverity(row?['severity']);
  final Object? status = row?['status'];
  final String? opened = filled(row?['opened_on']);
  if (row == null || type == null || severity == null || opened == null || (status != 'OPEN' && status != 'ACKNOWLEDGED')) return null;
  return CommitteeAlertLine(
    type: type,
    severity: severity,
    acknowledged: status == 'ACKNOWLEDGED',
    openedOn: opened,
    subjectLabel: filled(row['subject_label']),
    owner: filled(row['owner']),
    expectedAction: filled(row['expected_action']),
    consequence: filled(row['consequence']),
    acknowledgedBy: filled(row['acknowledged_by_name']),
  );
}

/// The rule the colours and the curve come from, with the flag when its numbers are not yet confirmed.
final class CommitteePolicy {
  const CommitteePolicy({required this.code, required this.unverified, this.version});

  final String code;
  final int? version;
  final bool unverified;
}

/// The committee dashboard: the workspace the card reads plus everything the full screen adds.
final class CommitteeDashboard {
  const CommitteeDashboard({
    required this.workspace,
    required this.rows,
    required this.attentionTotal,
    required this.projects,
    required this.unitsNotReporting,
    required this.directives,
    required this.alerts,
    required this.basis,
    this.reference,
    this.policy,
  });

  final CommitteeWorkspace workspace;
  final Map<CommitteeDimension, List<CommitteeRow>> rows;
  final int attentionTotal;
  final List<CommitteeProject> projects;
  final List<CommitteeUnit> unitsNotReporting;
  final CommitteeDirectives? directives;
  final List<CommitteeAlertLine> alerts;

  /// `DIS_SNAPSHOT` (a frozen snapshot of the plan) or `CORE_LIVE`, and the reference of the delivery, so a reader knows what the day stands on.
  final String basis;
  final String? reference;
  final CommitteePolicy? policy;

  /// The attention list cut short: the screen says how many more there are.
  int get attentionMore => attentionTotal > projects.length ? attentionTotal - projects.length : 0;
}

/// The dashboard from the answer of `getCommitteeWorkspace`, or null when the answer lacks what the card needs (the screen then says the answer does not
/// match the contract). A row, project, unit or alert that cannot be read is left out; the totals the server gave stay, so the screen never claims the
/// list is whole when it is not.
CommitteeDashboard? parseCommitteeDashboard(Object? raw) {
  final CommitteeWorkspace? workspace = parseCommitteeWorkspace(raw);
  final Json? row = asRecord(raw);
  final Json? feed = asRecord(row?['feed']);
  final String? basis = filled(feed?['basis']);
  if (workspace == null || row == null || basis == null) return null;
  final Json? policy = asRecord(row['policy']);
  final String? policyCode = filled(policy?['code']);
  return CommitteeDashboard(
    workspace: workspace,
    rows: <CommitteeDimension, List<CommitteeRow>>{
      for (final MapEntry<CommitteeDimension, String> entry in _rowKeys.entries)
        entry.key: <CommitteeRow>[
          for (final Object? one in listOf(row[entry.value])) ?_row(one),
        ],
    },
    attentionTotal: count(row['attention_total']),
    projects: <CommitteeProject>[
      for (final Object? one in listOf(row['attention'])) ?_project(one),
    ]..sort((CommitteeProject a, CommitteeProject b) => a.rank.compareTo(b.rank)),
    unitsNotReporting: <CommitteeUnit>[
      for (final Object? one in listOf(row['units'])) ?_unit(one),
    ],
    directives: _directives(row['directives']),
    alerts: <CommitteeAlertLine>[
      for (final Object? one in listOf(row['alerts'])) ?_alertLine(one),
    ],
    basis: basis,
    reference: filled(feed?['reference']),
    policy: policyCode == null ? null : CommitteePolicy(code: policyCode, version: whole(policy?['version']), unverified: policy?['unverified'] == true),
  );
}
