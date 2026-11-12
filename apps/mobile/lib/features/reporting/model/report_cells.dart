import '../../../core/format/format.dart';

/// The three sources of money a report speaks of: the year plan, the plan carried over from the year before, and the other
/// sources (DIS 3 F1 step 4). Each source has a central and a local budget, which makes the six cells of the paper form.
const List<String> kBuckets = <String>['CURRENT_YEAR', 'CARRYOVER', 'OTHER'];
const List<String> kLevels = <String>['CENTRAL', 'LOCAL'];

/// How the cumulative cells are read: what arose in the period, from the start of the year, or from the start of the project.
const List<String> kBases = <String>['PERIOD', 'YTD', 'PROJECT_TO_DATE'];

const String kWeekly = 'WEEKLY';
const String kMonthly = 'MONTHLY';

/// One of the six cells: a source and a budget level.
final class CellKey {
  const CellKey(this.bucket, this.level);

  final String bucket;
  final String level;

  /// `CURRENT_YEAR:CENTRAL`, the key of the cell in a form and in the review.
  String get id => '$bucket:$level';

  @override
  bool operator ==(Object other) => other is CellKey && other.bucket == bucket && other.level == level;

  @override
  int get hashCode => Object.hash(bucket, level);
}

/// The six cells in the order of the paper form; the position of a cell is also the index the server names in
/// `funding_lines[i]`.
const List<CellKey> kCells = <CellKey>[
  CellKey('CURRENT_YEAR', 'CENTRAL'),
  CellKey('CURRENT_YEAR', 'LOCAL'),
  CellKey('CARRYOVER', 'CENTRAL'),
  CellKey('CARRYOVER', 'LOCAL'),
  CellKey('OTHER', 'CENTRAL'),
  CellKey('OTHER', 'LOCAL'),
];

/// The two cells of one source.
List<CellKey> cellsOf(String bucket) => <CellKey>[for (final CellKey key in kCells) if (key.bucket == bucket) key];

/// The national target programmes (CTMTQG) are a part of the year plan and of the carried-over plan; the other sources have none.
/// The amount of a programme is a subset of its cell: it is shown inside it and never added to a total (BR-DIS-01).
bool takesCtmtqg(String bucket) => bucket != 'OTHER';

/// The screens that enter one source each (MOB-15 the year plan, MOB-16 the carried-over plan, MOB-17 the other sources).
const Map<String, String> kScreenOfBucket = <String, String>{'CURRENT_YEAR': 'MOB-15', 'CARRYOVER': 'MOB-16', 'OTHER': 'MOB-17'};

/// The digits of an amount typed with or without separators (`1.250.000.000`, `1,250,000,000`, `1 250 000 000`); anything else,
/// a sign and a fraction included, is not an amount of whole dong. The result has no leading zero.
String? digitsOf(String typed) {
  final String compact = typed.trim().replaceAll(RegExp(r'[.,\s]'), '');
  if (!RegExp(r'^[0-9]+$').hasMatch(compact) || compact.length > 24) return null;
  return BigInt.parse(compact).toString();
}

/// The exact value of a typed amount, or zero when it is not an amount (a total counts only what is an amount).
BigInt valueOf(String typed) {
  final String? digits = digitsOf(typed);
  return digits == null ? BigInt.zero : BigInt.parse(digits);
}

/// The exact sum of typed amounts, as whole dong.
String sumTyped(Iterable<String> typed) => sumDong(typed.map((String value) => digitsOf(value) ?? '0'));
