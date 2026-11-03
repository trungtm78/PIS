import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/api/dart_io_transport.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/read_support/clock.dart';
import 'package:machvon_mobile/features/read_support/read_support_feature.dart' as read_support;

import '../../support/harness.dart';

typedef Answer = FutureOr<HttpResult> Function(HttpCall call);

/// A server that answers by method and path, can be switched off (the connection is refused, as on a phone with no
/// signal), and records every call. Paths are written without the `/v1` of the base URL.
class ScriptedServer implements HttpTransport {
  ScriptedServer();

  final List<_Route> _routes = <_Route>[];
  final List<HttpCall> calls = <HttpCall>[];
  bool offline = false;

  /// Answers `GET /home/my-work` and the like with a JSON body; `:name` matches one path segment.
  void on(String method, String path, Object? Function(HttpCall call) body, {int status = 200}) {
    _routes.add(_Route(method, path, (HttpCall call) => FakeTransport.json(status, body(call))));
  }

  /// Answers with a problem document: the stable `code` the screens map.
  void refuse(String method, String path, int status, String code) {
    _routes.add(_Route(method, path, (HttpCall call) => HttpResult(status: status, headers: <String, String>{'content-type': 'application/problem+json'}, body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': code, 'status': status, 'code': code}))));
  }

  /// Answers with anything: a status without a body, a delay, a sequence.
  void answer(String method, String path, Answer answer) => _routes.add(_Route(method, path, answer));

  /// Answers every call, whatever the path: used to hold the server or to refuse everything.
  void answerAll(Answer answer) => _routes.add(_Route.any(answer));

  /// Refuses every call with a problem document.
  void refuseAll(int status, String code) => _routes.add(
        _Route.any(
          (HttpCall call) => HttpResult(
            status: status,
            headers: <String, String>{'content-type': 'application/problem+json'},
            body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': code, 'status': status, 'code': code}),
          ),
        ),
      );

  void clear() => _routes.clear();

  @override
  Future<HttpResult> send(HttpCall call) async {
    calls.add(call);
    if (offline) throw const SocketException('no connection');
    final String path = call.url.path.replaceFirst('/v1', '');
    for (final _Route route in _routes.reversed) {
      if (route.matches(call.method, path)) return route.answer(call);
    }
    return FakeTransport.json(404, <String, Object?>{'type': 'about:blank', 'title': 'RESOURCE_NOT_FOUND', 'status': 404, 'code': 'RESOURCE_NOT_FOUND'});
  }

  /// The calls made to one operation, in order.
  List<HttpCall> callsTo(String method, String path) =>
      calls.where((HttpCall call) => call.method == method && call.url.path.replaceFirst('/v1', '') == path).toList();
}

class _Route {
  _Route(this.method, String path, this.answer) : _pattern = RegExp('^${path.replaceAllMapped(RegExp(r':[a-zA-Z]+'), (Match _) => '[^/]+')}\$');

  _Route.any(this.answer)
      : method = '*',
        _pattern = RegExp('.*');

  final String method;
  final RegExp _pattern;
  final Answer answer;

  bool matches(String method, String path) => (this.method == '*' || this.method == method) && _pattern.hasMatch(path);
}

/// The instant the tests treat as now: the clock of the phone is only used for the age of a copy.
final DateTime kNow = DateTime.utc(2026, 11, 3, 3, 0);

/// Starts the application on the given features and the support feature, with the server in place of the network (behind
/// the same observer as the real transport, so a refused connection makes the application offline).
Future<ProviderContainer> pumpWithServer(
  WidgetTester tester, {
  required List<MobileFeature> features,
  required ScriptedServer server,
  String? location,
  FakeSession? session,
  DateTime Function()? now,
  List<Override> overrides = const <Override>[],
  Locale locale = const Locale('vi'),
}) {
  return pumpApp(
    tester,
    features: <MobileFeature>[read_support.feature, ...features],
    location: location,
    session: session,
    locale: locale,
    overrides: <Override>[
      httpTransportProvider.overrideWith((Ref ref) => ObservingTransport(server, ref.read(reachabilityProvider.notifier).report)),
      clockProvider.overrideWithValue(now ?? () => kNow),
      ...overrides,
    ],
  );
}
