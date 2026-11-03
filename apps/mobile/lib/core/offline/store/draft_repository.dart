import 'dart:convert';

import 'package:sqlite3/sqlite3.dart';

import '../drafts/local_draft.dart';

/// The rows of `local_draft`.
final class DraftRepository {
  DraftRepository(this._database);

  final Database _database;

  static const String _columns = 'id, tenant_id, user_id, kind, record_id, payload, base_server_version, status, blocked_code, created_at, updated_at';

  void upsert(LocalDraft draft) {
    _database.execute(
      'INSERT INTO local_draft ($_columns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
      'ON CONFLICT(id) DO UPDATE SET record_id = excluded.record_id, payload = excluded.payload, base_server_version = excluded.base_server_version, '
      'status = excluded.status, blocked_code = excluded.blocked_code, updated_at = excluded.updated_at',
      <Object?>[
        draft.id,
        draft.tenantId,
        draft.userId,
        draft.kind,
        draft.recordId,
        jsonEncode(draft.fields),
        draft.baseServerVersion,
        draft.status.name,
        draft.blockedCode,
        draft.createdAt,
        draft.updatedAt,
      ],
    );
  }

  LocalDraft? byId(String id) {
    final ResultSet rows = _database.select('SELECT $_columns FROM local_draft WHERE id = ?', <Object?>[id]);
    return rows.isEmpty ? null : _fromRow(rows.first);
  }

  List<LocalDraft> all() => <LocalDraft>[for (final Row row in _database.select('SELECT $_columns FROM local_draft ORDER BY updated_at DESC, id')) _fromRow(row)];

  void delete(String id) => _database.execute('DELETE FROM local_draft WHERE id = ?', <Object?>[id]);

  void deleteAll() => _database.execute('DELETE FROM local_draft');

  LocalDraft _fromRow(Row row) => LocalDraft(
        id: row['id'] as String,
        tenantId: row['tenant_id'] as String,
        userId: row['user_id'] as String,
        kind: row['kind'] as String,
        recordId: row['record_id'] as String?,
        fields: jsonDecode(row['payload'] as String) as Map<String, Object?>,
        baseServerVersion: row['base_server_version'] as int,
        status: DraftStatus.parse(row['status'] as String),
        blockedCode: row['blocked_code'] as String?,
        createdAt: row['created_at'] as int,
        updatedAt: row['updated_at'] as int,
      );
}
