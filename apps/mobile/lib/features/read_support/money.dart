import 'wire.dart';

/// Exact money. An amount is a string of whole dong; it is added and divided on integers, never as a float, so no dong
/// is lost and the sum of the parts is the amount (BR-DIS-01).
BigInt? _parse(String value) => dong(value) == null ? null : BigInt.parse(value);

/// The exact sum of amounts; an amount that is not whole dong is left out of the sum, never guessed.
String sumDong(Iterable<String> amounts) {
  BigInt total = BigInt.zero;
  for (final String amount in amounts) {
    final BigInt? parsed = _parse(amount);
    if (parsed != null) total += parsed;
  }
  return total.toString();
}

/// `later - earlier` in whole dong, so a fall is negative and never shown as zero.
String differenceDong(String later, String earlier) => ((_parse(later) ?? BigInt.zero) - (_parse(earlier) ?? BigInt.zero)).toString();

/// The separators of a language: Vietnamese groups with a dot and has a decimal comma, English the other way round.
String _groupMark(String language) => language == 'en' ? ',' : '.';
String _decimalMark(String language) => language == 'en' ? '.' : ',';

String _grouped(BigInt value, String language) {
  final String digits = value.abs().toString();
  final StringBuffer out = StringBuffer(value.isNegative ? '-' : '');
  for (int index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 == 0) out.write(_groupMark(language));
    out.write(digits[index]);
  }
  return out.toString();
}

/// Whole dong with the thousands grouped (`420.000.000`); text that is not an amount is returned as it came.
String formatDong(String value, String language) {
  final BigInt? parsed = _parse(value);
  return parsed == null ? value : _grouped(parsed, language);
}

final BigInt _million = BigInt.from(1000000);

/// An amount in millions of dong, exactly: the division is on integers and six decimals hold every dong, so `420000000`
/// is `420` and `420500000` is `420,5`. Text that is not an amount is returned as it came.
String formatMillions(String value, String language) {
  final BigInt? parsed = _parse(value);
  if (parsed == null) return value;
  final BigInt whole = parsed.abs() ~/ _million;
  final String fraction = (parsed.abs() % _million).toString().padLeft(6, '0').replaceFirst(RegExp(r'0+$'), '');
  final String sign = parsed.isNegative ? '-' : '';
  final String head = _grouped(whole, language);
  return fraction.isEmpty ? '$sign$head' : '$sign$head${_decimalMark(language)}$fraction';
}

/// `+120` for a rise, `-30` for a fall, `0` for no change; the amount is in millions.
String formatSignedMillions(String value, String language) {
  final BigInt? parsed = _parse(value);
  if (parsed == null) return value;
  final String body = formatMillions(value, language);
  return parsed > BigInt.zero ? '+$body' : body;
}

/// A percent given by the server (`14.0000`) in the decimal mark of the language, kept to the digits it came with.
String formatPercent(String value, String language) {
  if (!RegExp(r'^-?[0-9]+(\.[0-9]+)?$').hasMatch(value)) return value;
  return language == 'en' ? value : value.replaceFirst('.', ',');
}
