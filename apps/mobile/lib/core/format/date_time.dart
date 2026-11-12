/// Dates and times as the people of the tenant read them: ONE formatter for a day and a moment.
///
/// The calendar of the reports counts days and deadlines in Vietnam time (UTC+7, no daylight saving) and so does every moment shown
/// here, whatever the time zone of the phone: a deadline reads the same on every device. The clock of the phone is never used to judge a
/// licence or a deadline; this is only how a day or a time that the server named is shown.
library;

const Duration vietnamOffset = Duration(hours: 7);

final RegExp _dayShape = RegExp(r'^\d{4}-\d{2}-\d{2}$');

String _two(int value) => value.toString().padLeft(2, '0');

/// An instant in Vietnam time (the result is a plain date and time, its zone flag is only a marker of the shifted clock).
DateTime _inVietnam(DateTime instant) => instant.toUtc().add(vietnamOffset);

String _dayText(DateTime vietnam, String language) =>
    language == 'en' ? '${vietnam.year.toString().padLeft(4, '0')}-${_two(vietnam.month)}-${_two(vietnam.day)}' : '${_two(vietnam.day)}/${_two(vietnam.month)}/${vietnam.year.toString().padLeft(4, '0')}';

/// `dd/MM/yyyy` (English `yyyy-MM-dd`) for a day `YYYY-MM-DD` or for the Vietnam day of an ISO instant; anything else as it came.
String formatDay(String value, {String language = 'vi'}) {
  if (_dayShape.hasMatch(value)) {
    return language == 'en' ? value : '${value.substring(8, 10)}/${value.substring(5, 7)}/${value.substring(0, 4)}';
  }
  final DateTime? parsed = DateTime.tryParse(value);
  return parsed == null ? value : _dayText(_inVietnam(parsed), language);
}

/// `dd/MM` for a day or an instant, the short day of a row; anything else as it came.
String formatDayShort(String value) {
  final String? iso = _dayShape.hasMatch(value) ? value : null;
  if (iso != null) return '${iso.substring(8, 10)}/${iso.substring(5, 7)}';
  final DateTime? parsed = DateTime.tryParse(value);
  if (parsed == null) return value;
  final DateTime vietnam = _inVietnam(parsed);
  return '${_two(vietnam.day)}/${_two(vietnam.month)}';
}

/// `HH:mm` in 24 hours for an ISO instant in Vietnam time; anything else as it came.
String formatTime(String iso) {
  final DateTime? parsed = DateTime.tryParse(iso);
  if (parsed == null) return iso;
  final DateTime vietnam = _inVietnam(parsed);
  return '${_two(vietnam.hour)}:${_two(vietnam.minute)}';
}

/// A moment: `dd/MM/yyyy HH:mm` (English `yyyy-MM-dd HH:mm`) in Vietnam time. Text that is not an instant is returned as it came.
String formatMoment(String iso, {String language = 'vi'}) {
  final DateTime? parsed = DateTime.tryParse(iso);
  if (parsed == null) return iso;
  return formatInstant(parsed, language: language);
}

/// The same moment for an instant already parsed.
String formatInstant(DateTime instant, {String language = 'vi'}) {
  final DateTime vietnam = _inVietnam(instant);
  return '${_dayText(vietnam, language)} ${_two(vietnam.hour)}:${_two(vietnam.minute)}';
}

/// The Vietnam calendar day (`YYYY-MM-DD`) of an instant.
String vietnamDayOf(DateTime instant) {
  final DateTime vietnam = _inVietnam(instant);
  return '${vietnam.year.toString().padLeft(4, '0')}-${_two(vietnam.month)}-${_two(vietnam.day)}';
}

/// The moment an answer describes: a day (`2026-10-31`) as a date, an instant in Vietnam time.
String asOfLabel(String asOf, {String language = 'vi'}) => _dayShape.hasMatch(asOf) ? formatDay(asOf, language: language) : formatMoment(asOf, language: language);
