import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/widgets/figure_info.dart';
import '../read_support/wire.dart';

/// The permission that opens the committee workspace over the whole tenant; the server judges it again on every request and answers
/// 403 `SCOPE_DENIED` to a reader who does not hold it.
const String committeeReadPermission = 'committee.read';

/// The ten figures of the workspace, each a definition of the register with its own "i".
const String committeePlanMetric = 'COMMITTEE_PLAN_TOTAL';
const String committeeDisbursedMetric = 'COMMITTEE_DISBURSED';
const String committeeRateMetric = 'COMMITTEE_DISBURSEMENT_RATE';
const String committeeLastYearMetric = 'COMMITTEE_DISBURSED_LAST_YEAR';
const String committeeGapMetric = 'COMMITTEE_GAP_VS_CURVE';
const String committeeOutlookLowMetric = 'COMMITTEE_OUTLOOK_LOW';
const String committeeOutlookHighMetric = 'COMMITTEE_OUTLOOK_HIGH';
const String committeeAttentionMetric = 'COMMITTEE_ATTENTION_PROJECTS';
const String committeeUnitsMetric = 'COMMITTEE_UNITS_NOT_REPORTING';
const String committeeDirectivesMetric = 'COMMITTEE_DIRECTIVES_OVERDUE';

/// How many attention items the phone lists; the full list is a screen of the computer.
const int committeeAttentionShown = 3;

/// How many open alerts the phone lists; the rest are counted.
const int committeeAlertsShown = 5;

enum CommitteeFigureUnit { percent, vnd, count }

enum CommitteeRag { red, amber, green, noData }

enum CommitteeSeverity { urgent, action, watch }

enum CommitteeReason { delayed, stalled, overBudget, farBelow, notReporting }

enum CommitteeAlertType { provinceBehind, sectorBehind, unitNotReporting, directiveOverdue }

/// One figure as the server wrote it: the text it gave, the reason when it has no value, the flags that sit on it and the definition behind it (the "i").
/// A figure that has no value is never read as zero.
final class CommitteeFigure {
  const CommitteeFigure({required this.metricCode, required this.unit, this.value, this.displayValue, this.nullReason, this.flags = const <String>[], this.info});

  final String metricCode;
  final CommitteeFigureUnit unit;
  final String? value;
  final String? displayValue;
  final String? nullReason;
  final List<String> flags;
  final FigureInfo? info;

  bool get hasValue => value != null;
  bool get isStale => flags.contains('STALE');
}

/// The year-end band of the province.
final class CommitteeOutlook {
  const CommitteeOutlook({required this.thin, this.lowPct, this.highPct, this.reason});

  final String? lowPct;
  final String? highPct;
  final bool thin;

  /// `NO_DATA` or `NO_PLAN` when there is no band.
  final String? reason;
}

/// What the province row adds to the figures: the colour, the curve of today, how many lines have a figure of last year and the band.
final class CommitteeProvince {
  const CommitteeProvince({required this.rag, required this.expectedPct, required this.outlook, required this.lastYearKnown, required this.lastYearTotal, required this.unknownLines});

  final CommitteeRag rag;
  final String expectedPct;
  final CommitteeOutlook outlook;
  final int lastYearKnown;
  final int lastYearTotal;
  final int unknownLines;
}

/// One project of the attention list: its code, its name and why, in the order the rules gave the reasons.
final class CommitteeAttention {
  const CommitteeAttention({required this.rank, required this.code, required this.name, required this.reasons});

  final int rank;
  final String code;
  final String name;
  final List<CommitteeReason> reasons;
}

/// One live alert of the committee: what it is about and how severe.
final class CommitteeAlert {
  const CommitteeAlert({required this.type, required this.severity, this.subjectLabel});

  final CommitteeAlertType type;
  final CommitteeSeverity severity;
  final String? subjectLabel;
}

/// The committee workspace of the head of the steering committee (`getCommitteeWorkspace`), cut to what the phone shows.
final class CommitteeWorkspace {
  const CommitteeWorkspace({
    required this.asOf,
    required this.fiscalYear,
    required this.feedEmpty,
    required this.figures,
    required this.province,
    required this.attentionTotal,
    required this.attention,
    required this.alerts,
  });

  final String asOf;
  final int fiscalYear;

  /// Nothing has been loaded into the core yet: every figure would read "no data" and the screen says so once.
  final bool feedEmpty;
  final List<CommitteeFigure> figures;
  final CommitteeProvince province;
  final int attentionTotal;
  final List<CommitteeAttention> attention;

  /// The alerts that are open or acknowledged, in the order of the server.
  final List<CommitteeAlert> alerts;

  CommitteeFigure? figure(String metric) {
    for (final CommitteeFigure figure in figures) {
      if (figure.metricCode == metric) return figure;
    }
    return null;
  }

  /// The server judged a figure too old for the lag its definition allows (the phone's clock is not asked).
  bool get isStale => figures.any((CommitteeFigure figure) => figure.isStale);
}

CommitteeFigureUnit? _unit(Object? value) {
  switch (value) {
    case 'PERCENT':
      return CommitteeFigureUnit.percent;
    case 'VND':
      return CommitteeFigureUnit.vnd;
    case 'COUNT':
      return CommitteeFigureUnit.count;
    default:
      return null;
  }
}

CommitteeFigure? _figure(Object? raw) {
  final Json? row = asRecord(raw);
  final String? metric = filled(row?['metric_code']);
  final CommitteeFigureUnit? unit = _unit(row?['unit']);
  if (row == null || metric == null || unit == null) return null;
  return CommitteeFigure(
    metricCode: metric,
    unit: unit,
    value: text(row['value']),
    displayValue: text(row['display_value']),
    nullReason: text(row['null_reason']),
    flags: <String>[for (final Object? flag in listOf(row['flags'])) if (filled(flag) != null) flag! as String],
    info: FigureInfo.parse(row['kpi']),
  );
}

CommitteeRag? _rag(Object? value) {
  switch (value) {
    case 'RED':
      return CommitteeRag.red;
    case 'AMBER':
      return CommitteeRag.amber;
    case 'GREEN':
      return CommitteeRag.green;
    case 'NO_DATA':
      return CommitteeRag.noData;
    default:
      return null;
  }
}

CommitteeReason? _reason(Object? value) {
  switch (value) {
    case 'DELAYED':
      return CommitteeReason.delayed;
    case 'STALLED_PROCEDURE':
      return CommitteeReason.stalled;
    case 'OVER_BUDGET_RISK':
      return CommitteeReason.overBudget;
    case 'DISBURSEMENT_FAR_BELOW_PLAN':
      return CommitteeReason.farBelow;
    case 'UNIT_NOT_REPORTING':
      return CommitteeReason.notReporting;
    default:
      return null;
  }
}

CommitteeSeverity? _severity(Object? value) {
  switch (value) {
    case 'URGENT':
      return CommitteeSeverity.urgent;
    case 'ACTION':
      return CommitteeSeverity.action;
    case 'WATCH':
      return CommitteeSeverity.watch;
    default:
      return null;
  }
}

CommitteeAlertType? _alertType(Object? value) {
  switch (value) {
    case 'COMMITTEE_PROVINCE_BEHIND':
      return CommitteeAlertType.provinceBehind;
    case 'COMMITTEE_SECTOR_BEHIND':
      return CommitteeAlertType.sectorBehind;
    case 'COMMITTEE_UNIT_NOT_REPORTING':
      return CommitteeAlertType.unitNotReporting;
    case 'COMMITTEE_DIRECTIVE_OVERDUE':
      return CommitteeAlertType.directiveOverdue;
    default:
      return null;
  }
}

CommitteeProvince? _province(Object? raw) {
  final Json? row = asRecord(raw);
  final CommitteeRag? rag = _rag(row?['rag']);
  final String? expected = filled(row?['expected_pct']);
  final Json? outlook = asRecord(row?['outlook']);
  final Json? coverage = asRecord(row?['last_year_coverage']);
  if (row == null || rag == null || expected == null || outlook == null) return null;
  return CommitteeProvince(
    rag: rag,
    expectedPct: expected,
    outlook: CommitteeOutlook(lowPct: text(outlook['low_pct']), highPct: text(outlook['high_pct']), thin: outlook['thin'] == true, reason: text(outlook['reason'])),
    lastYearKnown: count(coverage?['known']),
    lastYearTotal: count(coverage?['total']),
    unknownLines: count(row['unknown_lines']),
  );
}

CommitteeAttention? _attention(Object? raw) {
  final Json? row = asRecord(raw);
  final String? code = filled(row?['code']);
  final String? name = filled(row?['name']);
  final int? rank = whole(row?['rank']);
  if (row == null || code == null || name == null || rank == null) return null;
  final List<CommitteeReason> reasons = <CommitteeReason>[];
  for (final Object? signal in listOf(row['signals'])) {
    final CommitteeReason? reason = _reason(asRecord(signal)?['reason']);
    if (reason != null && !reasons.contains(reason)) reasons.add(reason);
  }
  return CommitteeAttention(rank: rank, code: code, name: name, reasons: reasons);
}

/// An alert that is still open; a resolved one is history and is not a live alert.
CommitteeAlert? _alert(Object? raw) {
  final Json? row = asRecord(raw);
  final CommitteeAlertType? type = _alertType(row?['alert_type']);
  final CommitteeSeverity? severity = _severity(row?['severity']);
  final String? status = text(row?['status']);
  if (row == null || type == null || severity == null || status == null) return null;
  if (status == 'RESOLVED') return null;
  return CommitteeAlert(type: type, severity: severity, subjectLabel: filled(row['subject_label']));
}

/// The workspace from the answer of the server, or null when the answer lacks what the card needs (the screen then says the answer does not match the
/// contract instead of drawing half a card).
CommitteeWorkspace? parseCommitteeWorkspace(Object? raw) {
  final Json? row = asRecord(raw);
  final String? asOf = filled(row?['as_of']);
  final int? year = whole(row?['fiscal_year']);
  final Json? feed = asRecord(row?['feed']);
  final CommitteeProvince? province = _province(row?['province']);
  if (row == null || asOf == null || year == null || feed == null || province == null) return null;
  final List<CommitteeAttention> attention = <CommitteeAttention>[for (final Object? item in listOf(row['attention'])) ?_attention(item)]
    ..sort((CommitteeAttention a, CommitteeAttention b) => a.rank.compareTo(b.rank));
  return CommitteeWorkspace(
    asOf: asOf,
    fiscalYear: year,
    feedEmpty: feed['empty'] == true,
    figures: <CommitteeFigure>[for (final Object? figure in listOf(row['figures'])) ?_figure(figure)],
    province: province,
    attentionTotal: count(row['attention_total']),
    attention: attention.take(committeeAttentionShown).toList(),
    alerts: <CommitteeAlert>[for (final Object? alert in listOf(row['alerts'])) ?_alert(alert)],
  );
}

/// One read of the workspace. The server writes a row of the audit of views for every one, so this is called once when the card opens and once for
/// each explicit refresh, never on a timer and never on resume.
Future<Object?> readCommitteeWorkspace(MachvonApiClient client) => client.getCommitteeWorkspace();

/// Whether a refusal of the workspace means "this reader is not on the committee": the card is then not drawn. `SCOPE_DENIED` is the code of the
/// workspace; `PERMISSION_DENIED` is the generic one; an older server that does not know the operation says 404.
bool isCommitteeRefusal(ApiError error) => (error.status == 403 && (error.code == 'SCOPE_DENIED' || error.code == 'PERMISSION_DENIED')) || error.status == 404;

/// The people (tenant and user) the server has already refused the workspace to in this run of the application: the card is not drawn for them again
/// and no further request is made, so a leader who is not on the committee does not ask on every opening of the home. A new run asks again, so a role
/// granted later is seen at the next start.
final NotifierProvider<CommitteeRefusals, Set<String>> committeeRefusalsProvider = NotifierProvider<CommitteeRefusals, Set<String>>(CommitteeRefusals.new);

class CommitteeRefusals extends Notifier<Set<String>> {
  @override
  Set<String> build() => const <String>{};

  void remember(String who) => state = <String>{...state, who};
}

// ---- the words of the workspace that the full dashboard (MOB-72) reads again --------------------------------------------------

/// The colour of a row as the server wrote it, or null for a word this phone does not know.
CommitteeRag? parseCommitteeRag(Object? value) => _rag(value);

/// The reason a project needs attention, or null for a reason this phone does not know.
CommitteeReason? parseCommitteeReason(Object? value) => _reason(value);

/// The severity of a committee alert, or null.
CommitteeSeverity? parseCommitteeSeverity(Object? value) => _severity(value);

/// The type of a committee alert, or null.
CommitteeAlertType? parseCommitteeAlertType(Object? value) => _alertType(value);

/// One figure of the workspace with its definition (the "i"), or null when it lacks its code or its unit.
CommitteeFigure? parseCommitteeFigure(Object? raw) => _figure(raw);
