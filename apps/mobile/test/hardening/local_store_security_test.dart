import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/offline/store/local_database.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:path/path.dart' as p;
import 'package:sqlite3/sqlite3.dart';

import '../support/offline_support.dart';

/// What the tester looks for in a copied container: things that must be readable only through the key.
const String _bearerMarker = 'Bearer eyJhbGciOiJFUzI1NiJ9.SECRET-PAYLOAD-8f3a1c.signature';
const String _noteMarker = 'Ghi chu rieng cua nguoi dung 4d2e';
const String _tenantId = 'tenant-9a1c7e2f-0000-4000-8000-00000000a001';
const String _userId = 'user-3b7d5e91-0000-4000-8000-00000000b002';

/// Everything under [directory] as latin1 text, file by file (a byte search that never fails on a binary file).
Map<String, String> _readAll(Directory directory) => <String, String>{
      for (final FileSystemEntity entity in directory.listSync(recursive: true))
        if (entity is File) p.relative(entity.path, from: directory.path): latin1.decode(entity.readAsBytesSync()),
    };

void _fill(LocalStore store) {
  store.deviceId = '11111111-1111-4111-8111-111111111111';
  store.setMeta('note', _noteMarker);
  for (int i = 1; i <= 3; i += 1) {
    store.commands.insert(
      QueuedCommand(
        id: 'row-$i',
        tenantId: store.tenantId,
        userId: store.userId,
        commandType: 'report.submit',
        payload: <String, Object?>{'report_id': '5b3c0e7a-0a56-4c0e-8c33-0f2f6b7f1a0$i', 'note': _bearerMarker, 'free_text': _noteMarker},
        payloadBytes: 120,
        baseServerVersion: 3,
        idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000$i',
        state: CommandState.queued,
        createdAt: 1,
        updatedAt: 1,
      ),
    );
  }
}

Directory _copyOf(Directory source) {
  final Directory target = Directory.systemTemp.createTempSync('machvon-container-copy-');
  addTearDown(() {
    if (target.existsSync()) target.deleteSync(recursive: true);
  });
  for (final FileSystemEntity entity in source.listSync(recursive: true)) {
    if (entity is! File) continue;
    final File copy = File(p.join(target.path, p.relative(entity.path, from: source.path)));
    copy.parent.createSync(recursive: true);
    entity.copySync(copy.path);
  }
  return target;
}

void main() {
  group('AC-ST-MOB-041-1 UAT-NFR-TENANCY-07 a copied app container: the database is encrypted and its key is not in it', () {
    test('the database, its write-ahead log and its shared memory hold no header, no marker, no id and no table name (the store is open, so the log is live)', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore store = await test.open(tenantId: _tenantId, userId: _userId);
      _fill(store);

      final Map<String, String> files = _readAll(test.directory);
      expect(files.keys.where((String f) => f.endsWith('.db')), hasLength(1));
      expect(files.keys.any((String f) => f.endsWith('-wal')), isTrue, reason: 'the log is part of what is inspected');
      for (final MapEntry<String, String> file in files.entries) {
        expect(file.value, isNot(contains('SQLite format 3')), reason: '${file.key}: the plain SQLite header');
        for (final String marker in <String>[_bearerMarker, 'SECRET-PAYLOAD', _noteMarker, _tenantId, _userId, 'queued_command', 'report.submit', '11111111-1111-4111-8111-111111111111']) {
          expect(file.value, isNot(contains(marker)), reason: '${file.key} shows "$marker"');
        }
      }
    });

    test('the same holds after the store is closed and the log is folded into the database', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore store = await test.open(tenantId: _tenantId, userId: _userId);
      _fill(store);
      store.close();
      for (final MapEntry<String, String> file in _readAll(test.directory).entries) {
        expect(file.value, isNot(contains('SQLite format 3')), reason: file.key);
        expect(file.value, isNot(contains(_bearerMarker)), reason: file.key);
        expect(file.value, isNot(contains(_noteMarker)), reason: file.key);
      }
    });

    test('the key lives in the key store only: it is 256 bits, it is in no file, and no file name carries a tenant or a user', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore store = await test.open(tenantId: _tenantId, userId: _userId);
      _fill(store);
      store.close();

      expect(test.keys.keys, hasLength(1));
      final String key = test.keys.keys.values.single;
      expect(key, matches(RegExp(r'^[0-9a-f]{64}$')));
      for (final MapEntry<String, String> file in _readAll(test.directory).entries) {
        expect(file.value, isNot(contains(key)), reason: '${file.key} holds the key');
        expect(file.key, isNot(contains('tenant')));
        expect(file.key, isNot(contains('user')));
        expect(file.key, matches(RegExp(r'^machvon-[0-9a-f]{16}\.db(-wal|-shm|-journal)?$')));
      }
      expect(test.keys.keys.keys.single, OfflineStorage.scopeOf(_tenantId, _userId));
    });

    test('two stores never share a key: another tenant, another user, another key', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore a = await test.open(tenantId: 'tenant-a', userId: 'user-1');
      final LocalStore b = await test.open(tenantId: 'tenant-b', userId: 'user-1');
      final LocalStore c = await test.open(tenantId: 'tenant-a', userId: 'user-2');
      expect(<String>{a.path, b.path, c.path}, hasLength(3));
      expect(test.keys.keys.values.toSet(), hasLength(3));
      for (final String key in test.keys.keys.values) {
        expect(key, matches(RegExp(r'^[0-9a-f]{64}$')));
      }
    });

    test('a copy of the container opens with neither another key nor a short one; with the right key it does (so the search above could have found something)', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore store = await test.open(tenantId: _tenantId, userId: _userId);
      _fill(store);
      final String correct = test.keys.keys.values.single;
      store.close();

      final Directory copy = _copyOf(test.directory);
      final String path = copy.listSync().whereType<File>().firstWhere((File f) => f.path.endsWith('.db')).path;

      expect(() => openLocalDatabase(path, '0' * 64), throwsA(isA<LocalDatabaseKeyError>()));
      expect(() => openLocalDatabase(path, correct.replaceFirst(RegExp('^.'), correct[0] == 'a' ? 'b' : 'a')), throwsA(isA<LocalDatabaseKeyError>()));
      expect(() => openLocalDatabase(path, ''), throwsArgumentError);
      expect(() => openLocalDatabase(path, 'not hexadecimal'), throwsArgumentError);

      final Database control = openLocalDatabase(path, correct);
      addTearDown(control.close);
      expect(control.select('SELECT count(*) AS n FROM queued_command').first['n'], 3, reason: 'the control: with the key the rows are there');
    });

    test('opened as a plain SQLite file the copy is not a database at all', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore store = await test.open(tenantId: _tenantId, userId: _userId);
      _fill(store);
      store.close();
      final String path = test.directory.listSync().whereType<File>().firstWhere((File f) => f.path.endsWith('.db')).path;
      final Database plain = sqlite3.open(path);
      addTearDown(plain.close);
      expect(() => plain.select('SELECT count(*) FROM sqlite_master'), throwsA(isA<SqliteException>()));
    });

    test('a copy made before a purge is useless afterwards: the key is destroyed, and a store opened again has a new key and no rows', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore store = await test.open(tenantId: _tenantId, userId: _userId);
      _fill(store);
      final String oldKey = test.keys.keys.values.single;
      store.close();
      final Directory backup = _copyOf(test.directory);

      await test.storage.purge(tenantId: _tenantId, userId: _userId);
      expect(test.keys.keys, isEmpty, reason: 'the key is gone');
      expect(test.directory.listSync().whereType<File>(), isEmpty, reason: 'the files are gone');

      final LocalStore reopened = await test.open(tenantId: _tenantId, userId: _userId);
      expect(reopened.commands.inStates(CommandState.values.toSet()), isEmpty);
      final String newKey = test.keys.keys.values.single;
      expect(newKey, isNot(oldKey));
      final String path = backup.listSync().whereType<File>().firstWhere((File f) => f.path.endsWith('.db')).path;
      expect(() => openLocalDatabase(path, newKey), throwsA(isA<LocalDatabaseKeyError>()), reason: 'the old file does not open with the new key');
    });
  });

  group('AC-ST-MOB-041-1 UAT-NFR-TENANCY-07 0 foreign-tenant rows: each store holds the rows of its own tenant and user only', () {
    test('rows written under three scopes are found only in their own store', () async {
      final TestStorage test = TestStorage.create();
      final Map<String, LocalStore> stores = <String, LocalStore>{
        'a1': await test.open(tenantId: 'tenant-a', userId: 'user-1'),
        'b1': await test.open(tenantId: 'tenant-b', userId: 'user-1'),
        'a2': await test.open(tenantId: 'tenant-a', userId: 'user-2'),
      };
      stores.values.forEach(_fill);

      for (final LocalStore store in stores.values) {
        store.close();
      }
      for (final MapEntry<String, LocalStore> entry in stores.entries) {
        final String key = test.keys.keys[OfflineStorage.scopeOf(entry.value.tenantId, entry.value.userId)]!;
        final Database database = openLocalDatabase(entry.value.path, key);
        addTearDown(database.close);
        final ResultSet foreign = database.select(
          'SELECT id FROM queued_command WHERE tenant_id <> ? OR user_id <> ?',
          <Object?>[entry.value.tenantId, entry.value.userId],
        );
        expect(foreign, isEmpty, reason: '${entry.key} holds a row of another tenant or user');
        expect(database.select('SELECT count(*) AS n FROM queued_command').first['n'], 3, reason: entry.key);
      }
    });

    test('the key of one store does not open the file of another', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore a = await test.open(tenantId: 'tenant-a', userId: 'user-1');
      final LocalStore b = await test.open(tenantId: 'tenant-b', userId: 'user-1');
      a.close();
      b.close();
      final String keyOfA = test.keys.keys[OfflineStorage.scopeOf('tenant-a', 'user-1')]!;
      expect(() => openLocalDatabase(b.path, keyOfA), throwsA(isA<LocalDatabaseKeyError>()));
    });
  });
}
