import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/format/format.dart';
import 'package:machvon_mobile/features/read_support/attempts.dart';
import 'package:machvon_mobile/features/read_support/paged.dart';
import 'package:machvon_mobile/features/read_support/read_cache.dart';
import 'package:machvon_mobile/features/read_support/read_support_strings.dart';
import 'package:machvon_mobile/features/read_support/wire.dart';

import '../support/scripted_server.dart';

void main() {
  group('UAT-AC240 money is exact: whole dong as strings, added and divided on integers', () {
    test('the sum is exact and leaves out what is not an amount of whole dong; 100 + 200 + 30 + 70 + 0 + 20 is 420 million, never 460', () {
      expect(sumDong(<String>['100000000', '200000000', '30000000', '70000000', '0', '20000000']), '420000000');
      expect(sumDong(<String>['1', 'abc', '1.5', '2']), '3');
      expect(sumDong(<String>[]), '0');
      expect(sumDong(<String>['123456789012345678901234', '1']), '123456789012345678901235', reason: 'beyond what a double holds');
    });

    test('whole dong are grouped and a fall is negative', () {
      expect(formatDong('420000000', 'vi'), '420.000.000');
      expect(formatDong('420000000', 'en'), '420,000,000');
      expect(formatDong('-1234', 'vi'), '-1.234');
      expect(formatDong('12', 'vi'), '12');
      expect(formatDong('1.5', 'vi'), '1.5');
      expect(differenceDong('90000000', '100000000'), '-10000000');
      expect(differenceDong('100', '100'), '0');
    });

    test('a percent keeps the digits the server gave it and takes the decimal mark of the language', () {
      expect(formatPercent('14.0000', 'vi'), '14,0000');
      expect(formatPercent('14.0000', 'en'), '14.0000');
      expect(formatPercent('-2.5', 'vi'), '-2,5');
      expect(formatPercent('n/a', 'vi'), 'n/a');
    });
  });

  group('moments are shown in Vietnam time (UTC+7), as the calendar of the tenant counts them', () {
    test('instants and days', () {
      expect(formatMoment('2026-10-31T09:00:00Z'), '31/10/2026 16:00');
      expect(formatMoment('2026-10-31T20:30:00Z'), '01/11/2026 03:30');
      expect(formatMoment('not an instant'), 'not an instant');
      expect(formatDay('2026-10-31'), '31/10/2026');
      expect(formatDay('2026-10-31T20:30:00Z'), '01/11/2026');
      expect(formatDay('???'), '???');
      expect(vietnamDayOf(DateTime.utc(2026, 11, 3, 3)), '2026-11-03');
      expect(vietnamDayOf(DateTime.utc(2026, 11, 3, 18)), '2026-11-04');
    });
  });

  group('wire readers accept exactly the shapes the contract names', () {
    test('records, lists, text, whole numbers, counts, amounts and days', () {
      expect(asRecord(<String, Object?>{'a': 1}), isNotNull);
      expect(asRecord(<Object?, Object?>{'a': 1})!['a'], 1);
      expect(asRecord('x'), isNull);
      expect(listOf(<Object?>[1]), hasLength(1));
      expect(listOf(<int>[1, 2]), hasLength(2));
      expect(listOf('x'), isEmpty);
      expect(text(1), isNull);
      expect(filled(''), isNull);
      expect(filled('a'), 'a');
      expect(whole(3), 3);
      expect(whole(3.0), 3);
      expect(whole(3.5), isNull);
      expect(whole('3'), isNull);
      expect(count(-1), 0);
      expect(count(4), 4);
      expect(count('x'), 0);
      expect(dong('-12'), '-12');
      expect(dong(12), isNull, reason: 'money is never a JSON number');
      expect(dong('1.5'), isNull);
      expect(unsignedDong('-1'), isNull);
      expect(unsignedDong('0'), '0');
      expect(unsignedDong('1' * 25), isNull, reason: 'more than 24 digits is not a ledger amount');
      expect(day('2026-10-31'), '2026-10-31');
      expect(day('2026-10-31T00:00:00Z'), isNull);
    });
  });

  group('AC-ST-MOB-010-1 the cache stores answers per tenant and person, and is emptied on request', () {
    test('a copy is read back only under its own scope', () async {
      final InMemoryReadCache cache = InMemoryReadCache();
      const CacheScope a = CacheScope(tenantId: 't-a', userId: 'u-1');
      const CacheScope b = CacheScope(tenantId: 't-b', userId: 'u-1');
      await cache.write(a, 'k', CacheEntry(raw: 1, fetchedAt: DateTime.utc(2026)));
      expect((await cache.read(a, 'k'))!.raw, 1);
      expect(await cache.read(b, 'k'), isNull);
      expect(await cache.read(const CacheScope(tenantId: 't-a', userId: 'u-2'), 'k'), isNull);
      expect(a == const CacheScope(tenantId: 't-a', userId: 'u-1'), isTrue);
      expect(a.hashCode, const CacheScope(tenantId: 't-a', userId: 'u-1').hashCode);
      await cache.forget(a, 'k');
      expect(await cache.read(a, 'k'), isNull);
      await cache.write(a, 'k', CacheEntry(raw: 1, fetchedAt: DateTime.utc(2026)));
      await cache.clear();
      expect(cache.length, 0);
    });
  });

  group('AttemptRegistry: one key per intention, as on the web', () {
    test('the same payload keeps its key, another payload is a new intention, a success and a final refusal end it, a lost answer keeps it', () {
      int made = 0;
      final AttemptRegistry registry = AttemptRegistry(() => CommandAttempt('key-${made += 1}'));
      final CommandAttempt first = registry.forPayload('p');
      expect(registry.forPayload('p').key, first.key);
      expect(registry.forPayload('q').key, isNot(first.key));
      registry.done();
      expect(registry.forPayload('q').key, 'key-3');

      registry.ended(const ApiError(status: 0, code: 'NETWORK_ERROR', correlationId: 'c'));
      expect(registry.forPayload('q').key, 'key-3', reason: 'a lost answer keeps the attempt');
      registry.ended(const ApiError(status: 500, code: 'INTERNAL_ERROR', correlationId: 'c'));
      expect(registry.forPayload('q').key, 'key-3', reason: 'a 5xx is not final');
      registry.ended(const ApiError(status: 408, code: 'X', correlationId: 'c'));
      registry.ended(const ApiError(status: 429, code: 'RATE_LIMIT', correlationId: 'c'));
      registry.ended(const ApiError(status: 409, code: 'IDEMPOTENCY_IN_PROGRESS', correlationId: 'c'));
      expect(registry.forPayload('q').key, 'key-3');
      registry.ended(const ApiError(status: 403, code: 'MFA_REQUIRED', correlationId: 'c'));
      expect(registry.forPayload('q').key, 'key-4', reason: 'a final refusal ends the intention');
      registry.ended(StateError('not an api error'));
      expect(registry.forPayload('q').key, 'key-4');
      expect(isDefinitiveRefusal(StateError('x')), isFalse);
    });
  });

  group('readMerged follows the pages and keeps what the first page says about the whole', () {
    MachvonApiClient client(ScriptedServer server) => MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 't');

    test('items of every page in order, the counts of the first page, no cursor at the end', () async {
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/home/my-work', (HttpCall call) {
        final String? cursor = call.url.queryParameters['cursor'];
        if (cursor == null) return <String, Object?>{'items': <Object?>[1, 2], 'counts': <String, Object?>{'total': 3}, 'next_cursor': 'c1'};
        return <String, Object?>{'items': <Object?>[3], 'counts': <String, Object?>{'total': 99}, 'next_cursor': null};
      });
      final Json merged = await readMerged(client(server), 'getMyWork');
      expect(merged['items'], <Object?>[1, 2, 3]);
      expect((merged['counts']! as Map<String, Object?>)['total'], 3);
      expect(merged['next_cursor'], isNull);
    });

    test('the limit of pages leaves the cursor of the next, a repeated cursor stops, and an answer that is not an object fails', () async {
      final ScriptedServer limited = ScriptedServer()..on('GET', '/home/my-work', (HttpCall call) => <String, Object?>{'items': <Object?>[1], 'next_cursor': 'c${call.url.queryParameters['cursor'] ?? '0'}x'});
      final Json merged = await readMerged(client(limited), 'getMyWork', maxPages: 2);
      expect((merged['items']! as List<Object?>), hasLength(2));
      expect(merged['next_cursor'], isNotNull);

      final ScriptedServer looping = ScriptedServer()..on('GET', '/home/my-work', (_) => <String, Object?>{'items': <Object?>[1], 'next_cursor': 'same'});
      final Json stopped = await readMerged(client(looping), 'getMyWork');
      expect((stopped['items']! as List<Object?>), hasLength(2));
      expect(stopped['next_cursor'], isNull);

      final ScriptedServer broken = ScriptedServer()..on('GET', '/home/my-work', (_) => <Object?>[1]);
      await expectLater(readMerged(client(broken), 'getMyWork'), throwsA(isA<ApiError>()));
      final ScriptedServer gone = ScriptedServer()..offline = true;
      await expectLater(readMerged(client(gone), 'getMyWork'), throwsA(isA<ApiError>().having((ApiError e) => e.code, 'code', 'NETWORK_ERROR')));
    });
  });

  group('the words shared by the reading screens', () {
    test('both languages carry the same keys and none says the data is the newest', () {
      expect(readSupportStrings.vi.keys.toSet(), readSupportStrings.en.keys.toSet());
      for (final String text in <String>[...readSupportStrings.vi.values, ...readSupportStrings.en.values]) {
        expect(text.toLowerCase(), isNot(contains('latest')));
        expect(text.toLowerCase(), isNot(contains('newest')));
        expect(text.toLowerCase(), isNot(contains('mới nhất')));
      }
    });

  });
}
