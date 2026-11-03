import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/offline/store/database_key.dart';
import 'package:machvon_mobile/core/offline/store/local_database.dart';
import 'package:machvon_mobile/core/offline/store/local_store.dart';
import 'package:sqlite3/sqlite3.dart';

import '../../support/offline_support.dart';

QueuedCommand command(String id, {CommandState state = CommandState.queued, String key = 'key-0000000000000001'}) => QueuedCommand(
      id: id,
      tenantId: 'tenant-a',
      userId: 'user-1',
      commandType: 'report.submit',
      payload: <String, Object?>{'report_id': 'secret-marker-in-payload'},
      payloadBytes: 40,
      baseServerVersion: 3,
      idempotencyKey: key,
      state: state,
      createdAt: 1,
      updatedAt: 1,
    );

void main() {
  group('TK-MOB-005-4 the encrypted local store', () {
    test('the file is encrypted: the data is not in it and it cannot be opened without the key', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore store = await test.open();
      store.commands.insert(command('c1'));
      store.close();
      final File file = File(store.path);
      expect(String.fromCharCodes(file.readAsBytesSync()), isNot(contains('secret-marker-in-payload')));
      expect(String.fromCharCodes(file.readAsBytesSync().take(16)), isNot(startsWith('SQLite format 3')));
      final Database plain = sqlite3.open(store.path);
      expect(() => plain.select('SELECT * FROM queued_command'), throwsA(isA<SqliteException>()));
      plain.close();
      expect(() => openLocalDatabase(store.path, 'a' * 64), throwsA(isA<LocalDatabaseKeyError>()));
      // the right key opens it and the data is back
      final LocalStore again = await test.open();
      expect(again.commands.byId('c1')!.payload, <String, Object?>{'report_id': 'secret-marker-in-payload'});
    });

    test('a key that is not hexadecimal is refused before it reaches the PRAGMA (no injection through the key)', () {
      final Directory directory = Directory.systemTemp.createTempSync('machvon-key-');
      addTearDown(() => directory.deleteSync(recursive: true));
      expect(() => openLocalDatabase('${directory.path}/x.db', "ab'; DROP TABLE meta; --"), throwsArgumentError);
    });

    test('each tenant and each user has a file of their own, named by a digest that names nobody', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore a = await test.open();
      final LocalStore b = await test.open(tenantId: 'tenant-b');
      final LocalStore c = await test.open(userId: 'user-2');
      expect(<String>{a.path, b.path, c.path}, hasLength(3));
      expect(a.path, isNot(contains('tenant-a')));
      expect(a.path, isNot(contains('user-1')));
      a.commands.insert(command('only-in-a'));
      expect(b.commands.all(), isEmpty);
      expect(c.commands.all(), isEmpty);
      expect(identical(a, await test.open()), isTrue);
    });

    test('the schema is migrated by version, once, and a database from a newer application is not opened', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore store = await test.open();
      store.setMeta('x', '1');
      store.close();
      final LocalStore again = await test.open();
      expect(again.meta('x'), '1');
      expect(again.meta('missing'), isNull);
      again.close();
      final String key = test.keys.keys.values.single;
      final Database database = sqlite3.open(again.path)..execute("PRAGMA key = '$key'");
      database.execute('PRAGMA user_version = ${kLocalSchemaVersion + 1}');
      database.close();
      await expectLater(test.open(), throwsStateError);
    });

    test('purge removes the file, its journals and its key, so nothing of the tenant can be read again', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore store = await test.open();
      store.commands.insert(command('c1'));
      final LocalStore other = await test.open(tenantId: 'tenant-b');
      other.commands.insert(command('c2'));
      await test.storage.purge(tenantId: 'tenant-a', userId: 'user-1');
      expect(File(store.path).existsSync(), isFalse);
      expect(File('${store.path}-wal').existsSync(), isFalse);
      expect(test.keys.keys.containsKey(OfflineStorage.scopeOf('tenant-a', 'user-1')), isFalse);
      expect(store.isClosed, isTrue);
      expect(other.commands.byId('c2'), isNotNull);
      final LocalStore fresh = await test.open();
      expect(fresh.commands.all(), isEmpty);
      await test.storage.purgeAll();
      expect(test.directory.listSync().where((FileSystemEntity e) => e.path.endsWith('.db')), isEmpty);
      expect(test.keys.keys, isEmpty);
    });

    test('a transaction keeps all of its changes or none', () async {
      final TestStorage test = TestStorage.create();
      final LocalStore store = await test.open();
      expect(
        () => store.transaction<void>(() {
          store.commands.insert(command('c1'));
          store.commands.insert(command('c2', key: 'key-0000000000000001'));
        }),
        throwsA(isA<SqliteException>()),
      );
      expect(store.commands.all(), isEmpty);
    });

    test('the key lives in the secure storage of the platform: made once for a scope, found again, 256 bits, removed with the scope', () async {
      TestWidgetsFlutterBinding.ensureInitialized();
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      final SecureDatabaseKeyStore keys = SecureDatabaseKeyStore();
      final String first = await keys.keyFor('scope-a');
      expect(first, matches(RegExp(r'^[0-9a-f]{64}$')));
      expect(await keys.keyFor('scope-a'), first);
      expect(await keys.keyFor('scope-b'), isNot(first));
      await keys.delete('scope-a');
      expect(await keys.keyFor('scope-a'), isNot(first), reason: 'a deleted key is never brought back');
      expect(newDatabaseKey(), isNot(newDatabaseKey()));
    });
  });
}
