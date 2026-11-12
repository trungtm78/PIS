import 'dart:convert';

/// The code of a request that never got an answer (offline, refused, timed out).
const String networkErrorCode = 'NETWORK_ERROR';

const String _internalErrorCode = 'INTERNAL_ERROR';
const String _validationFailedCode = 'VALIDATION_FAILED';
const Set<String> _standardMembers = <String>{'type', 'title', 'status', 'code', 'detail', 'correlation_id'};
const Map<int, String> _codeByStatus = <int, String>{
  401: 'SESSION_EXPIRED',
  403: 'SCOPE_DENIED',
  404: 'RESOURCE_NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMIT',
};

/// A failed call. It carries the stable error code and the safe members of the problem answer; its text is the code,
/// never text from the server body, so nothing a gateway or an exception put in a response can reach the screen.
final class ApiError implements Exception {
  const ApiError({
    required this.status,
    required this.code,
    required this.correlationId,
    this.detail,
    this.extensions = const <String, Object?>{},
    this.retryAfterSeconds,
  });

  /// HTTP status, 0 when no answer arrived.
  final int status;
  final String code;
  final String? detail;
  final String correlationId;

  /// Members of the problem body beyond the standard ones (for example `current_version`).
  final Map<String, Object?> extensions;
  final int? retryAfterSeconds;

  /// The error of a request that never got an answer.
  factory ApiError.network(String correlationId) => ApiError(status: 0, code: networkErrorCode, correlationId: correlationId);

  /// The error of a success status whose body cannot be used (a gateway page, a truncated answer).
  factory ApiError.unusableAnswer(int status, String correlationId) =>
      ApiError(status: status, code: _internalErrorCode, correlationId: correlationId);

  /// Builds the error of a non-success answer; [fallbackCorrelationId] is the id the client sent.
  factory ApiError.fromResponse({
    required int status,
    required Map<String, String> headers,
    required String body,
    required String fallbackCorrelationId,
  }) {
    final int? retryAfter = _retryAfterOf(headers);
    final String correlation = headers['x-correlation-id'] ?? fallbackCorrelationId;
    final Map<String, Object?>? problem = _problemOf(headers, body);
    if (problem == null) {
      return ApiError(status: status, code: _codeFor(status), correlationId: correlation, retryAfterSeconds: retryAfter);
    }
    final Object? detail = problem['detail'];
    final Object? bodyCorrelation = problem['correlation_id'];
    return ApiError(
      status: status,
      code: problem['code']! as String,
      detail: detail is String ? detail : null,
      correlationId: bodyCorrelation is String ? bodyCorrelation : correlation,
      extensions: <String, Object?>{
        for (final MapEntry<String, Object?> entry in problem.entries)
          if (!_standardMembers.contains(entry.key)) entry.key: entry.value,
      },
      retryAfterSeconds: retryAfter,
    );
  }

  @override
  String toString() => 'ApiError($code)';
}

String _codeFor(int status) {
  if (status >= 500) return _internalErrorCode;
  return _codeByStatus[status] ?? _validationFailedCode;
}

int? _retryAfterOf(Map<String, String> headers) {
  final String? value = headers['retry-after'];
  if (value == null) return null;
  final int? seconds = int.tryParse(value.trim());
  return seconds != null && seconds >= 0 ? seconds : null;
}

Map<String, Object?>? _problemOf(Map<String, String> headers, String body) {
  if (!(headers['content-type'] ?? '').contains('json')) return null;
  try {
    final Object? decoded = jsonDecode(body);
    if (decoded is Map<String, Object?> && decoded['code'] is String) return decoded;
  } on FormatException {
    return null;
  }
  return null;
}
