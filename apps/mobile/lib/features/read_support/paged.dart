import 'package:machvon_api_client/machvon_api_client.dart';

import 'wire.dart';

/// The most pages one screen follows: a phone does not read a register of thousands, it says that there is more.
const int defaultMaxPages = 20;

/// Reads a list operation page by page and returns one answer: the members of the first page (`counts`, `totals`, `plan`,
/// ...) with the `items` of every page, in order. `next_cursor` is null when the list was read to its end, and the cursor of
/// the next page when [maxPages] was reached first. A cursor that repeats stops the read (it would ask for the same page for
/// ever).
Future<Json> readMerged(
  MachvonApiClient client,
  String operationId, {
  Map<String, Object?>? path,
  Map<String, Object?>? query,
  int maxPages = defaultMaxPages,
}) async {
  Json? first;
  final List<Object?> items = <Object?>[];
  final Set<String> seen = <String>{};
  String? cursor;
  for (int page = 0; page < maxPages; page += 1) {
    final Object? answer = await client.execute(
      operationId,
      path: path,
      query: <String, Object?>{...?query, if (cursor != null) 'cursor': cursor},
    );
    final Json? body = asRecord(answer);
    if (body == null) throw ApiError.unusableAnswer(200, 'paged-answer');
    first ??= <String, Object?>{...body};
    items.addAll(listOf(body['items']));
    final String? next = filled(body['next_cursor']);
    if (next == null || !seen.add(next)) {
      return <String, Object?>{...first, 'items': items, 'next_cursor': null};
    }
    cursor = next;
  }
  return <String, Object?>{...?first, 'items': items, 'next_cursor': cursor};
}
