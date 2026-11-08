import '../read_support/wire.dart';

/// The statistics of one node of the progress tree (`getPackageProcessTreeNode`): how long the packages stay, how many are late, stalled,
/// held or without an owner, who holds most of them, which required items are still open, and how many packages arrived and left each week.
/// Every figure is the server's count; the phone adds nothing up. A part the server leaves out stays null or empty, never zero.

final class PrcTopOwner {
  const PrcTopOwner({required this.name, required this.count});

  final String name;
  final int count;
}

final class PrcUnfinishedItem {
  const PrcUnfinishedItem({required this.stepCode, required this.itemCode, required this.count, this.name});

  final String stepCode;
  final String itemCode;
  final String? name;
  final int count;

  /// What is shown: the name when the definition has one, else the code.
  String get label => name ?? itemCode;
}

final class PrcWeek {
  const PrcWeek({required this.weekOf, required this.arrivals, required this.departures});

  final String weekOf;
  final int arrivals;
  final int departures;
}

final class PrcNodeStats {
  const PrcNodeStats({
    required this.nodeId,
    required this.count,
    required this.lateCount,
    required this.asOf,
    this.medianDays,
    this.longestDays,
    this.shortestDays,
    this.working,
    this.stalledCount,
    this.heldCount,
    this.noOwnerCount,
    this.topOwners = const <PrcTopOwner>[],
    this.unfinished = const <PrcUnfinishedItem>[],
    this.weeks = const <PrcWeek>[],
    this.truncated = false,
  });

  final String nodeId;
  final int count;
  final int lateCount;
  final String asOf;
  final double? medianDays;
  final int? longestDays;
  final int? shortestDays;

  /// True when the days are working days, false when calendar days, null when the server did not say.
  final bool? working;
  final int? stalledCount;
  final int? heldCount;
  final int? noOwnerCount;
  final List<PrcTopOwner> topOwners;
  final List<PrcUnfinishedItem> unfinished;
  final List<PrcWeek> weeks;

  /// The server cut the lists short: the screen says so instead of presenting them as complete.
  final bool truncated;

  bool get hasDays => medianDays != null || longestDays != null || shortestDays != null;
}

double? _number(Object? value) => value is num ? value.toDouble() : null;

PrcNodeStats? parsePrcNodeStats(Object? raw) {
  final Json? row = asRecord(raw);
  final String? nodeId = filled(row?['node_id']);
  final int? total = whole(row?['count']);
  final int? late = whole(row?['late_count']);
  final String? asOf = filled(row?['as_of']);
  if (row == null || nodeId == null || total == null || late == null || asOf == null) return null;
  final Object? basis = row['basis'];
  return PrcNodeStats(
    nodeId: nodeId,
    count: total,
    lateCount: late,
    asOf: asOf,
    medianDays: _number(row['median_days']),
    longestDays: whole(row['longest_days']),
    shortestDays: whole(row['shortest_days']),
    working: basis == 'WORKING_DAYS' ? true : (basis == 'CALENDAR_DAYS' ? false : null),
    stalledCount: whole(row['stalled_count']),
    heldCount: whole(row['held_count']),
    noOwnerCount: whole(row['no_owner_count']),
    topOwners: <PrcTopOwner>[
      for (final Object? entry in listOf(row['top_owners']))
        if (filled(asRecord(entry)?['name']) case final String name) PrcTopOwner(name: name, count: count(asRecord(entry)?['count'])),
    ],
    unfinished: <PrcUnfinishedItem>[
      for (final Object? entry in listOf(row['unfinished_items']))
        if (filled(asRecord(entry)?['item_code']) case final String itemCode)
          PrcUnfinishedItem(stepCode: filled(asRecord(entry)?['step_code']) ?? '', itemCode: itemCode, name: filled(asRecord(entry)?['name']), count: count(asRecord(entry)?['count'])),
    ],
    weeks: <PrcWeek>[
      for (final Object? entry in listOf(row['weeks']))
        if (filled(asRecord(entry)?['week_of']) case final String weekOf) PrcWeek(weekOf: weekOf, arrivals: count(asRecord(entry)?['arrivals']), departures: count(asRecord(entry)?['departures'])),
    ],
    truncated: row['truncated'] == true,
  );
}
