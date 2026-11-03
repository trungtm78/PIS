import '../read_support/wire.dart';

/// The longest and shortest keyword the server takes (`searchGlobal`: `q` 2 to 200 characters).
const int queryMin = 2;
const int queryMax = 200;

enum KeywordProblem { tooShort, tooLong }

/// What is wrong with a keyword before it is sent, or null. Characters are counted, not code units, so a Vietnamese letter or an emoji
/// counts once, as the server counts them.
KeywordProblem? keywordProblem(String query) {
  final int length = query.trim().runes.length;
  if (length < queryMin) return KeywordProblem.tooShort;
  return length > queryMax ? KeywordProblem.tooLong : null;
}

/// How much of a record the server lets a hit show. A hit above `INTERNAL` carries no extract, and a personal record carries no name.
enum Classification { public, internal, confidential, personal }

const Map<String, Classification> _classificationByWire = <String, Classification>{
  'PUBLIC': Classification.public,
  'INTERNAL': Classification.internal,
  'CONFIDENTIAL': Classification.confidential,
  'PERSONAL': Classification.personal,
};

/// One hit: what kind of record it is, its id, and what its classification lets the list show. Opening the record asks the server
/// again, under the permission of that moment.
final class SearchHit {
  const SearchHit({required this.entityType, required this.entityId, required this.classification, this.title, this.snippet});

  final String entityType;
  final String entityId;

  /// Null for a personal record: the name of a person is not shown by a search; opening the record decides.
  final String? title;
  final Classification classification;
  final String? snippet;
}

SearchHit? parseSearchHit(Object? raw) {
  final Json? row = asRecord(raw);
  final String? type = filled(row?['entity_type']);
  final String? id = filled(row?['entity_id']);
  final Classification? classification = _classificationByWire[text(row?['classification'])];
  if (row == null || type == null || id == null || classification == null) return null;
  return SearchHit(entityType: type, entityId: id, classification: classification, title: text(row['title']), snippet: text(row['snippet']));
}

/// The hits the server gave, in its order. There is no total anywhere: a number would show how much exists outside the scope of the
/// reader. [more] only says the phone stopped reading pages.
final class SearchResults {
  const SearchResults({required this.hits, required this.more});

  final List<SearchHit> hits;
  final bool more;

  /// The kinds of record among the hits, in the order they first appear.
  List<String> get types => <String>{for (final SearchHit hit in hits) hit.entityType}.toList();

  /// The hits of one kind; no kind keeps them all.
  List<SearchHit> ofType(String? type) => type == null ? hits : <SearchHit>[for (final SearchHit hit in hits) if (hit.entityType == type) hit];
}

SearchResults? parseSearchResults(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null || row['items'] is! List) return null;
  return SearchResults(hits: <SearchHit>[for (final Object? item in listOf(row['items'])) ?parseSearchHit(item)], more: filled(row['next_cursor']) != null);
}

/// Where a hit opens on the phone: the screen and the path parameter. Only the kinds of record the phone has a screen for open; the
/// screen asks the server again, so a record outside the scope of the reader is not found there. Null for any other kind.
({String screenId, String pathSuffix})? openTargetOf(SearchHit hit) {
  final String id = Uri.encodeComponent(hit.entityId);
  switch (hit.entityType) {
    case 'project':
      return (screenId: 'MOB-10', pathSuffix: '/$id');
    case 'conversation':
      return (screenId: 'MOB-36', pathSuffix: '/$id');
    default:
      return null;
  }
}
