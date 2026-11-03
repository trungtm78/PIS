import '../read_support/wire.dart';

/// The kinds of work the home reads list (`getMyWork`), in the words of the server.
enum WorkKind { approval, explanation, reportReturned, reportDraftOverdue, explanationReview, mneObligation }

enum WorkBucket { overdue, near, later }

const Map<String, WorkKind> _kinds = <String, WorkKind>{
  'APPROVAL': WorkKind.approval,
  'EXPLANATION': WorkKind.explanation,
  'REPORT_RETURNED': WorkKind.reportReturned,
  'REPORT_DRAFT_OVERDUE': WorkKind.reportDraftOverdue,
  'EXPLANATION_REVIEW': WorkKind.explanationReview,
  'MNE_OBLIGATION': WorkKind.mneObligation,
};

const Map<String, WorkBucket> _buckets = <String, WorkBucket>{
  'OVERDUE': WorkBucket.overdue,
  'NEAR': WorkBucket.near,
  'LATER': WorkBucket.later,
};

/// The screen on the web that opens an approval task; on the phone it is MOB-24.
const String approvalTargetScreen = 'ADM-06';

/// One thing asked of the person who opens the home.
final class WorkItem {
  const WorkItem({
    required this.id,
    required this.kind,
    required this.title,
    required this.bucket,
    required this.daysLate,
    required this.targetScreen,
    required this.targetId,
    this.subtitle,
    this.dueOn,
    this.originalDueOn,
  });

  final String id;
  final WorkKind kind;
  final String title;
  final String? subtitle;
  final String? dueOn;
  final String? originalDueOn;
  final WorkBucket bucket;
  final int daysLate;
  final String targetScreen;
  final String targetId;

  /// The due day was moved: the first one is shown too.
  bool get dueMoved => originalDueOn != null && originalDueOn != dueOn;

  /// Only an approval task opens on the phone from here; the other kinds are done in the screen of their own module.
  bool get opensApproval => kind == WorkKind.approval && targetScreen == approvalTargetScreen && targetId.isNotEmpty;
}

final class MyWork {
  const MyWork({required this.items, required this.counts, required this.truncated, this.nextCursor});

  final List<WorkItem> items;

  /// The counts of the whole list, whatever page was read, by kind and under `total` and `overdue`.
  final Map<String, int> counts;
  final bool truncated;
  final String? nextCursor;

  int get total => counts['total'] ?? items.length;
  int get overdue => counts['overdue'] ?? 0;

  int countOf(String key) => counts[key] ?? 0;

  List<WorkItem> inBucket(WorkBucket bucket) => <WorkItem>[for (final WorkItem item in items) if (item.bucket == bucket) item];

  List<WorkItem> ofKinds(Set<WorkKind> kinds) => <WorkItem>[for (final WorkItem item in items) if (kinds.contains(item.kind)) item];
}

WorkItem? _item(Object? raw) {
  final Json? row = asRecord(raw);
  final Json? target = asRecord(row?['target']);
  final WorkKind? kind = _kinds[row?['kind']];
  final WorkBucket? bucket = _buckets[row?['bucket']];
  final String? id = filled(row?['id']);
  final String? screen = filled(target?['screen']);
  if (row == null || kind == null || bucket == null || id == null || screen == null) return null;
  return WorkItem(
    id: id,
    kind: kind,
    title: text(row['title']) ?? '',
    subtitle: filled(row['subtitle']),
    dueOn: filled(row['due_on']),
    originalDueOn: filled(row['original_due_on']),
    bucket: bucket,
    daysLate: count(row['days_late']),
    targetScreen: screen,
    targetId: text(target?['id']) ?? '',
  );
}

/// The work of the person, or null when the answer is not a list of work.
MyWork? parseMyWork(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null || row['items'] is! List) return null;
  final Map<String, int> counts = <String, int>{};
  final Json? rawCounts = asRecord(row['counts']);
  if (rawCounts != null) {
    for (final MapEntry<String, Object?> entry in rawCounts.entries) {
      counts[entry.key] = count(entry.value);
    }
  }
  return MyWork(
    items: <WorkItem>[for (final Object? item in listOf(row['items'])) ?_item(item)],
    counts: counts,
    truncated: row['truncated'] == true,
    nextCursor: filled(row['next_cursor']),
  );
}
