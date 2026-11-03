import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/api/dart_io_transport.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';

class _Server {
  _Server(this.server);

  final HttpServer server;
  final List<HttpRequest> requests = <HttpRequest>[];
  final List<String> bodies = <String>[];

  Uri get base => Uri.parse('http://127.0.0.1:${server.port}');

  static Future<_Server> start(Future<void> Function(HttpRequest request) handler) async {
    final _Server instance = _Server(await HttpServer.bind(InternetAddress.loopbackIPv4, 0));
    instance.server.listen((HttpRequest request) async {
      instance.requests.add(request);
      instance.bodies.add(await utf8.decoder.bind(request).join());
      await handler(request);
    });
    return instance;
  }

  Future<void> close() => server.close(force: true);
}

class _Fixed implements HttpTransport {
  const _Fixed(this.result);

  final HttpResult result;

  @override
  Future<HttpResult> send(HttpCall call) async => result;
}

class _Throwing implements HttpTransport {
  const _Throwing(this.error);

  final Object error;

  @override
  Future<HttpResult> send(HttpCall call) async => throw error;
}

HttpCall _get(Uri url, {Map<String, String> headers = const <String, String>{}}) =>
    HttpCall(method: 'GET', url: url, headers: headers);

void main() {
  group('TK-MOB-001-2 the transport of the application', () {
    test('it sends the method, the headers and the body, and reports status, headers in lower case and body', () async {
      final _Server server = await _Server.start((HttpRequest request) async {
        request.response
          ..statusCode = 201
          ..headers.set('X-Correlation-Id', 'abc')
          ..write('{"ok":true}');
        await request.response.close();
      });
      addTearDown(server.close);
      final DartIoHttpTransport transport = DartIoHttpTransport(allowInsecureLoopback: true);

      final HttpResult result = await transport.send(
        HttpCall(
          method: 'POST',
          url: server.base.replace(path: '/x'),
          headers: const <String, String>{'authorization': 'Bearer t', 'idempotency-key': 'k1'},
          body: '{"a":1}',
        ),
      );

      expect(result.status, 201);
      expect(result.headers['x-correlation-id'], 'abc');
      expect(result.body, '{"ok":true}');
      expect(server.requests.single.method, 'POST');
      expect(server.requests.single.headers.value('authorization'), 'Bearer t');
      expect(server.requests.single.headers.value('idempotency-key'), 'k1');
      expect(server.bodies.single, '{"a":1}');
    });

    test('it does not follow a redirect, so the bearer token never travels to another address', () async {
      final _Server other = await _Server.start((HttpRequest request) async => request.response.close());
      addTearDown(other.close);
      final _Server server = await _Server.start((HttpRequest request) async {
        request.response
          ..statusCode = 302
          ..headers.set('location', '${other.base}/stolen');
        await request.response.close();
      });
      addTearDown(server.close);
      final DartIoHttpTransport transport = DartIoHttpTransport(allowInsecureLoopback: true);

      final HttpResult result = await transport.send(
        _get(server.base.replace(path: '/x'), headers: const <String, String>{'authorization': 'Bearer t'}),
      );

      expect(result.status, 302);
      expect(other.requests, isEmpty);
    });

    test('it refuses plain http unless a loopback address was allowed, and never sends the request', () async {
      final _Server server = await _Server.start((HttpRequest request) async => request.response.close());
      addTearDown(server.close);

      await expectLater(DartIoHttpTransport().send(_get(server.base.replace(path: '/x'))), throwsStateError);
      expect(server.requests, isEmpty);
    });

    test('it refuses an answer larger than the limit', () async {
      final _Server server = await _Server.start((HttpRequest request) async {
        request.response.add(List<int>.filled(maxResponseBytes + 1, 0x61));
        await request.response.close();
      });
      addTearDown(server.close);

      await expectLater(
        DartIoHttpTransport(allowInsecureLoopback: true).send(_get(server.base.replace(path: '/x'))),
        throwsA(isA<HttpException>()),
      );
    });

    test('an unreachable server throws, which the client reports as NETWORK_ERROR', () async {
      final HttpServer closed = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final int port = closed.port;
      await closed.close(force: true);
      final MachvonApiClient client = MachvonApiClient(
        baseUrl: Uri.parse('http://127.0.0.1:$port'),
        transport: DartIoHttpTransport(allowInsecureLoopback: true),
        token: () async => null,
      );

      await expectLater(
        client.execute('getAuditOverview'),
        throwsA(isA<ApiError>().having((ApiError e) => e.code, 'code', networkErrorCode)),
      );
    });
  });

  group('TK-MOB-001-2 what the requests show about the connection', () {
    final HttpCall call = _get(Uri.parse('https://api.test/x'));

    test('any answer, whatever its status, means the server is reachable', () async {
      final List<Reachability> seen = <Reachability>[];
      final ObservingTransport transport =
          ObservingTransport(const _Fixed(HttpResult(status: 500, headers: <String, String>{}, body: '')), seen.add);

      await transport.send(call);

      expect(seen, <Reachability>[Reachability.online]);
    });

    test('a refused or unresolved connection means offline, and the error still reaches the caller', () async {
      final List<Reachability> seen = <Reachability>[];
      final ObservingTransport transport = ObservingTransport(const _Throwing(SocketException('no route')), seen.add);

      await expectLater(transport.send(call), throwsA(isA<SocketException>()));

      expect(seen, <Reachability>[Reachability.offline]);
    });

    test('a time-out says nothing about the connection', () async {
      final List<Reachability> seen = <Reachability>[];
      final ObservingTransport transport = ObservingTransport(_Throwing(TimeoutException('slow')), seen.add);

      await expectLater(transport.send(call), throwsA(isA<TimeoutException>()));

      expect(seen, isEmpty);
    });
  });
}
