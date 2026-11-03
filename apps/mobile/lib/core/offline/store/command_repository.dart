import 'dart:convert';

import 'package:sqlite3/sqlite3.dart';

import '../queue/queued_command.dart';

/// The rows of `queued_command`. The repository is the only code that writes the table, and it applies the state machine
/// of [kAllowedMoves] to every change of state: a move the design does not allow is a [StateError] and changes nothing.
final class CommandRepository {
  CommandRepository(this._database);

  final Database _database;

  static const String _columns =
      'id, tenant_id, user_id, command_type, payload, payload_bytes, base_server_version, idempotency_key, superseded_keys, state, attempts, '
      'next_attempt_at, error_code, server_version, result_ref, draft_id, release_draft, created_at, updated_at, sent_at, settled_at';

  void insert(QueuedCommand command) {
    _database.execute(
      'INSERT INTO queued_command ($_columns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      _values(command),
    );
  }

  QueuedCommand? byId(String id) => _one('SELECT $_columns FROM queued_command WHERE id = ?', <Object?>[id]);

  QueuedCommand? byKey(String key) => _one('SELECT $_columns FROM queued_command WHERE idempotency_key = ?', <Object?>[key]);

  /// The key a command had before: a settled receipt on the server still names it.
  QueuedCommand? bySupersededKey(String key) {
    for (final QueuedCommand command in all()) {
      if (command.supersededKeys.contains(key)) return command;
    }
    return null;
  }

  /// Every command, oldest first (the order they were made in is the order they are sent in).
  List<QueuedCommand> all() => _many('SELECT $_columns FROM queued_command ORDER BY created_at, id', const <Object?>[]);

  List<QueuedCommand> inStates(Set<CommandState> states) {
    final String marks = List<String>.filled(states.length, '?').join(', ');
    return _many(
      'SELECT $_columns FROM queued_command WHERE state IN ($marks) ORDER BY created_at, id',
      <Object?>[for (final CommandState state in states) state.name],
    );
  }

  /// The queued commands whose backoff has ended, oldest first, at most [limit].
  List<QueuedCommand> due(int nowMs, int limit) => _many(
        'SELECT $_columns FROM queued_command WHERE state = ? AND next_attempt_at <= ? ORDER BY created_at, id LIMIT ?',
        <Object?>[CommandState.queued.name, nowMs, limit],
      );

  Map<CommandState, int> counts() {
    final Map<CommandState, int> counts = <CommandState, int>{for (final CommandState state in CommandState.values) state: 0};
    for (final Row row in _database.select('SELECT state, count(*) AS n FROM queued_command GROUP BY state')) {
      counts[CommandState.parse(row['state'] as String)] = row['n'] as int;
    }
    return counts;
  }

  /// Moves the command to [to] and applies [change] to its fields in the same statement. The move is checked against the
  /// state machine first.
  QueuedCommand move(String id, CommandState to, QueuedCommand Function(QueuedCommand current) change) {
    final QueuedCommand? current = byId(id);
    if (current == null) throw StateError('no queued command $id');
    if (!canMove(current.state, to)) throw StateError('a ${current.state.name} command cannot become ${to.name}');
    final QueuedCommand next = change(current.copyWith(state: to));
    _write(next);
    return next;
  }

  /// Rewrites fields that are not the state (a backoff, a counter) without moving it.
  QueuedCommand update(String id, QueuedCommand Function(QueuedCommand current) change) {
    final QueuedCommand? current = byId(id);
    if (current == null) throw StateError('no queued command $id');
    final QueuedCommand next = change(current);
    if (next.state != current.state) throw StateError('update does not change the state; use move');
    _write(next);
    return next;
  }

  /// Removes the settled commands that were settled before [beforeMs] (the receipts are kept for seven days).
  int pruneSettled(int beforeMs) {
    _database.execute(
      'DELETE FROM queued_command WHERE state IN (?, ?) AND settled_at IS NOT NULL AND settled_at < ?',
      <Object?>[CommandState.accepted.name, CommandState.discarded.name, beforeMs],
    );
    return _database.updatedRows;
  }

  void deleteAll() => _database.execute('DELETE FROM queued_command');

  void _write(QueuedCommand c) {
    _database.execute(
      'UPDATE queued_command SET command_type = ?, payload = ?, payload_bytes = ?, base_server_version = ?, idempotency_key = ?, superseded_keys = ?, '
      'state = ?, attempts = ?, next_attempt_at = ?, error_code = ?, server_version = ?, result_ref = ?, updated_at = ?, sent_at = ?, settled_at = ? WHERE id = ?',
      <Object?>[
        c.commandType,
        c.payload == null ? null : jsonEncode(c.payload),
        c.payloadBytes,
        c.baseServerVersion,
        c.idempotencyKey,
        jsonEncode(c.supersededKeys),
        c.state.name,
        c.attempts,
        c.nextAttemptAt,
        c.errorCode,
        c.serverVersion,
        c.resultRef,
        c.updatedAt,
        c.sentAt,
        c.settledAt,
        c.id,
      ],
    );
  }

  List<Object?> _values(QueuedCommand c) => <Object?>[
        c.id,
        c.tenantId,
        c.userId,
        c.commandType,
        c.payload == null ? null : jsonEncode(c.payload),
        c.payloadBytes,
        c.baseServerVersion,
        c.idempotencyKey,
        jsonEncode(c.supersededKeys),
        c.state.name,
        c.attempts,
        c.nextAttemptAt,
        c.errorCode,
        c.serverVersion,
        c.resultRef,
        c.draftId,
        c.releaseDraft ? 1 : 0,
        c.createdAt,
        c.updatedAt,
        c.sentAt,
        c.settledAt,
      ];

  QueuedCommand? _one(String sql, List<Object?> arguments) {
    final ResultSet rows = _database.select(sql, arguments);
    return rows.isEmpty ? null : _fromRow(rows.first);
  }

  List<QueuedCommand> _many(String sql, List<Object?> arguments) => <QueuedCommand>[for (final Row row in _database.select(sql, arguments)) _fromRow(row)];

  QueuedCommand _fromRow(Row row) {
    final String? payload = row['payload'] as String?;
    return QueuedCommand(
      id: row['id'] as String,
      tenantId: row['tenant_id'] as String,
      userId: row['user_id'] as String,
      commandType: row['command_type'] as String,
      payload: payload == null ? null : (jsonDecode(payload) as Map<String, Object?>),
      payloadBytes: row['payload_bytes'] as int,
      baseServerVersion: row['base_server_version'] as int,
      idempotencyKey: row['idempotency_key'] as String,
      supersededKeys: <String>[for (final Object? key in jsonDecode(row['superseded_keys'] as String) as List<Object?>) key! as String],
      state: CommandState.parse(row['state'] as String),
      attempts: row['attempts'] as int,
      nextAttemptAt: row['next_attempt_at'] as int,
      errorCode: row['error_code'] as String?,
      serverVersion: row['server_version'] as int?,
      resultRef: row['result_ref'] as String?,
      draftId: row['draft_id'] as String?,
      releaseDraft: (row['release_draft'] as int) == 1,
      createdAt: row['created_at'] as int,
      updatedAt: row['updated_at'] as int,
      sentAt: row['sent_at'] as int?,
      settledAt: row['settled_at'] as int?,
    );
  }
}
