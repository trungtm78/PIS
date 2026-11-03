import 'dart:convert';

import 'package:sqlite3/sqlite3.dart';

import '../attachments/attachment_upload.dart';

/// The rows of `attachment_upload`.
final class UploadRepository {
  UploadRepository(this._database);

  final Database _database;

  static const String _columns =
      'id, tenant_id, user_id, owner_kind, owner_ref, file_name, source_path, mime, size_bytes, sha256, state, start_key, complete_key, server_id, '
      'chunk_bytes, chunk_count, sent_chunks, restarts, error_code, created_at, updated_at';

  void upsert(AttachmentUpload upload) {
    _database.execute(
      'INSERT INTO attachment_upload ($_columns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
      'ON CONFLICT(id) DO UPDATE SET mime = excluded.mime, sha256 = excluded.sha256, state = excluded.state, start_key = excluded.start_key, '
      'complete_key = excluded.complete_key, server_id = excluded.server_id, chunk_bytes = excluded.chunk_bytes, chunk_count = excluded.chunk_count, '
      'sent_chunks = excluded.sent_chunks, restarts = excluded.restarts, error_code = excluded.error_code, updated_at = excluded.updated_at',
      <Object?>[
        upload.id,
        upload.tenantId,
        upload.userId,
        upload.ownerKind,
        upload.ownerRef,
        upload.fileName,
        upload.sourcePath,
        upload.mime,
        upload.sizeBytes,
        upload.sha256,
        upload.state.name,
        upload.startKey,
        upload.completeKey,
        upload.serverId,
        upload.chunkBytes,
        upload.chunkCount,
        jsonEncode(upload.sentChunks.toList()..sort()),
        upload.restarts,
        upload.errorCode,
        upload.createdAt,
        upload.updatedAt,
      ],
    );
  }

  AttachmentUpload? byId(String id) {
    final ResultSet rows = _database.select('SELECT $_columns FROM attachment_upload WHERE id = ?', <Object?>[id]);
    return rows.isEmpty ? null : _fromRow(rows.first);
  }

  List<AttachmentUpload> all() =>
      <AttachmentUpload>[for (final Row row in _database.select('SELECT $_columns FROM attachment_upload ORDER BY created_at, id')) _fromRow(row)];

  void deleteAll() => _database.execute('DELETE FROM attachment_upload');

  AttachmentUpload _fromRow(Row row) => AttachmentUpload(
        id: row['id'] as String,
        tenantId: row['tenant_id'] as String,
        userId: row['user_id'] as String,
        ownerKind: row['owner_kind'] as String,
        ownerRef: row['owner_ref'] as String?,
        fileName: row['file_name'] as String,
        sourcePath: row['source_path'] as String,
        mime: row['mime'] as String?,
        sizeBytes: row['size_bytes'] as int,
        sha256: row['sha256'] as String?,
        state: UploadState.parse(row['state'] as String),
        startKey: row['start_key'] as String,
        completeKey: row['complete_key'] as String,
        serverId: row['server_id'] as String?,
        chunkBytes: row['chunk_bytes'] as int?,
        chunkCount: row['chunk_count'] as int?,
        sentChunks: <int>{for (final Object? index in jsonDecode(row['sent_chunks'] as String) as List<Object?>) index! as int},
        restarts: row['restarts'] as int,
        errorCode: row['error_code'] as String?,
        createdAt: row['created_at'] as int,
        updatedAt: row['updated_at'] as int,
      );
}
