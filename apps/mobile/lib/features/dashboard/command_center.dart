import '../read_support/wire.dart';

/// The permission that opens the home reads; the server judges it again on every request.
const String homeReadPermission = 'home.read';

/// The terms the formulas are proposals under until the business owner signs them (CXN-03), as on the web.
const String formulaReference = 'CXN-03';

const String ratePmMetric = 'DISBURSEMENT_RATE_PM';
const String rateTotalMetric = 'DISBURSEMENT_RATE_TOTAL';

enum TileUnit { percent, vnd }

enum QualityBadge { notAssessed, ok, warn, fail }

/// One figure of the command center with what makes it citable: its numerator and denominator, its formula and its
/// signed token. A figure that is missing says why; it is never shown as zero.
final class Tile {
  const Tile({
    required this.metricCode,
    required this.unit,
    required this.formula,
    required this.definitionStatus,
    this.value,
    this.numerator,
    this.denominator,
    this.nullReason,
  });

  final String metricCode;
  final String? value;
  final String? numerator;
  final String? denominator;
  final String? nullReason;
  final TileUnit unit;
  final String formula;
  final String definitionStatus;

  bool get hasSums => numerator != null && denominator != null;

  bool get isSigned => definitionStatus == 'SIGNED';
}

/// The command center of the leader (`getCommandCenter`): the two disbursement rates of one frozen snapshot, the amounts
/// beside them and what waits.
final class CommandCenter {
  const CommandCenter({
    required this.snapshotId,
    required this.asOfDate,
    required this.treasuryCutoffDate,
    required this.isStale,
    required this.scopeProjects,
    required this.tiles,
    required this.projectsWithoutData,
    required this.openWarnings,
    required this.overdueExplanations,
    required this.pendingReallocations,
    required this.qualityBadge,
    this.scopeUnitId,
  });

  final String snapshotId;
  final String asOfDate;
  final String treasuryCutoffDate;

  /// The server judged the snapshot too old (more than eight days); the phone's clock is not asked.
  final bool isStale;
  final String? scopeUnitId;
  final int scopeProjects;
  final List<Tile> tiles;
  final int projectsWithoutData;
  final int openWarnings;
  final int overdueExplanations;
  final int pendingReallocations;
  final QualityBadge qualityBadge;

  Tile? _tile(String code) {
    for (final Tile tile in tiles) {
      if (tile.metricCode == code) return tile;
    }
    return null;
  }

  /// The two rates, always together: either both are there or neither is shown as a pair.
  ({Tile pm, Tile total})? get ratePair {
    final Tile? pm = _tile(ratePmMetric);
    final Tile? total = _tile(rateTotalMetric);
    return pm == null || total == null ? null : (pm: pm, total: total);
  }

  /// The tiles that are amounts, in the order the server gave them.
  List<Tile> get amountTiles => <Tile>[for (final Tile tile in tiles) if (tile.unit == TileUnit.vnd) tile];
}

Tile? _tile(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null) return null;
  final String? unit = text(row['unit']);
  final String? metric = filled(row['metric_code']);
  final String? formula = filled(row['formula']);
  // A tile without its formula, unit or token is not a citable figure (BR-HOME-01): it is not shown.
  if ((unit != 'PERCENT' && unit != 'VND') || metric == null || formula == null || filled(row['context_token']) == null) return null;
  return Tile(
    metricCode: metric,
    unit: unit == 'PERCENT' ? TileUnit.percent : TileUnit.vnd,
    formula: formula,
    definitionStatus: text(row['definition_status']) ?? '',
    value: text(row['value']),
    numerator: text(row['numerator']),
    denominator: text(row['denominator']),
    nullReason: text(row['null_reason']),
  );
}

QualityBadge _badge(Object? value) {
  switch (value) {
    case 'OK':
      return QualityBadge.ok;
    case 'WARN':
      return QualityBadge.warn;
    case 'FAIL':
      return QualityBadge.fail;
    default:
      return QualityBadge.notAssessed;
  }
}

/// The command center, or null when the answer lacks what makes a figure citable: the snapshot, the day, the scope or the
/// definition.
CommandCenter? parseCommandCenter(Object? raw) {
  final Json? row = asRecord(raw);
  final Json? scope = asRecord(row?['scope']);
  if (row == null || scope == null) return null;
  final String? freshness = text(row['freshness']);
  final String? snapshotId = filled(row['snapshot_id']);
  final String? asOfDate = filled(row['as_of_date']);
  if ((freshness != 'FRESH' && freshness != 'STALE') || snapshotId == null || asOfDate == null || filled(row['definition_status']) == null) return null;
  return CommandCenter(
    snapshotId: snapshotId,
    asOfDate: asOfDate,
    treasuryCutoffDate: text(row['treasury_cutoff_date']) ?? '',
    isStale: freshness == 'STALE',
    scopeUnitId: filled(scope['unit_id']),
    scopeProjects: count(scope['projects']),
    tiles: <Tile>[for (final Object? tile in listOf(row['tiles'])) ?_tile(tile)],
    projectsWithoutData: count(row['projects_without_data']),
    openWarnings: count(row['open_warnings']),
    overdueExplanations: count(row['overdue_explanations']),
    pendingReallocations: count(row['pending_reallocations']),
    qualityBadge: _badge(row['quality_badge']),
  );
}
