import '../read_support/wire.dart';

/// The two analytics parts of the leader home that the web has beside the command center (lane C of the governance roadmap): the colours of the units
/// with the reasons for each (`getRagReading`, G3-2) and "what changed since last week" (`getHomeChanges`, G3-4). Every reader here is tolerant of
/// what the server sends and strict about what it must not invent: a line with no sentence, a colour with no name or a unit with no id is not shown,
/// and a missing number is never turned into 0.

/// A number as the server sent it (a JSON number, or a decimal text); anything else is no number.
double? numberOf(Object? value) {
  if (value is int) return value.toDouble();
  if (value is double) return value.isFinite ? value : null;
  if (value is String && RegExp(r'^-?\d+(\.\d+)?$').hasMatch(value.trim()))
    return double.tryParse(value.trim());
  return null;
}

// ---- the explainable colours ------------------------------------------------------------------------------------------------------------------

/// The colour of a unit: red, amber, green, or "not enough data" (never green, never a score of 0).
enum RagBand { red, amber, green, noData }

RagBand? ragBandOf(Object? value) {
  switch (value) {
    case 'RED':
      return RagBand.red;
    case 'AMBER':
      return RagBand.amber;
    case 'GREEN':
      return RagBand.green;
    case 'NO_DATA':
      return RagBand.noData;
  }
  return null;
}

/// The factors the rules judge a unit by (their codes are the keys of the rule register); a code the phone has no name for is shown by its code.
const String factorRatePace = 'EWS_RATE_VS_PACE';
const String factorCritical = 'EWS_CRITICAL_WARNINGS';
const String factorOverdue = 'EWS_OVERDUE_EXPLANATIONS';
const String factorNoDataShare = 'EWS_NO_DATA_SHARE';

/// One factor that moved a colour: its value against its line, and what it adds to the score of 100.
final class RagFactor {
  const RagFactor({
    required this.code,
    required this.value,
    required this.band,
    required this.points,
    required this.higherIsBetter,
    required this.green,
    required this.amber,
  });

  final String code;

  /// Null when the factor could not be read (it takes no part in the score).
  final double? value;
  final RagBand band;
  final double points;
  final bool higherIsBetter;
  final double green;
  final double amber;
}

RagFactor? _factor(Object? raw) {
  final Json? row = asRecord(raw);
  final String? code = filled(row?['code']);
  final double? green = numberOf(row?['green']);
  final double? amber = numberOf(row?['amber']);
  if (row == null || code == null || green == null || amber == null)
    return null;
  return RagFactor(
    code: code,
    value: numberOf(row['value']),
    band: ragBandOf(row['band']) ?? RagBand.noData,
    points: numberOf(row['points']) ?? 0,
    higherIsBetter: row['direction'] != 'LOWER_IS_BETTER',
    green: green,
    amber: amber,
  );
}

/// A colour a person put over the colour of the rules, with the reason and the last day. It is shown beside the colour of the rules, never in place of it.
final class RagOverride {
  const RagOverride({
    required this.band,
    required this.reason,
    required this.until,
    required this.by,
  });

  final RagBand band;
  final String reason;
  final String until;
  final String by;
}

RagOverride? _override(Object? raw) {
  final Json? row = asRecord(raw);
  final RagBand? band = ragBandOf(row?['band']);
  if (row == null || band == null || band == RagBand.noData) return null;
  return RagOverride(
    band: band,
    reason: text(row['reason']) ?? '',
    until: text(row['until']) ?? '',
    by: text(row['by']) ?? '',
  );
}

/// The score and colour of the week before.
final class RagWeek {
  const RagWeek({
    required this.weekStart,
    required this.score,
    required this.band,
  });

  final String weekStart;
  final double? score;
  final RagBand band;
}

RagWeek? _week(Object? raw) {
  final Json? row = asRecord(raw);
  final String? start = filled(row?['week_start']);
  if (row == null || start == null) return null;
  return RagWeek(
    weekStart: start,
    score: numberOf(row['score']),
    band: ragBandOf(row['band']) ?? RagBand.noData,
  );
}

/// One unit with its colour and the reasons for it.
final class RagUnit {
  const RagUnit({
    required this.unitId,
    required this.code,
    required this.name,
    required this.band,
    required this.ruleBand,
    required this.score,
    required this.coveragePct,
    required this.reasons,
    this.override,
    this.previous,
  });

  final String unitId;
  final String code;
  final String name;

  /// The colour that is shown: the override while it lasts, else the colour of the rules.
  final RagBand band;
  final RagBand ruleBand;

  /// 0 to 100, the higher the worse; null when there is too little data for a score (never shown as 0).
  final double? score;
  final double? coveragePct;

  /// The one to three factors that moved the colour.
  final List<RagFactor> reasons;
  final RagOverride? override;
  final RagWeek? previous;

  bool get overridden => override != null;

  /// The change of the score against the week before, in points: positive is worse. Null when either week has no score.
  double? get scoreDelta {
    final double? now = score;
    final double? before = previous?.score;
    if (now == null || before == null) return null;
    return ((now - before) * 100).round() / 100;
  }
}

RagUnit? _unit(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['unit_id']);
  final RagBand? shown = ragBandOf(row?['band']);
  // A unit with no colour named is not a unit of this screen: it is neither green nor anything else.
  if (row == null || id == null || shown == null) return null;
  final Json? override = asRecord(row['override']);
  return RagUnit(
    unitId: id,
    code: text(row['code']) ?? '',
    name: text(row['name']) ?? '',
    band: shown,
    ruleBand: ragBandOf(row['rule_band']) ?? shown,
    // No data means no score: a score that arrives with it is not believed (never a 0 beside "not enough data").
    score: shown == RagBand.noData ? null : numberOf(row['score']),
    coveragePct: numberOf(row['coverage_pct']),
    reasons: <RagFactor>[
      for (final Object? factor in listOf(row['reasons'])) ?_factor(factor),
    ].take(3).toList(),
    override: row['overridden'] == true && override != null
        ? _override(override)
        : null,
    previous: _week(row['previous']),
  );
}

/// The colours of the units of the reader: the counts by colour, the units (red first), and the state of the model the colours are judged by.
final class RagReading {
  const RagReading({
    required this.asOfDate,
    required this.weekStart,
    required this.summary,
    required this.units,
    required this.unverified,
    this.minCoveragePct,
    this.scoreGreen,
    this.scoreAmber,
  });

  final String asOfDate;
  final String weekStart;
  final Map<RagBand, int> summary;
  final List<RagUnit> units;

  /// The thresholds are starting values nobody confirmed.
  final bool unverified;
  final double? minCoveragePct;
  final double? scoreGreen;
  final double? scoreAmber;
}

const Map<RagBand, int> _rank = <RagBand, int>{
  RagBand.red: 0,
  RagBand.amber: 1,
  RagBand.noData: 2,
  RagBand.green: 3,
};

/// The colours of the units, or null when the answer is not one (no snapshot named, no list of units).
RagReading? parseRagReading(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null ||
      filled(row['snapshot_id']) == null ||
      row['units'] is! List)
    return null;
  final List<RagUnit> units = <RagUnit>[
    for (final Object? unit in listOf(row['units'])) ?_unit(unit),
  ];
  // Red first, then amber, then the units that cannot be judged yet, then green; the order the server gave is kept inside each colour.
  final List<({RagUnit unit, int index})> indexed =
      <({RagUnit unit, int index})>[
        for (int i = 0; i < units.length; i += 1) (unit: units[i], index: i),
      ]..sort((({RagUnit unit, int index}) a, ({RagUnit unit, int index}) b) {
        final int byBand = _rank[a.unit.band]! - _rank[b.unit.band]!;
        return byBand != 0 ? byBand : a.index - b.index;
      });
  final Json? given = asRecord(row['summary']);
  final Json? model = asRecord(row['model']);
  int summaryOf(String key, RagBand band) =>
      whole(given?[key]) ??
      units.where((RagUnit unit) => unit.band == band).length;
  return RagReading(
    asOfDate: text(row['as_of_date']) ?? '',
    weekStart: text(row['week_start']) ?? '',
    summary: <RagBand, int>{
      RagBand.red: summaryOf('RED', RagBand.red),
      RagBand.amber: summaryOf('AMBER', RagBand.amber),
      RagBand.green: summaryOf('GREEN', RagBand.green),
      RagBand.noData: summaryOf('NO_DATA', RagBand.noData),
    },
    units: <RagUnit>[
      for (final ({RagUnit unit, int index}) entry in indexed) entry.unit,
    ],
    unverified: model?['unverified'] == true,
    minCoveragePct: numberOf(model?['min_coverage_pct']),
    scoreGreen: numberOf(model?['score_green']),
    scoreAmber: numberOf(model?['score_amber']),
  );
}

// ---- what changed since last week --------------------------------------------------------------------------------------------------------------

enum ChangeKind {
  unitsToRed,
  rateChange,
  warningsDelta,
  disbursedWeek,
  overdueDelta,
  noDataDelta,
  unitsRecovered,
}

ChangeKind? changeKindOf(Object? value) {
  switch (value) {
    case 'UNITS_TO_RED':
      return ChangeKind.unitsToRed;
    case 'RATE_CHANGE':
      return ChangeKind.rateChange;
    case 'WARNINGS_DELTA':
      return ChangeKind.warningsDelta;
    case 'DISBURSED_WEEK':
      return ChangeKind.disbursedWeek;
    case 'OVERDUE_DELTA':
      return ChangeKind.overdueDelta;
    case 'NO_DATA_DELTA':
      return ChangeKind.noDataDelta;
    case 'UNITS_RECOVERED':
      return ChangeKind.unitsRecovered;
  }
  return null;
}

/// The numbers each kind of line needs for its sentence.
const Map<ChangeKind, List<String>> changeParams = <ChangeKind, List<String>>{
  ChangeKind.unitsToRed: <String>['count'],
  ChangeKind.unitsRecovered: <String>['count'],
  ChangeKind.rateChange: <String>['from', 'to', 'delta'],
  ChangeKind.warningsDelta: <String>['from', 'to', 'delta'],
  ChangeKind.overdueDelta: <String>['from', 'to', 'delta'],
  ChangeKind.noDataDelta: <String>['from', 'to', 'delta'],
  ChangeKind.disbursedWeek: <String>['amount_vnd'],
};

/// Where a line can be checked (the web opens the screen; the phone says where, and opens what it has).
enum ChangeLink { drill, rag, warnings, myWork, ranking }

ChangeLink? changeLinkOf(Object? value) {
  switch (value) {
    case 'DRILL':
      return ChangeLink.drill;
    case 'RAG':
      return ChangeLink.rag;
    case 'WARNINGS':
      return ChangeLink.warnings;
    case 'MY_WORK':
      return ChangeLink.myWork;
    case 'RANKING':
      return ChangeLink.ranking;
  }
  return null;
}

/// The most lines the block says: a leader reads five, not fifty.
const int maxChangeLines = 5;

/// One sentence the server made by rules.
final class ChangeLine {
  const ChangeLine({
    required this.kind,
    required this.up,
    required this.params,
    required this.link,
  });

  final ChangeKind kind;
  final bool up;

  /// The numbers of the sentence, as the server wrote them (text), keyed by name.
  final Map<String, String> params;
  final ChangeLink link;
}

ChangeLine? _line(Object? raw) {
  final Json? row = asRecord(raw);
  final ChangeKind? kind = changeKindOf(row?['kind']);
  final ChangeLink? link = changeLinkOf(row?['link']);
  final Object? direction = row?['direction'];
  // A line the screen has no sentence for is not said: no number is shown that nobody can read.
  if (row == null ||
      kind == null ||
      link == null ||
      (direction != 'UP' && direction != 'DOWN'))
    return null;
  final Map<String, String> params = <String, String>{};
  final Json? given = asRecord(row['params']);
  if (given != null) {
    for (final MapEntry<String, Object?> entry in given.entries) {
      final Object? value = entry.value;
      if (value is String || value is num) params[entry.key] = value.toString();
    }
  }
  // A sentence whose numbers are not all there is not said (never a placeholder, never a number made up).
  for (final String key in changeParams[kind]!) {
    if ((params[key] ?? '').isEmpty) return null;
  }
  return ChangeLine(
    kind: kind,
    up: direction == 'UP',
    params: params,
    link: link,
  );
}

/// The changes since last week as the block reads them.
final class HomeChanges {
  const HomeChanges({
    required this.weekStart,
    required this.previousWeekStart,
    required this.noPreviousWeek,
    required this.lines,
  });

  final String weekStart;
  final String previousWeekStart;

  /// There is no week before to compare with: it is not "nothing changed".
  final bool noPreviousWeek;
  final List<ChangeLine> lines;
}

/// The changes, or null when the answer is not one (no snapshot named, no list of lines).
HomeChanges? parseHomeChanges(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null ||
      filled(row['snapshot_id']) == null ||
      row['lines'] is! List)
    return null;
  return HomeChanges(
    weekStart: text(row['week_start']) ?? '',
    previousWeekStart: text(row['previous_week_start']) ?? '',
    noPreviousWeek: row['reason'] == 'NO_PREVIOUS_WEEK',
    lines: <ChangeLine>[
      for (final Object? line in listOf(row['lines'])) ?_line(line),
    ].take(maxChangeLines).toList(),
  );
}
