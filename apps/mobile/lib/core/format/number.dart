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

/// A percent as a person reads it, the figure without its sign (the sentence or the caller writes "%"): the decimal mark of [language], two
/// decimals at most, trailing zeros dropped (`96,54`, `45`, `197,5`), the thousands grouped. The figure is the decimal text of the server
/// (`14.0000`); it is rounded half away from zero on its digits, never through a double. Text that is not a number is returned as it came.
/// The same rule as the web (`formatPercent` in apps/web/src/i18n/format.ts).
String formatPercent(String value, String language, {int maxDecimals = 2}) {
  final RegExpMatch? match = RegExp(r'^(-?)([0-9]+)(?:\.([0-9]+))?$').firstMatch(value.trim());
  if (match == null) return value;
  final String fraction = match.group(3) ?? '';
  final String kept = fraction.padRight(maxDecimals, '0').substring(0, maxDecimals);
  final bool up = fraction.length > maxDecimals && fraction.codeUnitAt(maxDecimals) >= 0x35;
  final BigInt divisor = BigInt.from(10).pow(maxDecimals);
  final BigInt scaled = BigInt.parse('${match.group(2)}$kept') + (up ? BigInt.one : BigInt.zero);
  final String whole = groupDigits(scaled ~/ divisor, language);
  final String decimals = maxDecimals == 0 ? '' : (scaled % divisor).toString().padLeft(maxDecimals, '0').replaceFirst(RegExp(r'0+$'), '');
  final String sign = match.group(1) == '-' && scaled != BigInt.zero ? '-' : '';
  return decimals.isEmpty ? '$sign$whole' : '$sign$whole${decimalMark(language)}$decimals';
}

final RegExp _percentInText = RegExp(r'(-?[0-9]+(?:\.[0-9]+)?)%');

/// A sentence the server wrote (`Ty le giai ngan 37.62%`) with every percent in it rewritten by [formatPercent] (`37,62%`); the words are
/// left as they came: only a number that is immediately followed by the sign is touched.
String percentsInText(String text, String language) => text.replaceAllMapped(_percentInText, (Match match) => '${formatPercent(match.group(1)!, language)}%');

/// A size for a person: bytes below 1 KB, then one decimal of KB or MB, with the decimal mark of [language].
String formatBytes(int bytes, {String language = 'vi'}) {
  if (bytes < 1024) return '$bytes B';
  final bool kilo = bytes < 1024 * 1024;
  final double value = kilo ? bytes / 1024 : bytes / (1024 * 1024);
  final String text = value.toStringAsFixed(1);
  return '${language == 'en' ? text : text.replaceFirst('.', ',')} ${kilo ? 'KB' : 'MB'}';
}
