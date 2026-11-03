import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/paged.dart';
import '../read_support/wire.dart';

/// The statuses of a letter the handler can still act on: assigned, or being worked on.
const List<String> kHandlingStatuses = <String>['ASSIGNED', 'PROCESSING'];

/// The statuses a letter has on the server (`doc_incoming.status`).
const List<String> kIncomingStatuses = <String>['RECEIVED', 'REGISTERED', 'ASSIGNED', 'PROCESSING', 'RESOLVED', 'FILED', 'REJECTED'];

const List<String> kUrgencies = <String>['NORMAL', 'KHAN', 'THUONG_KHAN', 'HOA_TOC'];

/// One entry of the history of assignments of a letter.
final class IncomingAssignment {
  const IncomingAssignment({required this.unitName, required this.assignedAt, this.assignee, this.directive, this.dueOn});

  final String unitName;
  final String? assignee;
  final String? directive;
  final String? dueOn;
  final String assignedAt;
}

/// One incoming letter as the phone shows it (`listIncomingDocuments`, `getIncomingDocument`). The two flags [canStart] and
/// [canResolve] are the server's answer for this reader (the right, the scope of the unit and who the handler is); the phone offers
/// exactly those buttons and the server judges each command again.
final class IncomingLetter {
  const IncomingLetter({
    required this.id,
    required this.status,
    required this.title,
    required this.version,
    required this.receivedAt,
    required this.canStart,
    required this.canResolve,
    this.docTypeCode = '',
    this.senderName = '',
    this.urgency = 'NORMAL',
    this.number,
    this.symbol,
    this.originalSymbol,
    this.dueOn,
    this.leaderDirective,
    this.assigneeUserId,
    this.assigneeName,
    this.assignedUnitName,
    this.resolutionSummary,
    this.resolvedAt,
    this.lateDays,
    this.overdueDays,
    this.fileSha256,
    this.assignments = const <IncomingAssignment>[],
  });

  final String id;
  final String status;
  final String title;
  final String docTypeCode;
  final String senderName;
  final String urgency;
  final int version;
  final String receivedAt;

  /// The number the letter was registered under, with its symbol when it has one.
  final int? number;
  final String? symbol;
  final String? originalSymbol;

  /// The deadline, `YYYY-MM-DD`; the phone never judges it with its own clock, it shows what the server says (`overdue_days`).
  final String? dueOn;
  final String? leaderDirective;
  final String? assigneeUserId;
  final String? assigneeName;
  final String? assignedUnitName;
  final String? resolutionSummary;
  final String? resolvedAt;
  final int? lateDays;

  /// How many days past the deadline the server counts, when the letter is overdue now.
  final int? overdueDays;

  /// The fingerprint of the file the letter came with. The file itself is not read on the phone.
  final String? fileSha256;
  final bool canStart;
  final bool canResolve;
  final List<IncomingAssignment> assignments;

  bool get isHandling => kHandlingStatuses.contains(status);

  bool get isOverdue => overdueDays != null && dueOn != null;

  /// `10 · 10/REG-DEN-2026`: the number and the symbol it was registered under.
  String? get numberLabel => number == null ? null : (symbol == null ? '$number' : '$number · $symbol');
}

IncomingLetter? parseLetter(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? status = filled(row?['status']);
  final String? receivedAt = filled(row?['received_at']);
  final int? version = whole(row?['version']);
  if (row == null || id == null || status == null || !kIncomingStatuses.contains(status) || receivedAt == null || version == null) return null;
  final Json? assignee = asRecord(row['assignee']);
  final Json? unit = asRecord(row['assigned_unit']);
  final Json? actions = asRecord(row['actions']);
  final String urgency = filled(row['urgency']) ?? 'NORMAL';
  return IncomingLetter(
    id: id,
    status: status,
    title: text(row['title']) ?? '',
    docTypeCode: text(row['doc_type_code']) ?? '',
    senderName: text(row['sender_name']) ?? '',
    urgency: kUrgencies.contains(urgency) ? urgency : 'NORMAL',
    version: version,
    receivedAt: receivedAt,
    number: whole(row['number']),
    symbol: filled(row['symbol']),
    originalSymbol: filled(row['original_symbol']),
    dueOn: day(row['due_on']),
    leaderDirective: filled(row['leader_directive']),
    assigneeUserId: filled(assignee?['user_id']),
    assigneeName: filled(assignee?['display_name']),
    assignedUnitName: filled(unit?['name']),
    resolutionSummary: filled(row['resolution_summary']),
    resolvedAt: filled(row['resolved_at']),
    lateDays: whole(row['late_days']),
    overdueDays: whole(row['overdue_days']),
    fileSha256: filled(row['file_sha256']),
    canStart: actions?['startProcessing'] == true,
    canResolve: actions?['resolve'] == true,
    assignments: <IncomingAssignment>[
      for (final Object? item in listOf(row['assignments']))
        if (_assignment(item) case final IncomingAssignment entry) entry,
    ],
  );
}

IncomingAssignment? _assignment(Object? raw) {
  final Json? row = asRecord(raw);
  final String? assignedAt = filled(row?['assigned_at']);
  if (row == null || assignedAt == null) return null;
  final Json? who = asRecord(row['assignee']);
  return IncomingAssignment(
    unitName: filled(asRecord(row['assigned_unit'])?['name']) ?? '',
    assignee: filled(who?['display_name']) ?? filled(who?['user_id']),
    directive: filled(row['leader_directive']),
    dueOn: day(row['due_on']),
    assignedAt: assignedAt,
  );
}

/// The letters of the reader that wait for handling, read from the two statuses that can be handled, and whether the server has more
/// than the pages that were read.
final class IncomingList {
  const IncomingList({required this.letters, required this.more, this.asOf});

  final List<IncomingLetter> letters;
  final bool more;
  final String? asOf;
}

IncomingList? parseIncomingList(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  return IncomingList(
    letters: <IncomingLetter>[
      for (final Object? item in listOf(body['items']))
        if (parseLetter(item) case final IncomingLetter letter) letter,
    ],
    more: body['more'] == true,
    asOf: filled(body['as_of']),
  );
}

/// How many pages of each status one read follows: a handler has a few letters, and more than this is said, not hidden.
const int kLetterPages = 4;

/// Reads the assigned and the processing letters (the server filters on one status at a time) and joins them into one answer.
Future<Json> readLettersToHandle(MachvonApiClient client) async {
  final List<Json> answers = await Future.wait(<Future<Json>>[
    for (final String status in kHandlingStatuses)
      readMerged(client, 'listIncomingDocuments', query: <String, Object?>{'status': status, 'limit': 50}, maxPages: kLetterPages),
  ]);
  return <String, Object?>{
    'items': <Object?>[for (final Json answer in answers) ...listOf(answer['items'])],
    'more': answers.any((Json answer) => answer['next_cursor'] != null),
    'as_of': answers.first['as_of'],
  };
}

/// The letters this reader handles: assigned or being processed, and theirs, either because the letter names the reader as its
/// handler or because the server says the reader may start or resolve it. The late ones first, the most days late first, then by deadline
/// (a letter with no deadline last), then the newest.
List<IncomingLetter> lettersToHandle(Iterable<IncomingLetter> letters, String? membershipId) {
  final List<IncomingLetter> mine = <IncomingLetter>[
    for (final IncomingLetter letter in letters)
      if (letter.isHandling && ((membershipId != null && letter.assigneeUserId == membershipId) || letter.canStart || letter.canResolve)) letter,
  ];
  mine.sort((IncomingLetter a, IncomingLetter b) {
    final int late = (b.overdueDays ?? 0).compareTo(a.overdueDays ?? 0);
    if (late != 0) return late;
    final int due = (a.dueOn ?? '9999-12-31').compareTo(b.dueOn ?? '9999-12-31');
    return due != 0 ? due : b.receivedAt.compareTo(a.receivedAt);
  });
  return mine;
}
