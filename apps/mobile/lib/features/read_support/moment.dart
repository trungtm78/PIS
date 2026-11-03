/// Dates and times as the people of the tenant read them. The calendar of the reports counts days and deadlines in
/// Vietnam time (UTC+7, no daylight saving); the clock of the phone is never used to judge a deadline, it is only used to
/// show one the server named.
const Duration vietnamOffset = Duration(hours: 7);

String _two(int value) => value.toString().padLeft(2, '0');

/// `dd/MM/yyyy HH:mm` in Vietnam time for an ISO instant; text that is not an instant is returned as it came.
String formatMoment(String iso) {
  final DateTime? parsed = DateTime.tryParse(iso);
  if (parsed == null) return iso;
  final DateTime local = parsed.toUtc().add(vietnamOffset);
  return '${_two(local.day)}/${_two(local.month)}/${local.year} ${_two(local.hour)}:${_two(local.minute)}';
}

/// `dd/MM/yyyy` for a day `YYYY-MM-DD` or the day of an ISO instant in Vietnam time; anything else as it came.
String formatDay(String value) {
  if (RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(value)) {
    return '${value.substring(8, 10)}/${value.substring(5, 7)}/${value.substring(0, 4)}';
  }
  final DateTime? parsed = DateTime.tryParse(value);
  if (parsed == null) return value;
  final DateTime local = parsed.toUtc().add(vietnamOffset);
  return '${_two(local.day)}/${_two(local.month)}/${local.year}';
}

/// The Vietnam calendar day (`YYYY-MM-DD`) of an instant.
String vietnamDayOf(DateTime instant) {
  final DateTime local = instant.toUtc().add(vietnamOffset);
  return '${local.year.toString().padLeft(4, '0')}-${_two(local.month)}-${_two(local.day)}';
}
