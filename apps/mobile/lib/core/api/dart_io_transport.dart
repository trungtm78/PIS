import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:machvon_api_client/machvon_api_client.dart';

import '../connectivity/reachability.dart';

const Duration _connectionTimeout = Duration(seconds: 15);
const Duration _requestTimeout = Duration(seconds: 30);

/// An answer larger than this is refused: no screen of the application needs one, and an unbounded body is a memory
/// risk on a phone.
const int maxResponseBytes = 8 * 1024 * 1024;

/// The [HttpTransport] of the application, on `dart:io`.
///
/// It sends exactly what the client built, never follows a redirect (the bearer token would travel to the target of the
/// redirect), refuses plain http unless the configuration allowed a loopback address, and gives up after a time-out. It
/// throws when no answer arrives, which the client reports as `NETWORK_ERROR`.
final class DartIoHttpTransport implements HttpTransport {
  DartIoHttpTransport({this.allowInsecureLoopback = false, HttpClient? client})
      : _client = (client ?? HttpClient())..connectionTimeout = _connectionTimeout;

  final bool allowInsecureLoopback;
  final HttpClient _client;

  @override
  Future<HttpResult> send(HttpCall call) async {
    if (call.url.scheme != 'https' && !(allowInsecureLoopback && call.url.scheme == 'http')) {
      throw StateError('refusing to send a request over ${call.url.scheme}');
    }
    final HttpClientRequest request = await _client.openUrl(call.method, call.url).timeout(_requestTimeout);
    request.followRedirects = false;
    call.headers.forEach(request.headers.set);
    final String? body = call.body;
    if (body != null) request.add(utf8.encode(body));
    final HttpClientResponse response = await request.close().timeout(_requestTimeout);
    final Map<String, String> headers = <String, String>{};
    response.headers.forEach((String name, List<String> values) => headers[name.toLowerCase()] = values.join(', '));
    return HttpResult(status: response.statusCode, headers: headers, body: await _readBody(response));
  }

  Future<String> _readBody(HttpClientResponse response) async {
    final List<int> bytes = <int>[];
    await for (final List<int> chunk in response.timeout(_requestTimeout)) {
      bytes.addAll(chunk);
      if (bytes.length > maxResponseBytes) {
        throw const HttpException('the response is larger than the limit');
      }
    }
    return utf8.decode(bytes, allowMalformed: true);
  }
}

/// Reports what the requests show about the connection: an answer, whatever its status, means the server is reachable;
/// a refused or unresolved connection means the device is offline. A time-out says nothing (the device may be online
/// and the server slow) and leaves the last observation as it was.
final class ObservingTransport implements HttpTransport {
  const ObservingTransport(this._inner, this._report);

  final HttpTransport _inner;
  final void Function(Reachability value) _report;

  @override
  Future<HttpResult> send(HttpCall call) async {
    try {
      final HttpResult result = await _inner.send(call);
      _report(Reachability.online);
      return result;
    } on SocketException {
      _report(Reachability.offline);
      rethrow;
    }
  }
}
