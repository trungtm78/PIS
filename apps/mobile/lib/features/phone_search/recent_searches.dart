import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/offline/offline_providers.dart';
import '../../core/offline/store/local_store.dart';
import 'search_models.dart';

/// The key of the recent keywords in the `meta` table of the encrypted store of the person.
const String kRecentSearchesMeta = 'recent_searches.v1';

/// How many keywords are remembered.
const int recentSearchesMax = 10;

/// The keywords the person searched for lately, newest first, kept in the encrypted store of that person in that tenant. They go with
/// the store when the person signs out or switches tenant, and are cleared on request. Only the keywords are kept: never a hit, never a
/// name, never an id.
class RecentSearches {
  RecentSearches(this._store);

  final LocalStore _store;

  List<String> read() {
    final String? stored = _store.meta(kRecentSearchesMeta);
    if (stored == null) return const <String>[];
    final Object? decoded = jsonDecode(stored);
    if (decoded is! List) return const <String>[];
    return <String>[for (final Object? item in decoded) if (item is String && keywordProblem(item) == null) item];
  }

  /// Puts [keyword] first; the same keyword (whatever its case) is not listed twice, and the oldest go past [recentSearchesMax].
  List<String> remember(String keyword) {
    final String clean = keyword.trim();
    if (keywordProblem(clean) != null) return read();
    final List<String> next = <String>[clean, ...read().where((String item) => item.toLowerCase() != clean.toLowerCase())].take(recentSearchesMax).toList();
    _store.setMeta(kRecentSearchesMeta, jsonEncode(next));
    return next;
  }

  void clear() => _store.setMeta(kRecentSearchesMeta, jsonEncode(const <String>[]));
}

/// The recent keywords of the person signed in. It is empty while the store opens and when there is no store (nobody is signed in):
/// a search does not wait for its history.
class RecentSearchesNotifier extends Notifier<List<String>> {
  RecentSearches? _recent;

  @override
  List<String> build() {
    final AsyncValue<LocalStore> store = ref.watch(localStoreProvider);
    _recent = store.hasValue ? RecentSearches(store.requireValue) : null;
    return _recent?.read() ?? const <String>[];
  }

  void remember(String keyword) {
    final RecentSearches? recent = _recent;
    if (recent != null) state = recent.remember(keyword);
  }

  void clear() {
    _recent?.clear();
    state = const <String>[];
  }
}

final NotifierProvider<RecentSearchesNotifier, List<String>> recentSearchesProvider = NotifierProvider<RecentSearchesNotifier, List<String>>(RecentSearchesNotifier.new);
