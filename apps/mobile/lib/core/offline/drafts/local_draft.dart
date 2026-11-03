/// Where a draft stands. A draft is the person's work on a record, kept on the device with a UUID; the commands made
/// from it go to the queue, and whatever the server answers, the draft is never overwritten or deleted by an answer
/// that is not an acceptance (MOB.md 3: "nháp là bản ghi cục bộ có UUID").
enum DraftStatus {
  /// Being edited, or saved and not sent yet.
  editing,

  /// A command was made from it and waits in the queue.
  queued,

  /// The server refused the command (a locked period, an expired licence) or found a newer version: the draft is intact
  /// and waits for the person; [LocalDraft.blockedCode] says why.
  blocked,

  /// The server holds this version of the draft.
  synced;

  static DraftStatus parse(String name) => DraftStatus.values.byName(name);
}

/// A draft on the device (`local_draft`).
final class LocalDraft {
  const LocalDraft({
    required this.id,
    required this.tenantId,
    required this.userId,
    required this.kind,
    required this.fields,
    required this.baseServerVersion,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.recordId,
    this.blockedCode,
  });

  final String id;
  final String tenantId;
  final String userId;

  /// What the draft is of (`report`, `issue`, `site_diary`); the module that owns it chooses the word.
  final String kind;

  /// The id of the record on the server when the draft changes one that exists (a report to save or submit).
  final String? recordId;

  /// The content, in the shape of the command that sends it.
  final Map<String, Object?> fields;

  /// The version of the record the draft was based on; the version a conflict is detected against.
  final int baseServerVersion;
  final DraftStatus status;
  final String? blockedCode;
  final int createdAt;
  final int updatedAt;

  @override
  String toString() => 'LocalDraft($id, $kind, ${status.name})';
}
