import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/offline/drafts/local_draft.dart';
import '../../core/offline/queue/queued_command.dart';
import '../read_support/paged.dart';
import '../read_support/wire.dart';
import '../site_diary/diary_models.dart';

/// Where a diary written on this phone stands, from the one that needs the person first to the one that needs nothing.
enum LocalState {
  /// The server holds a different version than the one the diary was written over: the person chooses (MOB-42).
  conflict,

  /// The server refused the diary for good; it stays on the phone until the person corrects or drops it.
  rejected,

  /// The answer was lost: the server may have the diary. It is looked up by its key and never created again.
  unknown,
  sending,

  /// Saved on the phone and waiting for a network.
  queued,

  /// Written on the phone and not yet saved for sending.
  draft,

  /// The server has it.
  sent,
}

/// One diary written on this phone: the draft in the encrypted store, the command that sends it, or both.
final class LocalDiary {
  const LocalDiary({
    required this.key,
    required this.state,
    required this.summary,
    this.draftId,
    this.commandId,
    this.contractId,
    this.recordDate,
    this.errorCode,
    this.photos = 0,
  });

  /// The id of the draft, else of the command: stable for a row.
  final String key;
  final LocalState state;

  /// The start of what was written for the day, so the person knows which diary it is.
  final String summary;
  final String? draftId;
  final String? commandId;
  final String? contractId;

  /// The day of the diary, `YYYY-MM-DD`.
  final String? recordDate;
  final String? errorCode;
  final int photos;

  /// Not yet carried out by the server: it still counts when the tenant is changed (the queue says the same: `unsentCount`).
  bool get isUnsent => state != LocalState.sent && state != LocalState.draft;
}

/// The longest summary shown in a row; the whole text is on the diary.
const int kSummaryPreview = 80;

String _preview(String text) {
  final String flat = text.trim().replaceAll(RegExp(r'\s+'), ' ');
  return flat.runes.length <= kSummaryPreview ? flat : '${String.fromCharCodes(flat.runes.take(kSummaryPreview))}…';
}

LocalState? _stateOf(CommandState state) {
  switch (state) {
    case CommandState.conflict:
      return LocalState.conflict;
    case CommandState.rejected:
      return LocalState.rejected;
    case CommandState.unknown:
      return LocalState.unknown;
    case CommandState.sending:
      return LocalState.sending;
    case CommandState.queued:
      return LocalState.queued;
    case CommandState.accepted:
      return LocalState.sent;
    case CommandState.discarded:
      return null;
  }
}

/// The diaries on this phone, the ones that need the person first. A draft is read with its command (the draft names it); a command
/// whose draft is gone is read from its payload. A draft with nothing written and nothing sent is not a diary yet and is left out.
List<LocalDiary> localDiaries(Iterable<LocalDraft> drafts, Iterable<QueuedCommand> commands) {
  final Map<String, QueuedCommand> byId = <String, QueuedCommand>{
    for (final QueuedCommand command in commands)
      if (command.commandType == kDiaryAppendCommand) command.id: command,
  };
  final Set<String> used = <String>{};
  final List<LocalDiary> found = <LocalDiary>[];
  for (final LocalDraft stored in drafts) {
    if (stored.kind != kDiaryDraftKind) continue;
    final DiaryDraft? draft = DiaryDraft.fromJson(stored.fields);
    if (draft == null) continue;
    final QueuedCommand? command = draft.commandId == null ? null : byId[draft.commandId];
    if (command != null) used.add(command.id);
    final LocalState? fromCommand = command == null ? null : _stateOf(command.state);
    final bool empty = draft.form.summary.trim().isEmpty && draft.form.notes.trim().isEmpty && draft.photos.isEmpty;
    if (fromCommand == null && empty) continue;
    found.add(
      LocalDiary(
        key: stored.id,
        state: fromCommand ?? LocalState.draft,
        summary: _preview(draft.form.summary),
        draftId: stored.id,
        commandId: command?.id,
        contractId: draft.contractId,
        recordDate: draft.recordDate,
        errorCode: command?.errorCode,
        photos: draft.photos.length,
      ),
    );
  }
  for (final QueuedCommand command in byId.values) {
    final LocalState? state = _stateOf(command.state);
    if (used.contains(command.id) || state == null || state == LocalState.sent) continue;
    final Json payload = command.payload ?? const <String, Object?>{};
    final Json content = asRecord(payload['content']) ?? const <String, Object?>{};
    found.add(
      LocalDiary(
        key: command.id,
        state: state,
        summary: _preview(text(content['summary']) ?? ''),
        commandId: command.id,
        contractId: filled(payload['contract_id']),
        recordDate: day(payload['record_date']),
        errorCode: command.errorCode,
      ),
    );
  }
  found.sort((LocalDiary a, LocalDiary b) {
    final int byState = a.state.index.compareTo(b.state.index);
    return byState != 0 ? byState : (b.recordDate ?? '').compareTo(a.recordDate ?? '');
  });
  return found;
}

int unsentOf(Iterable<LocalDiary> diaries) => diaries.where((LocalDiary diary) => diary.isUnsent).length;

// ----------------------------------------------------------------------------------------------------------- the server

/// A copy of a diary that a device left because the diary had moved on while it was written; nobody has settled it.
final class ConflictCopy {
  const ConflictCopy({required this.id, required this.author, required this.createdAt, required this.content, this.diaryNo = ''});

  final String id;
  final String diaryNo;
  final String author;
  final String createdAt;
  final Json content;
}

/// A diary on the server that the device has to do with: one with copies nobody settled, or a draft the contractor can sign.
final class ServerDiary {
  const ServerDiary({required this.record, required this.contractCode, required this.copies, required this.canResolve});

  final DiaryRecord record;
  final String contractCode;
  final List<ConflictCopy> copies;

  /// The server offers this reader the settling of the copies (`actions.resolveConflict`).
  final bool canResolve;

  /// A copy waits and the reader may settle it.
  bool get hasConflict => copies.isNotEmpty;

  /// A draft the reader may sign as the contractor, with no copy waiting (the server refuses to sign over an unsettled copy).
  bool get awaitsSignature => record.status == 'DRAFT' && record.canSign && !hasConflict;
}

ServerDiary? parseServerDiary(Object? raw) {
  final DiaryRecord? record = parseDiary(raw);
  final Json? row = asRecord(raw);
  if (record == null || row == null) return null;
  final List<ConflictCopy> copies = <ConflictCopy>[];
  for (final Object? item in listOf(row['conflicts'])) {
    final Json? copy = asRecord(item);
    final String? id = filled(copy?['id']);
    final String? createdAt = filled(copy?['created_at']);
    if (copy == null || id == null || createdAt == null || copy['state'] != 'CONFLICT_PENDING') continue;
    copies.add(
      ConflictCopy(
        id: id,
        diaryNo: text(copy['diary_no']) ?? '',
        author: text(asRecord(copy['author'])?['display_name']) ?? '',
        createdAt: createdAt,
        content: asRecord(copy['content']) ?? const <String, Object?>{},
      ),
    );
  }
  return ServerDiary(
    record: record,
    contractCode: filled(asRecord(row['contract'])?['code']) ?? '',
    copies: copies,
    canResolve: asRecord(row['actions'])?['resolveConflict'] == true,
  );
}

/// The diaries on the server for this phone to look at: those with copies that nobody settled, and the drafts.
final class HubServer {
  const HubServer({required this.conflicts, required this.toSign, required this.more, this.asOf});

  final List<ServerDiary> conflicts;
  final List<ServerDiary> toSign;
  final bool more;
  final String? asOf;

  bool get isEmpty => conflicts.isEmpty && toSign.isEmpty;
}

HubServer? parseHubServer(Object? raw) {
  final Json? body = asRecord(raw);
  final Json? conflicts = asRecord(body?['conflicts']);
  final Json? drafts = asRecord(body?['drafts']);
  if (body == null || conflicts?['items'] is! List || drafts?['items'] is! List) return null;
  List<ServerDiary> read(Json page) => <ServerDiary>[
        for (final Object? item in listOf(page['items']))
          if (parseServerDiary(item) case final ServerDiary diary) diary,
      ];
  final List<ServerDiary> withCopies = <ServerDiary>[for (final ServerDiary diary in read(conflicts!)) if (diary.hasConflict) diary];
  final Set<String> seen = <String>{for (final ServerDiary diary in withCopies) diary.record.id};
  final List<ServerDiary> draftRows = read(drafts!);
  // A draft that has copies waiting is listed with the conflicts, once.
  for (final ServerDiary diary in draftRows) {
    if (diary.hasConflict && seen.add(diary.record.id)) withCopies.add(diary);
  }
  final List<ServerDiary> toSign = <ServerDiary>[for (final ServerDiary diary in draftRows) if (diary.awaitsSignature) diary];
  return HubServer(conflicts: withCopies, toSign: toSign, more: body['more'] == true, asOf: filled(body['as_of']));
}

/// How many pages of each list one read follows.
const int kHubPages = 2;

Future<Json> readHubServer(MachvonApiClient client) async {
  final List<Json> answers = await Future.wait(<Future<Json>>[
    readMerged(client, 'get_resources_site_diary', query: <String, Object?>{'has_conflict': 'true', 'limit': 50}, maxPages: kHubPages),
    readMerged(client, 'get_resources_site_diary', query: <String, Object?>{'status': 'DRAFT', 'limit': 50}, maxPages: kHubPages),
  ]);
  return <String, Object?>{
    'conflicts': answers[0],
    'drafts': answers[1],
    'more': answers.any((Json answer) => answer['next_cursor'] != null),
    'as_of': answers[0]['as_of'],
  };
}
