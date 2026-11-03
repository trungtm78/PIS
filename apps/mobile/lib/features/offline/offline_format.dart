import '../../core/offline/drafts/decimal.dart';

/// A size for a person: bytes below 1 KB, then one decimal of KB or MB.
String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

String _two(int value) => value.toString().padLeft(2, '0');

/// A moment in the time zone of the phone, for display only: Vietnamese writes `14:05 03/11/2026`, English `2026-11-03 14:05`.
/// The clock of the phone is never used to judge a licence or a deadline; this is only how a time the server gave is shown.
String formatMoment(DateTime moment, String language) {
  final DateTime local = moment.toLocal();
  final String time = '${_two(local.hour)}:${_two(local.minute)}';
  final String date = language == 'en' ? '${local.year}-${_two(local.month)}-${_two(local.day)}' : '${_two(local.day)}/${_two(local.month)}/${local.year}';
  return language == 'en' ? '$date $time' : '$time $date';
}

/// An exact amount in dong with the thousands grouped the way the language writes them; text that is not an amount is
/// returned as it is.
String formatMoney(Object? value, String language, {bool signed = false}) {
  final Decimal? amount = Decimal.tryParse(value);
  if (amount == null) return value?.toString() ?? '';
  final String text = language == 'en' ? amount.format(separator: ',', decimalMark: '.') : amount.format(separator: '.', decimalMark: ',');
  return signed && !amount.isNegative && !amount.isZero ? '+$text' : text;
}
