import 'dart:io';

import 'package:sqlite3/sqlite3.dart';

/// The key does not open the file: the key was lost, replaced or the file belongs to another installation.
final class LocalDatabaseKeyError implements Exception {
  const LocalDatabaseKeyError();

  @override
  String toString() => 'LocalDatabaseKeyError';
}

final RegExp _hexKey = RegExp(r'^[0-9a-f]{32,128}$');

/// The schema of the local store, one entry per version. A version is applied once, in order, inside a transaction, and
/// the version is recorded in `user_version`; an existing database moves up version by version.
const List<List<String>> _migrations = <List<String>>[
  <String>[
    '''
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID''',
    '''
    CREATE TABLE queued_command (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      payload TEXT,
      payload_bytes INTEGER NOT NULL,
      base_server_version INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      superseded_keys TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      server_version INTEGER,
      result_ref TEXT,
      draft_id TEXT,
      release_draft INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sent_at INTEGER,
      settled_at INTEGER
    )''',
    'CREATE INDEX queued_command_state_idx ON queued_command (state, next_attempt_at)',
    '''
    CREATE TABLE local_draft (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      record_id TEXT,
      payload TEXT NOT NULL,
      base_server_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      blocked_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )''',
    'CREATE INDEX local_draft_kind_idx ON local_draft (kind, record_id)',
    '''
    CREATE TABLE attachment_upload (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_ref TEXT,
      file_name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      mime TEXT,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT,
      state TEXT NOT NULL,
      start_key TEXT NOT NULL,
      complete_key TEXT NOT NULL,
      server_id TEXT,
      chunk_bytes INTEGER,
      chunk_count INTEGER,
      sent_chunks TEXT NOT NULL DEFAULT '[]',
      restarts INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )''',
  ],
];

/// The newest schema version of the local store.
final int kLocalSchemaVersion = _migrations.length;

/// Opens (and creates) the encrypted local database at [path] and brings its schema up to date.
///
/// The file is encrypted with SQLite3 Multiple Ciphers (the `sqlite3mc` build chosen in `pubspec.yaml`); [key] is the
/// 256-bit key from the [DatabaseKeyStore], given as hexadecimal characters. A file that the key does not open throws
/// [LocalDatabaseKeyError] and is not touched.
Database openLocalDatabase(String path, String key) {
  if (!_hexKey.hasMatch(key)) throw ArgumentError.value('<redacted>', 'key', 'must be 32 to 128 hexadecimal characters');
  final Database database = sqlite3.open(path);
  try {
    // A PRAGMA takes no bound parameter; the key was checked above to be hexadecimal only.
    database.execute("PRAGMA key = '$key'");
    // Reading the schema is what fails on a wrong key.
    database.select('SELECT count(*) FROM sqlite_master');
  } on SqliteException {
    database.close();
    throw const LocalDatabaseKeyError();
  }
  database.execute('PRAGMA journal_mode = WAL');
  database.execute('PRAGMA foreign_keys = ON');
  try {
    _migrate(database);
  } on Object {
    database.close();
    rethrow;
  }
  return database;
}

void _migrate(Database database) {
  final int current = database.select('PRAGMA user_version').first.columnAt(0) as int;
  if (current > kLocalSchemaVersion) {
    throw StateError('the local database is newer ($current) than this application ($kLocalSchemaVersion)');
  }
  for (int version = current; version < kLocalSchemaVersion; version += 1) {
    database.execute('BEGIN');
    try {
      for (final String statement in _migrations[version]) {
        database.execute(statement);
      }
      database.execute('PRAGMA user_version = ${version + 1}');
      database.execute('COMMIT');
    } on Object {
      database.execute('ROLLBACK');
      rethrow;
    }
  }
}

/// Deletes the database file and its write-ahead and shared-memory companions. A missing file is not an error.
void deleteLocalDatabaseFiles(String path) {
  for (final String suffix in const <String>['', '-wal', '-shm', '-journal']) {
    final File file = File('$path$suffix');
    if (file.existsSync()) file.deleteSync();
  }
}
