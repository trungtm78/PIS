import 'package:machvon_api_client/machvon_api_client.dart' show newUuidV4;

import '../store/local_store.dart';
import 'local_draft.dart';

/// The drafts of the person on this device (`local_draft`, MOB.md 3, 6). A draft has a UUID made on the phone, so a
/// retry never doubles it; it is the person's work and nothing the server answers removes or rewrites it except an
/// acceptance of the command that sent it.
final class DraftStore {
  DraftStore(this._store, {DateTime Function()? clock, String Function()? newId})
      : _clock = clock ?? DateTime.now,
        _newId = newId ?? newUuidV4;

  final LocalStore _store;
  final DateTime Function() _clock;
  final String Function() _newId;

  int get _now => _clock().millisecondsSinceEpoch;

  /// Saves a draft: a new one when [id] is null, otherwise the draft [id] with its new content. Editing a draft that was
  /// blocked (a locked period, a conflict) makes it editable again: the person has taken it up.
  LocalDraft save({String? id, required String kind, required Map<String, Object?> fields, String? recordId, int baseServerVersion = 0}) {
    final LocalDraft? existing = id == null ? null : _store.drafts.byId(id);
    if (id != null && existing == null) throw ArgumentError.value(id, 'id', 'is not a draft of this device');
    final LocalDraft draft = LocalDraft(
      id: existing?.id ?? _newId(),
      tenantId: _store.tenantId,
      userId: _store.userId,
      kind: kind,
      recordId: recordId ?? existing?.recordId,
      fields: fields,
      baseServerVersion: existing == null ? baseServerVersion : (baseServerVersion > existing.baseServerVersion ? baseServerVersion : existing.baseServerVersion),
      status: existing != null && existing.status == DraftStatus.queued ? DraftStatus.queued : DraftStatus.editing,
      createdAt: existing?.createdAt ?? _now,
      updatedAt: _now,
    );
    _store.drafts.upsert(draft);
    return draft;
  }

  LocalDraft? byId(String id) => _store.drafts.byId(id);

  /// The drafts, newest first; those of one kind when [kind] is given.
  List<LocalDraft> list({String? kind}) => <LocalDraft>[
        for (final LocalDraft draft in _store.drafts.all())
          if (kind == null || draft.kind == kind) draft,
      ];

  void delete(String id) => _store.drafts.delete(id);
}
