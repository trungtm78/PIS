import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'package:sqlite3/sqlite3.dart';

import 'command_repository.dart';
import 'database_key.dart';
import 'draft_repository.dart';
import 'local_database.dart';
import 'upload_repository.dart';

const String _filePrefix = 'machvon-';

Directory _uploadsDirectoryOf(String databasePath) =>
    Directory(p.join(p.dirname(databasePath), 'uploads-${p.basenameWithoutExtension(databasePath).substring(_filePrefix.length)}'));

/// The key of the device id in the `meta` table.
const String kDeviceIdMeta = 'device_id';

/// The key of the time of the data the device shows, in the `meta` table (epoch milliseconds, from the server).
const String kDataAsOfMeta = 'data_as_of';

/// The encrypted database of one user in one tenant: the queue, the drafts, the uploads and a few facts about the data
/// on the device. Everything in it belongs to that tenant and user and goes when they are signed out or the tenant is
/// switched (MOB.md 2).
final class LocalStore {
  LocalStore._(this.tenantId, this.userId, this._database, this.path)
      : commands = CommandRepository(_database),
        drafts = DraftRepository(_database),
        uploads = UploadRepository(_database);

  final String tenantId;
  final String userId;
  final String path;
  final Database _database;
  final CommandRepository commands;
  final DraftRepository drafts;
  final UploadRepository uploads;
  bool _closed = false;

  bool get isClosed => _closed;

  /// The private folder of the prepared files this user's uploads send. It goes with the store when the user is purged.
  Directory get uploadsDirectory => _uploadsDirectoryOf(path);

  /// Where the prepared photographs of the drafts live (the prepared file and the one kept as it was taken). Inside
  /// [uploadsDirectory], so the purge takes them with the store; emptied of a draft's files when the server accepts the draft.
  Directory get evidenceDirectory => Directory(p.join(uploadsDirectory.path, 'evidence'));

  /// The id this installation got when it registered as a device of the tenant (`device_registration`); the batches and
  /// the uploads name it. Null until the registration has been made.
  String? get deviceId => meta(kDeviceIdMeta);

  set deviceId(String value) => setMeta(kDeviceIdMeta, value);

  /// When the data on the device was last known to match the server (the `as_of` of MOB.md BR-MOB-01): set from the time
  /// the server gave, never from the clock of the phone. Null when no data was ever fetched.
  DateTime? get dataAsOf {
    final String? value = meta(kDataAsOfMeta);
    return value == null ? null : DateTime.fromMillisecondsSinceEpoch(int.parse(value), isUtc: true);
  }

  set dataAsOf(DateTime value) => setMeta(kDataAsOfMeta, value.millisecondsSinceEpoch.toString());

  /// Runs [action] in one transaction: all of it is kept or none of it.
  T transaction<T>(T Function() action) {
    _database.execute('BEGIN IMMEDIATE');
    try {
      final T result = action();
      _database.execute('COMMIT');
      return result;
    } on Object {
      _database.execute('ROLLBACK');
      rethrow;
    }
  }

  String? meta(String key) {
    final ResultSet rows = _database.select('SELECT value FROM meta WHERE key = ?', <Object?>[key]);
    return rows.isEmpty ? null : rows.first['value'] as String;
  }

  void setMeta(String key, String value) {
    _database.execute('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', <Object?>[key, value]);
  }

  void close() {
    if (_closed) return;
    _closed = true;
    _database.close();
  }
}

/// Opens, finds and destroys the local stores, one file for each user of each tenant.
///
/// The file name and the key name are derived from the tenant and the user by a digest, so nothing on the file system or
/// in the key store names a person or a tenant. Opening twice gives the same open store; purging closes it first, then
/// deletes the file and its key, so a purged store cannot be read again, not even with a backup of the file.
final class OfflineStorage {
  OfflineStorage({required Future<Directory> Function() directory, required DatabaseKeyStore keys})
      : _directory = directory,
        _keys = keys;

  static const String _prefix = _filePrefix;
  static const String _suffix = '.db';

  final Future<Directory> Function() _directory;
  final DatabaseKeyStore _keys;
  final Map<String, LocalStore> _open = <String, LocalStore>{};

  /// The scope name of a tenant and user: 16 hexadecimal characters of a digest.
  static String scopeOf(String tenantId, String userId) => sha256.convert('$tenantId\u0000$userId'.codeUnits).toString().substring(0, 16);

  Future<LocalStore> open({required String tenantId, required String userId}) async {
    final String scope = scopeOf(tenantId, userId);
    final LocalStore? existing = _open[scope];
    if (existing != null && !existing.isClosed) return existing;
    final Directory directory = await _directory();
    if (!directory.existsSync()) directory.createSync(recursive: true);
    final String path = '${directory.path}${Platform.pathSeparator}$_prefix$scope$_suffix';
    final Database database = openLocalDatabase(path, await _keys.keyFor(scope));
    final LocalStore store = LocalStore._(tenantId, userId, database, path);
    _open[scope] = store;
    return store;
  }

  /// Removes the data of one user in one tenant: the file, its journals and its key.
  Future<void> purge({required String tenantId, required String userId}) => _purgeScope(scopeOf(tenantId, userId));

  /// Removes every store of this installation (a device that is wiped or a revoked installation).
  Future<void> purgeAll() async {
    final Directory directory = await _directory();
    final List<String> scopes = <String>{
      ..._open.keys,
      if (directory.existsSync())
        for (final FileSystemEntity entity in directory.listSync())
          if (_scopeOfFile(entity.uri.pathSegments.last) case final String scope) scope,
    }.toList();
    for (final String scope in scopes) {
      await _purgeScope(scope);
    }
  }

  Future<void> _purgeScope(String scope) async {
    _open.remove(scope)?.close();
    final Directory directory = await _directory();
    final String databasePath = '${directory.path}${Platform.pathSeparator}$_prefix$scope$_suffix';
    deleteLocalDatabaseFiles(databasePath);
    final Directory uploads = _uploadsDirectoryOf(databasePath);
    if (uploads.existsSync()) uploads.deleteSync(recursive: true);
    await _keys.delete(scope);
  }

  static String? _scopeOfFile(String name) {
    if (!name.startsWith(_prefix) || !name.endsWith(_suffix)) return null;
    final String scope = name.substring(_prefix.length, name.length - _suffix.length);
    return RegExp(r'^[0-9a-f]{16}$').hasMatch(scope) ? scope : null;
  }
}
