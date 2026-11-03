import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/api/answer.dart';
import 'package:machvon_mobile/core/api/problem.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/session/session.dart';

import '../support/harness.dart';

const String _fixtureFile = '../../packages/mobile-api-client/test/fixtures/responses.fixtures.json';

Map<String, Object?> _fixtures() => jsonDecode(File(_fixtureFile).readAsStringSync()) as Map<String, Object?>;

Object? _copy(Object? value) => jsonDecode(jsonEncode(value));

/// The path parameters of an operation, each set to a placeholder, so any operation can be called.
Map<String, Object?> _pathOf(String operationId) => <String, Object?>{
      for (final Match match in RegExp(r'\{([^{}/]+)\}').allMatches(operationDescriptors[operationId]!.path)) match.group(1)!: 'x',
    };

ProviderContainer _container(HttpTransport transport) {
  final ProviderContainer container = ProviderContainer(
    overrides: [
      appConfigProvider.overrideWithValue(testConfig),
      httpTransportProvider.overrideWithValue(transport),
      sessionProvider.overrideWith(FakeSession.new),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AC-ST-MOB-001-3 UAT-NFR-ACCESSIBILITY-02 the generated client wired into the application reads the recorded responses', () {
    test('100 percent of the recorded responses deserialize through the client of the application', () async {
      final Map<String, Object?> fixtures = _fixtures();
      expect(fixtures.length, greaterThan(800));
      final ProviderContainer container = _container(FakeTransport((HttpCall call) async => throw StateError('replaced per operation')));
      final List<String> failed = <String>[];
      for (final MapEntry<String, Object?> entry in fixtures.entries) {
        final MachvonApiClient client = MachvonApiClient(
          baseUrl: testConfig.apiBaseUrl,
          transport: FakeTransport((HttpCall call) async => FakeTransport.json(200, _copy(entry.value))),
          token: () async => 'test-token',
        );
        try {
          final Object? json = await client.execute(entry.key, path: _pathOf(entry.key));
          decodeAnswer(entry.key, json);
        } on Object catch (error) {
          failed.add('${entry.key}: $error');
        }
      }
      expect(failed, isEmpty, reason: '${fixtures.length - failed.length} of ${fixtures.length} operations read');
      expect(container.read(apiClientProvider), isA<MachvonApiClient>());
    });

    test('every operation that answers with JSON has a recorded response, and no response is left without an operation', () {
      expect(_fixtures().keys.toSet(), responseDecoders.keys.toSet());
    });

    test('a field renamed by the backend fails with the member named, and the screen shows it as CONTRACT_MISMATCH', () async {
      final Map<String, Object?> renamed = <String, Object?>{...(_copy(_fixtures()['suspendMembership'])! as Map<String, Object?>)};
      renamed['resource_ver'] = renamed.remove('resource_version');
      final MachvonApiClient client = MachvonApiClient(
        baseUrl: testConfig.apiBaseUrl,
        transport: FakeTransport((HttpCall call) async => FakeTransport.json(200, renamed)),
        token: () async => 'test-token',
      );

      final Object? json = await client.execute('suspendMembership', path: _pathOf('suspendMembership'));
      Object? failure;
      try {
        decodeAnswer('suspendMembership', json);
      } on ContractMismatch catch (mismatch) {
        failure = mismatch;
      }

      expect(failure, isA<ContractMismatch>().having((ContractMismatch e) => e.path, 'path', endsWith('.resource_version')));
      expect(ProblemView.from(failure!).code, contractMismatchCode);
    });

    test('a field whose type changed fails the same way', () {
      final Map<String, Object?> changed = <String, Object?>{...(_copy(_fixtures()['suspendMembership'])! as Map<String, Object?>)};
      changed['resource_version'] = 'seven';
      expect(() => decodeAnswer('suspendMembership', changed), throwsA(isA<ContractMismatch>()));
    });

    test('an operation that answers without a body has nothing to decode', () {
      expect(decodeAnswer('operation-without-decoder', null), isNull);
    });
  });

  group('TK-MOB-001-2 the client of the application', () {
    test('every request carries the bearer token of the session, the language of the interface and a correlation id', () async {
      final FakeTransport transport = FakeTransport((HttpCall call) async => FakeTransport.json(200, _fixtures()['getAuditOverview']));
      final ProviderContainer container = _container(transport);

      await container.read(apiClientProvider).execute('getAuditOverview');

      final HttpCall call = transport.calls.single;
      expect(call.url.toString(), startsWith('https://api.test/v1/audit-overview'));
      expect(call.headers['authorization'], 'Bearer test-token');
      expect(call.headers['accept-language'], anyOf('vi', 'en'));
      expect(call.headers['x-correlation-id'], isNotEmpty);
    });

    test('a signed-out session sends no authorization header', () async {
      final FakeTransport transport = FakeTransport((HttpCall call) async => FakeTransport.json(200, _fixtures()['getAuditOverview']));
      final ProviderContainer container = ProviderContainer(
        overrides: [
          appConfigProvider.overrideWithValue(testConfig),
          httpTransportProvider.overrideWithValue(transport),
        ],
      );
      addTearDown(container.dispose);

      await container.read(apiClientProvider).execute('getAuditOverview');

      expect(transport.calls.single.headers.containsKey('authorization'), isFalse);
    });

    test('a problem answer becomes an ApiError that maps to the state and keeps the correlation id', () async {
      final FakeTransport transport = FakeTransport(
        (HttpCall call) async => FakeTransport.json(
          403,
          <String, Object?>{'type': 'about:blank', 'title': 'x', 'status': 403, 'code': 'SCOPE_DENIED', 'correlationId': 'c-1'},
        ),
      );
      final ProviderContainer container = _container(transport);

      final Object error = await container.read(apiClientProvider).execute('getAuditOverview').then<Object>((Object? _) => 'no error', onError: (Object e) => e);

      final ProblemView view = ProblemView.from(error);
      expect(view.code, 'SCOPE_DENIED');
      expect(view.correlationId, 'c-1');
    });
  });
}
