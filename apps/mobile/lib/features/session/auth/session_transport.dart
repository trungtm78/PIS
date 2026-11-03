import 'dart:convert';

import 'package:machvon_api_client/machvon_api_client.dart';

/// Tells the session what the API answered, before the client turns the answer into a result: a 401 (the session ended on
/// the server), a 403 `MFA_REQUIRED` (the second factor is wanted) and a 422 `LICENSE_EXPIRED` (read only from now on).
/// Every other answer passes through untouched; the answer itself is never changed.
///
/// A verdict is reported with the stamp the session had when the request was sent ([_stamp]), so the session can tell an answer to
/// a request of the tenant or token it has since left from one about the session that is active now.
final class SessionObservingTransport implements HttpTransport {
  const SessionObservingTransport(this._inner, this._report, this._stamp);

  final HttpTransport _inner;
  final void Function(int status, String? code, int sentUnder) _report;
  final int Function() _stamp;

  @override
  Future<HttpResult> send(HttpCall call) async {
    final int sentUnder = _stamp();
    final HttpResult result = await _inner.send(call);
    if (result.status == 401 || result.status == 403 || result.status == 422) _report(result.status, _codeOf(result), sentUnder);
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
