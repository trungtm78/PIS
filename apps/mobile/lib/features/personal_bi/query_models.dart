import '../../core/offline/drafts/decimal.dart';
import '../read_support/money.dart';
import '../read_support/wire.dart';

/// The quality badge DGV gives the data a figure comes from (`quality_badge`).
enum QualityBadge { notAssessed, passed, warning, failed, stale }

const Map<String, QualityBadge> _badgeByWire = <String, QualityBadge>{
  'NOT_ASSESSED': QualityBadge.notAssessed,
  'PASSED': QualityBadge.passed,
  'WARNING': QualityBadge.warning,
  'FAILED': QualityBadge.failed,
  'STALE': QualityBadge.stale,
};

/// Why a figure is missing. A missing figure says why and is never shown as zero.
enum NullReason { noData, notApplicable, restricted, notYetReported }

const Map<String, NullReason> _reasonByWire = <String, NullReason>{
  'NO_DATA': NullReason.noData,
  'NOT_APPLICABLE': NullReason.notApplicable,
  'RESTRICTED': NullReason.restricted,
  'NOT_YET_REPORTED': NullReason.notYetReported,
};

/// One figure of an answer: its value, and for a ratio its numerator and denominator (exact decimals as text).
final class Figure {
  const Figure({this.value, this.numerator, this.denominator, this.nullReason});

  final String? value;
  final String? numerator;
  final String? denominator;
  final NullReason? nullReason;
}

/// One group of an answer: a figure for the value of the dimension the answer was cut by, and the token to go down from it.
final class Group {
  const Group({required this.figure, required this.label, required this.unclassified, this.key, this.drillToken});

  final Figure figure;
  final String? key;
  final String label;
  final bool unclassified;
  final String? drillToken;
}

/// The answer of a query or of a drill, with what BR-BI-04 says every number carries: the period, the snapshot, the quality of the
/// data, whether it came from the cache, and whose scope it is.
final class QueryResult {
  const QueryResult({
    required this.metricId,
    required this.metricCode,
    required this.unit,
    required this.aggregationType,
    required this.asOfPeriod,
    required this.snapshotId,
    required this.badge,
    required this.total,
    required this.children,
    required this.drillToken,
    required this.builtAt,
    this.excludedQuarantineRows = 0,
    this.feedsCertified = true,
    this.newDataAvailable = false,
    this.newerSnapshotId,
    this.yourScope = true,
    this.servedFromCache = false,
    this.dimension,
    this.reconcilesToParent = true,
    this.nonAdditiveReason,
    this.truncated = false,
  });

  final String metricId;
  final String metricCode;

  /// `VND`, `percent`, or a count.
  final String unit;
  final String aggregationType;
  final String asOfPeriod;
  final String snapshotId;
  final QualityBadge badge;
  final int excludedQuarantineRows;
  final bool feedsCertified;

  /// A newer snapshot of the same period was frozen after this answer's snapshot: the figures are still those of [snapshotId].
  final bool newDataAvailable;
  final String? newerSnapshotId;
  final bool yourScope;
  final bool servedFromCache;
  final String builtAt;
  final String? dimension;
  final Figure total;
  final bool reconcilesToParent;
  final String? nonAdditiveReason;
  final bool truncated;
  final List<Group> children;

  /// The token to go down from this answer, and to renew the analysis on the newest snapshot.
  final String drillToken;

  bool get isRatio => aggregationType == 'ratio';

  /// The unit the figures are written in: a ratio is a percentage whatever the metric calls its unit.
  String get shownUnit => isRatio ? 'percent' : unit;
}

Figure? _figureOf(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null) return null;
  return Figure(value: text(row['value']), numerator: text(row['numerator']), denominator: text(row['denominator']), nullReason: _reasonByWire[text(row['null_reason'])]);
}

/// The answer as the screen reads it; an answer that lacks what it needs is not drawn, never guessed.
QueryResult? parseQueryResult(Object? raw) {
  final Json? row = asRecord(raw);
  final Json? metric = asRecord(row?['metric']);
  final Figure? total = _figureOf(row?['total']);
  final QualityBadge? badge = _badgeByWire[text(row?['quality_badge'])];
  final String? asOf = filled(row?['as_of_period']);
  final String? snapshot = filled(row?['snapshot_id']);
  final String? token = filled(row?['drill_token']);
  final String? metricId = filled(metric?['id']);
  if (row == null || metric == null || total == null || badge == null || row['children'] is! List || asOf == null || snapshot == null || token == null || metricId == null) return null;
  final List<Group> groups = <Group>[];
  for (final Object? item in listOf(row['children'])) {
    final Json? group = asRecord(item);
    final Figure? figure = _figureOf(item);
    if (group == null || figure == null) return null;
    final String? key = filled(group['key']);
    groups.add(Group(figure: figure, key: key, label: text(group['label']) ?? key ?? '', unclassified: group['unclassified'] == true, drillToken: filled(group['drill_token'])));
  }
  return QueryResult(
    metricId: metricId,
    metricCode: text(metric['code']) ?? '',
    unit: text(metric['unit']) ?? '',
    aggregationType: text(metric['aggregation_type']) ?? '',
    asOfPeriod: asOf,
    snapshotId: snapshot,
    badge: badge,
    excludedQuarantineRows: count(row['excluded_quarantine_rows']),
    feedsCertified: row['feeds_certified'] != false,
    newDataAvailable: row['new_data_available'] == true,
    newerSnapshotId: filled(row['newer_snapshot_id']),
    yourScope: asRecord(row['scope'])?['label'] != 'FULL_TENANT',
    servedFromCache: row['served_from_cache'] == true,
    builtAt: text(row['built_at']) ?? '',
    dimension: filled(row['dimension']),
    total: total,
    reconcilesToParent: row['reconciles_to_parent'] != false,
    nonAdditiveReason: filled(row['non_additive_reason']),
    truncated: row['truncated'] == true,
    children: groups,
    drillToken: token,
  );
}

/// The first eight characters of an id, which is how a snapshot is named on a screen.
String shortId(String id) => id.length <= 8 ? id : id.substring(0, 8);

/// A ratio as a percentage with two decimals, rounded half up on the exact decimal (never through a float).
String percentText(String value, String language) {
  final Decimal? parsed = Decimal.tryParse(value);
  if (parsed == null) return value;
  final BigInt hundredths = _roundedHundredths(parsed);
  final bool negative = hundredths.isNegative;
  final String digits = hundredths.abs().toString().padLeft(3, '0');
  final String whole = digits.substring(0, digits.length - 2);
  final String mark = language == 'en' ? '.' : ',';
  final String groupedWhole = Decimal.tryParse(whole)!.format(separator: language == 'en' ? ',' : '.', decimalMark: mark);
  return '${negative ? '-' : ''}$groupedWhole$mark${digits.substring(digits.length - 2)}%';
}

BigInt _roundedHundredths(Decimal value) {
  final String plain = value.toPlainString();
  final bool negative = plain.startsWith('-');
  final List<String> parts = (negative ? plain.substring(1) : plain).split('.');
  final String fraction = parts.length > 1 ? parts[1] : '';
  final String padded = fraction.padRight(3, '0');
  BigInt hundredths = BigInt.parse('${parts.first}${padded.substring(0, 2)}');
  if (int.parse(padded[2]) >= 5) hundredths += BigInt.one;
  return negative ? -hundredths : hundredths;
}

/// A figure as it is written: money in dong, a ratio in percent, a count as a number. A figure with no value is [noData] (or
/// the other words for why), never 0.
String figureText(Figure figure, {required String unit, required String language, required String noData, required String notApplicable, required String restricted, required String notYetReported}) {
  final String? value = figure.value;
  if (value == null) {
    switch (figure.nullReason) {
      case NullReason.notApplicable:
        return notApplicable;
      case NullReason.restricted:
        return restricted;
      case NullReason.notYetReported:
        return notYetReported;
      case NullReason.noData:
      case null:
        return noData;
    }
  }
  if (unit == 'percent') return percentText(value, language);
  if (unit == 'VND' && dong(value) != null) return '${formatDong(value, language)} ₫';
  final Decimal? parsed = Decimal.tryParse(value);
  if (parsed == null) return value;
  return parsed.format(separator: language == 'en' ? ',' : '.', decimalMark: language == 'en' ? '.' : ',');
}

/// Whether what a drill found adds up to the cell it started from.
enum DrillCheck { agrees, differs, otherSnapshot, notComparable }

/// The check the person is shown on every step down: the total of the drill is the value of the cell that was tapped, from the same
/// snapshot. A difference is shown, never hidden; a cell with no figure cannot be compared.
DrillCheck drillCheck({required Group cell, required QueryResult from, required QueryResult drill}) {
  if (drill.snapshotId != from.snapshotId) return DrillCheck.otherSnapshot;
  final Figure a = cell.figure;
  final Figure b = drill.total;
  if (a.value == null || b.value == null) return a.value == null && b.value == null ? DrillCheck.agrees : DrillCheck.notComparable;
  if (!_same(a.value, b.value)) return DrillCheck.differs;
  if (from.isRatio && (!_same(a.numerator, b.numerator) || !_same(a.denominator, b.denominator))) return DrillCheck.differs;
  return DrillCheck.agrees;
}

bool _same(String? a, String? b) {
  final Decimal? x = Decimal.tryParse(a);
  final Decimal? y = Decimal.tryParse(b);
  return x != null && y != null ? x == y : a == b;
}
