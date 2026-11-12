import '../offline/drafts/decimal.dart';
import 'money.dart';

/// An exact decimal number (`1234567.5`) with the thousands grouped the way [language] writes them; text that is not a number is
/// returned as it is. [signed] puts a plus before a rise. This is the formatter of a figure that is not "an amount to read at a glance"
/// (a conflicting value, a difference), where every digit counts; an amount to read is `moneyParts`.
String formatNumber(Object? value, String language, {bool signed = false}) {
  final Decimal? amount = Decimal.tryParse(value);
  if (amount == null) return value?.toString() ?? '';
  final String text = amount.format(separator: groupMark(language), decimalMark: decimalMark(language));
  return signed && !amount.isNegative && !amount.isZero ? '+$text' : text;
}

/// A measured number (a score, a threshold) with at most [maxDecimals] decimals and no trailing zeros, in the decimal mark of [language]:
/// `12,5`, `14`. A figure the server gave as text goes through [formatNumber] or [formatPercent] and keeps its digits.
String formatMeasure(double value, String language, {int maxDecimals = 2}) {
  String text = value.toStringAsFixed(maxDecimals);
  if (text.contains('.')) {
    text = text.replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '');
  }
  return language == 'en' ? text : text.replaceAll('.', ',');
}

/// A percent given by the server (`14.0000`) in the decimal mark of the language, kept to the digits it came with.
String formatPercent(String value, String language) {
  if (!RegExp(r'^-?[0-9]+(\.[0-9]+)?$').hasMatch(value)) return value;
  return language == 'en' ? value : value.replaceFirst('.', ',');
}

/// A size for a person: bytes below 1 KB, then one decimal of KB or MB, with the decimal mark of [language].
String formatBytes(int bytes, {String language = 'vi'}) {
  if (bytes < 1024) return '$bytes B';
  final bool kilo = bytes < 1024 * 1024;
  final double value = kilo ? bytes / 1024 : bytes / (1024 * 1024);
  final String text = value.toStringAsFixed(1);
  return '${language == 'en' ? text : text.replaceFirst('.', ',')} ${kilo ? 'KB' : 'MB'}';
}
