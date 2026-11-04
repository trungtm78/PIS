import 'dart:async';

import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/wire.dart';

/// Looks for one thing in a list operation, page by page, and stops at the first page that holds it ([pick] returns it) or when the
/// collection is exhausted (`next_cursor` is null). A lookup is not a display: a phone shows a bounded part of a register and says
/// that there is more, but a citation names one record and "not in the first pages" is not "not there", so no page count ends the
/// search. The search can still not run for ever: a cursor that repeats (the server would answer the same page again) ends it, and
/// so does the person leaving the screen, which drops the read. Returns null when every page was read and none held the thing.
Future<T?> findInPages<T extends Object>(
  MachvonApiClient client,
  String operationId, {
  Map<String, Object?>? path,
  Map<String, Object?>? query,
  required FutureOr<T?> Function(Json body) pick,
}) async {
  final Set<String> seen = <String>{};
  String? cursor;
  while (true) {
    final Object? answer = await client.execute(operationId, path: path, query: <String, Object?>{...?query, if (cursor != null) 'cursor': cursor});
    final Json? body = asRecord(answer);
    if (body == null) throw ApiError.unusableAnswer(200, 'paged-answer');
    final T? found = await pick(body);
    if (found != null) return found;
    final String? next = filled(body['next_cursor']);
    if (next == null || !seen.add(next)) return null;
    cursor = next;
  }
}
