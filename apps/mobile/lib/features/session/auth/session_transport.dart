import 'dart:convert';

import 'package:machvon_api_client/machvon_api_client.dart';

/// Tells the session what the API answered, before the client turns the answer into a result: a 401 (the session ended on
/// the server), a 403 `MFA_REQUIRED` (the second factor is wanted) and a 422 `LICENSE_EXPIRED` (read only from now on).
/// Every other answer passes through untouched; the answer itself is never changed.
final class SessionObservingTransport implements HttpTransport {
  const SessionObservingTransport(this._inner, this._report);

  final HttpTransport _inner;
  final void Function(int status, String? code) _report;

  @override
  Future<HttpResult> send(HttpCall call) async {
    final HttpResult result = await _inner.send(call);
    if (result.status == 401 || result.status == 403 || result.status == 422) _report(result.status, _codeOf(result));
    return result;
  }

  static String? _codeOf(HttpResult result) {
    if (!(result.headers['content-type'] ?? '').contains('json')) return null;
    try {
      final Object? decoded = jsonDecode(result.body);
      final Object? code = decoded is Map<String, Object?> ? decoded['code'] : null;
      return code is String ? code : null;
    } on FormatException {
      return null;
    }
  }
}
