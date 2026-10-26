/// A typed response. Generated classes implement it; `toJson` gives back the wire form that `fromJson` read.
abstract interface class ResponseModel {
  Map<String, Object?> toJson();
}

/// A response that does not match the contract: [path] names the member (`CommandResult.resource_version`) and [problem] says how.
final class ContractMismatch implements Exception {
  const ContractMismatch(this.path, this.problem);

  final String path;
  final String problem;

  @override
  String toString() => 'ContractMismatch: $path $problem';
}

/// Reads one value of the response at [path] (the member it came from, for the message).
typedef Decoder<T> = T Function(Object? value, String path);

String asString(Object? value, String path) => value is String ? value : throw ContractMismatch(path, 'is not a string');

bool asBool(Object? value, String path) => value is bool ? value : throw ContractMismatch(path, 'is not a boolean');

num asNum(Object? value, String path) => value is num ? value : throw ContractMismatch(path, 'is not a number');

/// An integer; JSON written as `3.0` is the same number and is read as 3.
int asInt(Object? value, String path) {
  if (value is int) return value;
  if (value is double && value == value.truncateToDouble()) return value.toInt();
  throw ContractMismatch(path, 'is not an integer');
}

/// A member whose shape the contract leaves open (a choice between shapes, or any JSON).
Object? asAny(Object? value, String path) => value;

Map<String, Object?> asObject(Object? value, String path) {
  if (value is Map<String, Object?>) return value;
  if (value is Map) return value.map((Object? key, Object? item) => MapEntry<String, Object?>(key.toString(), item));
  throw ContractMismatch(path, 'is not an object');
}

Decoder<List<T>> asList<T>(Decoder<T> item) => (Object? value, String path) {
      if (value is! List) throw ContractMismatch(path, 'is not a list');
      return <T>[for (int index = 0; index < value.length; index += 1) item(value[index], '$path[$index]')];
    };

Decoder<Map<String, T>> asMap<T>(Decoder<T> item) => (Object? value, String path) {
      final Map<String, Object?> map = asObject(value, path);
      return <String, T>{for (final MapEntry<String, Object?> entry in map.entries) entry.key: item(entry.value, '$path.${entry.key}')};
    };

Decoder<T?> nullable<T>(Decoder<T> inner) => (Object? value, String path) => value == null ? null : inner(value, path);

/// A member the contract requires: absent is a mismatch that names the member (a renamed field shows up here).
T requiredField<T>(Map<String, Object?> map, String path, String key, Decoder<T> decode) {
  if (!map.containsKey(key)) throw ContractMismatch('$path.$key', 'is missing');
  return decode(map[key], '$path.$key');
}

/// A member the contract allows to be absent; an explicit null reads as absent.
T? optionalField<T>(Map<String, Object?> map, String path, String key, Decoder<T?> decode) {
  final Object? value = map[key];
  return value == null ? null : decode(value, '$path.$key');
}

/// The members the contract does not name. A contract that closes the object (`additionalProperties: false`) refuses them, naming the first;
/// otherwise they are kept, so that writing the response back gives what was read.
Map<String, Object?> unknownFields(Map<String, Object?> map, String path, Set<String> known, {required bool strict}) {
  final Map<String, Object?> extra = <String, Object?>{for (final MapEntry<String, Object?> entry in map.entries) if (!known.contains(entry.key)) entry.key: entry.value};
  if (strict && extra.isNotEmpty) throw ContractMismatch('$path.${extra.keys.first}', 'is not in the contract');
  return extra;
}
