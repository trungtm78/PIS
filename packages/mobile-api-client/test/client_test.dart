import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

/// Records every call and answers from a script; an entry that is an exception is thrown instead of returned.
final class FakeTransport implements HttpTransport {
  FakeTransport(this.script);

  final List<Object> script;
  final List<HttpCall> calls = <HttpCall>[];

  @override
  Future<HttpResult> send(HttpCall call) async {
    calls.add(call);
    final Object next = script.length > 1 ? script.removeAt(0) : script.first;
    if (next is HttpResult) return next;
    throw next;
  }
}

HttpResult ok(Object? body, {int status = 200}) => HttpResult(
      status: status,
      headers: const <String, String>{'content-type': 'application/json'},
      body: jsonEncode(body),
    );

HttpResult problem(int status, String code, {Map<String, Object?> extra = const <String, Object?>{}, Map<String, String> headers = const <String, String>{}}) =>
    HttpResult(
      status: status,
      headers: <String, String>{'content-type': 'application/problem+json', ...headers},
      body: jsonEncode(<String, Object?>{'type': 'urn:x', 'title': 't', 'status': status, 'code': code, 'correlation_id': 'srv-corr', ...extra}),
    );

MachvonApiClient clientFor(FakeTransport transport, {List<Duration>? waits, Future<String?> Function()? token}) {
  var keys = 0;
  return MachvonApiClient(
    baseUrl: Uri.parse('https://api.example.test/v1/'),
    transport: transport,
    token: token ?? () async => 'token-1',
    locale: () => 'vi',
    newKey: () => 'key-${keys++}-0123456789abcdef',
    newCorrelationId: () => 'corr-1',
    delay: (Duration wait) async => waits?.add(wait),
  );
}

void main() {
  group('commands', () {
    test('send the idempotency key, the bearer token, the locale and the JSON body of a typed request', () async {
      final FakeTransport transport = FakeTransport(<Object>[ok(<String, Object?>{'ok': true}, status: 201)]);
      final MachvonApiClient client = clientFor(transport);

      final Object? answer = await client.execute('createOrganizationUnit', body: const _Body(<String, Object?>{'code': 'ABC', 'nested': _Body(<String, Object?>{'a': 1})}));

      expect(answer, <String, Object?>{'ok': true});
      final HttpCall call = transport.calls.single;
      expect(call.method, 'POST');
      expect(call.url.toString(), 'https://api.example.test/v1/org-units');
      expect(call.headers['idempotency-key'], 'key-0-0123456789abcdef');
      expect(call.headers['authorization'], 'Bearer token-1');
      expect(call.headers['accept-language'], 'vi');
      expect(call.headers['x-correlation-id'], 'corr-1');
      expect(call.headers['content-type'], 'application/json');
      expect(call.headers.containsKey('if-match'), isFalse);
      expect(jsonDecode(call.body!), <String, Object?>{'code': 'ABC', 'nested': <String, Object?>{'a': 1}});
    });

    test('send If-Match with the version the caller saw, quoted, for a versioned operation', () async {
      final FakeTransport transport = FakeTransport(<Object>[ok(<String, Object?>{})]);
      await clientFor(transport).execute('moveOrganizationUnit', path: <String, Object?>{'unitId': 'u 1/2'}, body: const _Body(<String, Object?>{'new_parent_id': 'p'}), ifMatchVersion: 7);
      final HttpCall call = transport.calls.single;
      expect(call.headers['if-match'], '"7"');
      expect(call.url.path, '/v1/org-units/u%201%2F2/move');
    });

    test('reuse the key of an attempt, so a retry of the same intention is executed once, and start a new key for a new one', () async {
      final FakeTransport transport = FakeTransport(<Object>[ok(<String, Object?>{})]);
      final MachvonApiClient client = clientFor(transport);
      const CommandAttempt attempt = CommandAttempt('attempt-key-0123456789');
      await client.execute('createOrganizationUnit', body: const _Body(<String, Object?>{}), attempt: attempt);
      await client.execute('createOrganizationUnit', body: const _Body(<String, Object?>{}), attempt: attempt);
      await client.execute('createOrganizationUnit', body: const _Body(<String, Object?>{}));
      expect(transport.calls.map((HttpCall call) => call.headers['idempotency-key']), <String?>['attempt-key-0123456789', 'attempt-key-0123456789', 'key-0-0123456789abcdef']);
    });

    test('retry IDEMPOTENCY_IN_PROGRESS with the same key after the wait the server asked for, capped at ten seconds', () async {
      final FakeTransport transport = FakeTransport(<Object>[
        problem(409, 'IDEMPOTENCY_IN_PROGRESS', headers: const <String, String>{'retry-after': '2'}),
        problem(409, 'IDEMPOTENCY_IN_PROGRESS', headers: const <String, String>{'retry-after': '99'}),
        ok(<String, Object?>{'done': true}),
      ]);
      final List<Duration> waits = <Duration>[];
      final Object? answer = await clientFor(transport, waits: waits).execute('createOrganizationUnit', body: const _Body(<String, Object?>{}));
      expect(answer, <String, Object?>{'done': true});
      expect(waits, <Duration>[const Duration(seconds: 2), const Duration(seconds: 10)]);
      expect(transport.calls.map((HttpCall call) => call.headers['idempotency-key']).toSet(), hasLength(1));
    });

    test('give up on IDEMPOTENCY_IN_PROGRESS after five retries', () async {
      final FakeTransport transport = FakeTransport(<Object>[problem(409, 'IDEMPOTENCY_IN_PROGRESS')]);
      await expectLater(
        clientFor(transport).execute('createOrganizationUnit', body: const _Body(<String, Object?>{})),
        throwsA(isA<ApiError>().having((ApiError error) => error.code, 'code', 'IDEMPOTENCY_IN_PROGRESS')),
      );
      expect(transport.calls, hasLength(6));
    });

    test('do not retry any other failure', () async {
      final FakeTransport transport = FakeTransport(<Object>[problem(403, 'MFA_REQUIRED')]);
      await expectLater(
        clientFor(transport).execute('createOrganizationUnit', body: const _Body(<String, Object?>{})),
        throwsA(isA<ApiError>().having((ApiError error) => error.code, 'code', 'MFA_REQUIRED')),
      );
      expect(transport.calls, hasLength(1));
    });

    test('refuse an unknown operation and a missing path parameter before anything is sent', () async {
      final FakeTransport transport = FakeTransport(<Object>[ok(<String, Object?>{})]);
      final MachvonApiClient client = clientFor(transport);
      await expectLater(client.execute('noSuchOperation'), throwsArgumentError);
      await expectLater(client.execute('moveOrganizationUnit', body: const _Body(<String, Object?>{}), ifMatchVersion: 1), throwsArgumentError);
      expect(transport.calls, isEmpty);
    });
  });

  group('reads', () {
    test('are plain GETs with the query string, without an idempotency key or a body', () async {
      final FakeTransport transport = FakeTransport(<Object>[ok(<String, Object?>{'items': <Object?>[]})]);
      await clientFor(transport).execute('get_resources_organization_unit', query: <String, Object?>{'limit': 20, 'tag': <String>['a', 'b c'], 'skip': null});
      final HttpCall call = transport.calls.single;
      expect(call.method, 'GET');
      expect(call.url.toString(), 'https://api.example.test/v1/resources/organization_unit?limit=20&tag=a&tag=b%20c');
      expect(call.headers.containsKey('idempotency-key'), isFalse);
      expect(call.body, isNull);
    });

    test('readAll follows next_cursor and stops on a repeated cursor', () async {
      final FakeTransport transport = FakeTransport(<Object>[
        ok(<String, Object?>{'items': <Object?>[1, 2], 'next_cursor': 'c1'}),
        ok(<String, Object?>{'items': <Object?>[3], 'next_cursor': null}),
      ]);
      expect(await clientFor(transport).readAll('get_resources_organization_unit'), <Object?>[1, 2, 3]);
      expect(transport.calls[1].url.query, 'cursor=c1');

      final FakeTransport loop = FakeTransport(<Object>[ok(<String, Object?>{'items': <Object?>[], 'next_cursor': 'same'})]);
      await expectLater(clientFor(loop).readAll('get_resources_organization_unit'), throwsA(isA<ApiError>()));
    });
  });

  group('errors', () {
    test('keep the code, the safe detail, the extensions and the retry hint of a problem answer', () async {
      final FakeTransport transport = FakeTransport(<Object>[
        problem(409, 'VERSION_CONFLICT', extra: const <String, Object?>{'detail': 'unit', 'current_version': 8}, headers: const <String, String>{'retry-after': '3'}),
      ]);
      final ApiError error = await _failure(clientFor(transport).execute('createOrganizationUnit', body: const _Body(<String, Object?>{})));
      expect(error.status, 409);
      expect(error.code, 'VERSION_CONFLICT');
      expect(error.detail, 'unit');
      expect(error.extensions, <String, Object?>{'current_version': 8});
      expect(error.correlationId, 'srv-corr');
      expect(error.retryAfterSeconds, 3);
      expect(error.toString(), 'ApiError(VERSION_CONFLICT)');
    });

    test('turn a gateway page into the nearest registered code without exposing its text', () async {
      final FakeTransport transport = FakeTransport(<Object>[
        const HttpResult(status: 502, headers: <String, String>{'content-type': 'text/html'}, body: '<html>secret upstream.internal</html>'),
      ]);
      final ApiError error = await _failure(clientFor(transport).execute('get_resources_organization_unit'));
      expect(error.code, 'INTERNAL_ERROR');
      expect(error.toString(), isNot(contains('secret')));
      expect(error.detail, isNull);
    });

    test('map a bare status to its code and a JSON answer without a code to the validation code', () async {
      expect((await _failure(clientFor(FakeTransport(<Object>[const HttpResult(status: 401, headers: <String, String>{}, body: '')])).execute('get_resources_organization_unit'))).code, 'SESSION_EXPIRED');
      expect(
        (await _failure(clientFor(FakeTransport(<Object>[const HttpResult(status: 400, headers: <String, String>{'content-type': 'application/json'}, body: '{"x":1}')])).execute('get_resources_organization_unit'))).code,
        'VALIDATION_FAILED',
      );
    });

    test('report a request without an answer as NETWORK_ERROR and an unusable success body as INTERNAL_ERROR', () async {
      final ApiError offline = await _failure(clientFor(FakeTransport(<Object>[StateError('socket closed')])).execute('get_resources_organization_unit'));
      expect(offline.code, networkErrorCode);
      expect(offline.status, 0);
      final ApiError broken = await _failure(
        clientFor(FakeTransport(<Object>[const HttpResult(status: 200, headers: <String, String>{'content-type': 'application/json'}, body: '{"x"')])).execute('get_resources_organization_unit'),
      );
      expect(broken.code, 'INTERNAL_ERROR');
    });

    test('let an error of the token provider reach the caller untouched', () async {
      final FakeTransport transport = FakeTransport(<Object>[ok(<String, Object?>{})]);
      await expectLater(clientFor(transport, token: () async => throw StateError('no session')).execute('get_resources_organization_unit'), throwsStateError);
      expect(transport.calls, isEmpty);
    });
  });

  test('a 204 answer has no body', () async {
    final FakeTransport transport = FakeTransport(<Object>[const HttpResult(status: 204, headers: <String, String>{}, body: '')]);
    expect(await clientFor(transport).execute('createOrganizationUnit', body: const _Body(<String, Object?>{})), isNull);
  });

  test('newUuidV4 has the version and variant bits and is different every time', () {
    final String first = newUuidV4();
    expect(first, matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')));
    expect(newUuidV4(), isNot(first));
  });
}

Future<ApiError> _failure(Future<Object?> call) async {
  try {
    await call;
  } on ApiError catch (error) {
    return error;
  }
  fail('the call should have failed');
}

final class _Body implements RequestModel {
  const _Body(this.members);

  final Map<String, Object?> members;

  @override
  Map<String, Object?> toJson() => members;
}
