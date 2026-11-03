/// Readers for the JSON of the API. The contract of many reads leaves the body open (`type: object`), so each screen reads
/// the members it needs the way the web does: an answer that lacks what makes a figure citable is refused as a whole by
/// returning null, and the screen shows it as a contract mismatch instead of half a page.
typedef Json = Map<String, Object?>;

Json? asRecord(Object? value) {
  if (value is Map<String, Object?>) return value;
  if (value is Map) return value.map((Object? key, Object? item) => MapEntry<String, Object?>(key.toString(), item));
  return null;
}

List<Object?> listOf(Object? value) => value is List<Object?> ? value : (value is List ? List<Object?>.of(value) : const <Object?>[]);

String? text(Object? value) => value is String ? value : null;

/// A non-empty string, or null.
String? filled(Object? value) => value is String && value.isNotEmpty ? value : null;

int? whole(Object? value) {
  if (value is int) return value;
  if (value is double && value == value.truncateToDouble()) return value.toInt();
  return null;
}

/// A count: a whole number that is not negative, else zero.
int count(Object? value) {
  final int? parsed = whole(value);
  return parsed != null && parsed >= 0 ? parsed : 0;
}

final RegExp _dong = RegExp(r'^-?[0-9]{1,24}$');
final RegExp _unsignedDong = RegExp(r'^[0-9]{1,24}$');

/// An exact amount of whole dong written as a string (money is never a JSON number), or null.
String? dong(Object? value) => value is String && _dong.hasMatch(value) ? value : null;

String? unsignedDong(Object? value) => value is String && _unsignedDong.hasMatch(value) ? value : null;

final RegExp _day = RegExp(r'^\d{4}-\d{2}-\d{2}$');

/// A calendar day `YYYY-MM-DD`, or null.
String? day(Object? value) => value is String && _day.hasMatch(value) ? value : null;
