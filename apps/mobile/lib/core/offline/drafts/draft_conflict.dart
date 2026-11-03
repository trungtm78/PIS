import 'dart:convert';

import 'decimal.dart';

/// What the person keeps for one field that differs between the device and the server.
enum FieldChoice { mine, server }

/// Which fields are money. The contract writes every amount as exact decimal text under a name that ends in `_vnd`.
typedef MoneyPolicy = bool Function(String fieldName);

bool defaultIsMoney(String fieldName) => fieldName.endsWith('_vnd');

/// One place where the draft of the device and the server copy differ.
final class FieldDifference {
  const FieldDifference({required this.path, required this.mine, required this.server, required this.isMoney});

  /// Where the field is: `construction_vnd`, `narrative.results`, `funding_lines[CURRENT_YEAR|CENTRAL|].cumulative_vnd`. A
  /// whole item of a list that is on one side only is `funding_lines[CARRYOVER|LOCAL|]`.
  final String path;

  /// The value on the device and on the server; null when that side does not have the field.
  final Object? mine;
  final Object? server;

  /// Money is never merged by a rule: the person decides every such field, and the screen shows both amounts and the
  /// difference.
  final bool isMoney;

  /// The amount on the device minus the amount on the server, for a money field whose two sides are amounts; null otherwise.
  Decimal? get moneyDelta {
    final Decimal? a = Decimal.tryParse(mine);
    final Decimal? b = Decimal.tryParse(server);
    return isMoney && a != null && b != null ? a - b : null;
  }
}

/// The person did not decide every field that differs, or decided one that does not.
final class UnresolvedConflict implements Exception {
  const UnresolvedConflict(this.paths);

  final List<String> paths;

  @override
  String toString() => 'UnresolvedConflict(${paths.join(', ')})';
}

final RegExp _segment = RegExp(r'^([^\[\]]+)(?:\[(.*)\])?$');

/// The comparison of a draft made on the device with the copy the server holds (MOB-42, MOB.md 3): the fields that
/// differ, with both values, and the way to make one document out of the person's decisions.
///
/// There is no rule that decides for the person: [resolve] refuses unless **every** difference has a choice, money
/// included. Fields that are equal are not offered; lists whose items have an identity (`listIdentity`) are compared item
/// by item, so a different order is not a difference; any other list is one value.
final class DraftConflict {
  DraftConflict._(this.mine, this.server, this.differences, this._listIdentity);

  /// Compares the payload of the device with the copy of the server. [listIdentity] names, for a list field, the fields of
  /// its items that identify them. [ignore] lists paths that are not compared (the id of the operation, for example).
  /// With [onlyFieldsOfMine] a field the draft does not name is not compared: a save that leaves a field out keeps the
  /// server's value, so there is nothing to choose.
  factory DraftConflict.compare({
    required Map<String, Object?> mine,
    required Map<String, Object?> server,
    Map<String, List<String>> listIdentity = const <String, List<String>>{},
    Set<String> ignore = const <String>{},
    MoneyPolicy isMoney = defaultIsMoney,
    bool onlyFieldsOfMine = false,
  }) {
    final List<FieldDifference> found = <FieldDifference>[];
    _Walker(listIdentity, ignore, isMoney, onlyFieldsOfMine, found).map('', mine, server);
    return DraftConflict._(_copy(mine) as Map<String, Object?>, _copy(server) as Map<String, Object?>, List<FieldDifference>.unmodifiable(found), listIdentity);
  }

  final Map<String, Object?> mine;
  final Map<String, Object?> server;
  final List<FieldDifference> differences;
  final Map<String, List<String>> _listIdentity;

  bool get hasMoney => differences.any((FieldDifference d) => d.isMoney);

  /// Nothing differs: the server moved on without touching what the person wrote. The person still confirms.
  bool get isEmpty => differences.isEmpty;

  /// The document to send: the payload of the device with the server's value in each field the person gave to the
  /// server. Every difference needs a choice and a choice for a path that does not differ is an error.
  Map<String, Object?> resolve(Map<String, FieldChoice> choices) {
    final Set<String> known = differences.map((FieldDifference d) => d.path).toSet();
    final List<String> missing = <String>[for (final FieldDifference d in differences) if (!choices.containsKey(d.path)) d.path];
    final List<String> unknown = <String>[for (final String path in choices.keys) if (!known.contains(path)) path];
    if (missing.isNotEmpty || unknown.isNotEmpty) throw UnresolvedConflict(<String>[...missing, ...unknown]);
    final Map<String, Object?> merged = _copy(mine) as Map<String, Object?>;
    for (final FieldDifference difference in differences) {
      if (choices[difference.path] == FieldChoice.server) _apply(merged, difference.path, difference.server, listIdentity: _listIdentity);
    }
    return merged;
  }
}

class _Walker {
  _Walker(this.listIdentity, this.ignore, this.isMoney, this.onlyFieldsOfMine, this.found);

  final Map<String, List<String>> listIdentity;
  final Set<String> ignore;
  final MoneyPolicy isMoney;
  final bool onlyFieldsOfMine;
  final List<FieldDifference> found;

  void map(String path, Map<String, Object?> mine, Map<String, Object?> server) {
    final List<String> keys = <String>{...mine.keys, ...server.keys}.toList()..sort();
    for (final String key in keys) {
      final String child = path.isEmpty ? key : '$path.$key';
      if (ignore.contains(child) || (onlyFieldsOfMine && !mine.containsKey(key))) continue;
      value(child, key, mine[key], server[key]);
    }
  }

  void value(String path, String key, Object? mine, Object? server) {
    if (mine is Map<String, Object?> && server is Map<String, Object?> && _plainKeys(mine) && _plainKeys(server)) {
      map(path, mine, server);
      return;
    }
    final List<String>? identity = listIdentity[key];
    if (identity != null && mine is List<Object?> && server is List<Object?> && _keyed(mine, identity) && _keyed(server, identity)) {
      keyedList(path, identity, mine, server);
      return;
    }
    if (!_same(path, key, mine, server)) found.add(FieldDifference(path: path, mine: mine, server: server, isMoney: _containsMoney(key, mine) || _containsMoney(key, server)));
  }

  void keyedList(String path, List<String> identity, List<Object?> mine, List<Object?> server) {
    final Map<String, Map<String, Object?>> a = <String, Map<String, Object?>>{for (final Object? item in mine) _idOf(item! as Map<String, Object?>, identity): item as Map<String, Object?>};
    final Map<String, Map<String, Object?>> b = <String, Map<String, Object?>>{for (final Object? item in server) _idOf(item! as Map<String, Object?>, identity): item as Map<String, Object?>};
    for (final String id in <String>{...a.keys, ...b.keys}) {
      final String itemPath = '$path[$id]';
      if (ignore.contains(itemPath)) continue;
      final Map<String, Object?>? left = a[id];
      final Map<String, Object?>? right = b[id];
      if (left != null && right != null) {
        map(itemPath, left, right);
      } else if (!_same(itemPath, path, left, right)) {
        found.add(FieldDifference(path: itemPath, mine: left, server: right, isMoney: _containsMoney(path, left ?? right)));
      }
    }
  }

  bool _containsMoney(String key, Object? value) {
    if (value is Map<String, Object?>) return value.entries.any((MapEntry<String, Object?> e) => _containsMoney(e.key, e.value));
    if (value is List<Object?>) return value.any((Object? item) => _containsMoney(key, item));
    return isMoney(key);
  }

  bool _same(String path, String key, Object? a, Object? b) {
    if (isMoney(key)) {
      final Decimal? x = Decimal.tryParse(a);
      final Decimal? y = Decimal.tryParse(b);
      if (x != null && y != null) return x == y;
    }
    return jsonEncode(_canonical(a)) == jsonEncode(_canonical(b));
  }
}

bool _plainKeys(Map<String, Object?> map) => map.keys.every((String key) => !key.contains(RegExp(r'[.\[\]]')));

/// A list is compared item by item when every item is an object and no two items have the same identity.
bool _keyed(List<Object?> items, List<String> identity) {
  if (items.isEmpty || !items.every((Object? item) => item is Map<String, Object?>)) return false;
  final Set<String> ids = <String>{for (final Object? item in items) _idOf(item! as Map<String, Object?>, identity)};
  return ids.length == items.length;
}

String _idOf(Map<String, Object?> item, List<String> identity) => identity.map((String field) => item[field]?.toString() ?? '').join('|');

/// A deep copy that sorts the keys, so two documents with the same content encode to the same text.
Object? _canonical(Object? value) {
  if (value is Map<String, Object?>) {
    final List<String> keys = value.keys.toList()..sort();
    return <String, Object?>{for (final String key in keys) key: _canonical(value[key])};
  }
  if (value is List<Object?>) return <Object?>[for (final Object? item in value) _canonical(item)];
  return value;
}

Object? _copy(Object? value) => jsonDecode(jsonEncode(value));

/// Sets the value of a path in [root] to [value]; a null value removes the field (or the list item).
void _apply(Map<String, Object?> root, String path, Object? value, {required Map<String, List<String>> listIdentity}) {
  final List<String> segments = path.split('.');
  Map<String, Object?> current = root;
  for (int i = 0; i < segments.length; i += 1) {
    final RegExpMatch match = _segment.firstMatch(segments[i])!;
    final String key = match.group(1)!;
    final String? id = match.group(2);
    final bool last = i == segments.length - 1;
    if (id == null) {
      if (last) {
        if (value == null) {
          current.remove(key);
        } else {
          current[key] = _copy(value);
        }
        return;
      }
      current = (current[key] ??= <String, Object?>{}) as Map<String, Object?>;
      continue;
    }
    final List<String> identity = listIdentity[key]!;
    final List<Object?> items = (current[key] ??= <Object?>[]) as List<Object?>;
    final int at = items.indexWhere((Object? item) => _idOf(item! as Map<String, Object?>, identity) == id);
    if (last) {
      if (value == null) {
        if (at >= 0) items.removeAt(at);
      } else if (at >= 0) {
        items[at] = _copy(value);
      } else {
        items.add(_copy(value));
      }
      return;
    }
    current = items[at] as Map<String, Object?>;
  }
}
