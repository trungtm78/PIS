/// Exact money for the phone: ONE place that turns whole dong (a string, never a double) into what a person reads.
///
/// An amount is a string of whole dong; it is divided on integers, so no dong is lost (BR-DIS-01). The unit is chosen by the
/// size of the amount (dong, nghin, trieu, ty), never fixed: a fixed "million" showed 38 billion as "38.000 trieu" and one thousand
/// dong as "0,001 trieu" (finding F-02). The words of the units are strings of the language, added by `labels.dart`.
library;

/// The unit an amount is written in.
enum MoneyUnit {
  /// Below one thousand dong, and any amount asked for in full.
  dong,

  /// From one thousand dong (nghin dong).
  thousand,

  /// From one million dong (trieu dong).
  million,

  /// From one billion dong (ty dong).
  billion,
}

/// An amount written for a person: the number with the marks of the language and the unit it is in.
final class MoneyParts {
  const MoneyParts(this.number, this.unit);

  /// `1.058,3` in Vietnamese, `1,058.3` in English; a fall carries a minus sign.
  final String number;
  final MoneyUnit unit;

  @override
  bool operator ==(Object other) => other is MoneyParts && other.number == number && other.unit == unit;

  @override
  int get hashCode => Object.hash(number, unit);

  @override
  String toString() => 'MoneyParts($number, ${unit.name})';
}

final RegExp _wholeDong = RegExp(r'^-?[0-9]{1,24}$');

/// The amount as an integer, or null when [value] is not whole dong written as text.
BigInt? parseDong(Object? value) => value is String && _wholeDong.hasMatch(value) ? BigInt.parse(value) : null;

/// The grouping and the decimal marks of a language: Vietnamese groups with a dot and has a decimal comma, English the other way round.
String groupMark(String language) => language == 'en' ? ',' : '.';
String decimalMark(String language) => language == 'en' ? '.' : ',';

/// [value] (not negative) with its thousands grouped by the mark of [language].
String groupDigits(BigInt value, String language) {
  final String digits = value.abs().toString();
  final StringBuffer out = StringBuffer();
  for (int index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 == 0) out.write(groupMark(language));
    out.write(digits[index]);
  }
  return out.toString();
}

final Map<MoneyUnit, BigInt> _size = <MoneyUnit, BigInt>{
  MoneyUnit.dong: BigInt.one,
  MoneyUnit.thousand: BigInt.from(1000),
  MoneyUnit.million: BigInt.from(1000000),
  MoneyUnit.billion: BigInt.from(1000000000),
};

/// The number of dong in one [unit].
BigInt dongPerUnit(MoneyUnit unit) => _size[unit]!;

/// The unit that fits [amount] best: the largest one in which the amount is at least 1 (dong below 1.000, then nghin, trieu, ty).
MoneyUnit moneyUnitFor(BigInt amount) {
  final BigInt magnitude = amount.abs();
  if (magnitude >= _size[MoneyUnit.billion]!) return MoneyUnit.billion;
  if (magnitude >= _size[MoneyUnit.million]!) return MoneyUnit.million;
  if (magnitude >= _size[MoneyUnit.thousand]!) return MoneyUnit.thousand;
  return MoneyUnit.dong;
}

BigInt _pow10(int digits) => BigInt.from(10).pow(digits);

/// [amount] divided by one [unit], rounded half away from zero to [decimals] places, as a scaled integer (`1.058,3` is 10583 at one decimal).
BigInt _scaled(BigInt amount, MoneyUnit unit, int decimals) {
  final BigInt unitSize = _size[unit]!;
  final BigInt numerator = amount.abs() * _pow10(decimals);
  return (numerator * BigInt.two + unitSize) ~/ (unitSize * BigInt.two);
}

String _number(BigInt scaled, int decimals, bool negative, String language) {
  final BigInt divisor = _pow10(decimals);
  final String whole = groupDigits(scaled ~/ divisor, language);
  final String fraction = decimals == 0 ? '' : (scaled % divisor).toString().padLeft(decimals, '0').replaceFirst(RegExp(r'0+$'), '');
  final String sign = negative && scaled != BigInt.zero ? '-' : '';
  return fraction.isEmpty ? '$sign$whole' : '$sign$whole${decimalMark(language)}$fraction';
}

/// An amount of whole dong written in the unit that fits it; null when [value] is not whole dong.
///
/// The unit is the largest in which the amount is at least 1: `38000000000` is `38 ty`, `420500000` is `420,5 trieu`, `1000` is `1 nghin` and
/// `999` is `999 dong`. Two modes:
///
///  * Exact ([decimals] null, the default): the figure is never rounded, so an approver or a payer sees every digit. The unit is kept only
///    while it shows the amount in at most three decimals (`1.049.000.000` is `1,049 ty`); an amount that needs more (`1.049.123.456`) is
///    written in whole dong, grouped, and so is an amount in nghin that is not a whole number of nghin (`1.500`).
///  * Short ([decimals] given, 1 for a row or a tile): rounded half away from zero to that many places, trailing zeros dropped. Rounding that
///    reaches 1.000 of a unit moves up to the next (`999.960.000` is `1 ty`, never `1.000 trieu`). It is for reading at a glance; the exact
///    figure is shown in the detail (`moneyFullLabel`).
///
/// Pass [unit] to force one (a column that is declared in one unit); the amount is then not moved up and is rounded to [decimals]
/// (6 when null, which holds every dong of a million). Below one thousand dong the amount is exact, with no decimals.
MoneyParts? moneyParts(String value, String language, {int? decimals, MoneyUnit? unit}) {
  final BigInt? amount = parseDong(value);
  if (amount == null) return null;
  final bool negative = amount.isNegative;
  if (decimals == null) {
    if (unit == null) return _exactParts(amount, negative, language);
    final int places = unit == MoneyUnit.dong ? 0 : 6;
    return MoneyParts(_number(_scaled(amount, unit, places), places, negative, language), unit);
  }
  MoneyUnit chosen = unit ?? moneyUnitFor(amount);
  int places = chosen == MoneyUnit.dong ? 0 : decimals;
  BigInt scaled = _scaled(amount, chosen, places);
  if (unit == null && chosen != MoneyUnit.billion && scaled >= BigInt.from(1000) * _pow10(places)) {
    chosen = MoneyUnit.values[chosen.index + 1];
    places = decimals;
    scaled = _scaled(amount, chosen, places);
  }
  return MoneyParts(_number(scaled, places, negative, language), chosen);
}

/// The exact mode of [moneyParts]: the unit of the size of the amount while three decimals show it whole, else whole dong.
MoneyParts _exactParts(BigInt amount, bool negative, String language) {
  final MoneyUnit unit = moneyUnitFor(amount);
  final BigInt step = dongPerUnit(unit) ~/ BigInt.from(1000);
  // Three decimals of a unit are exact exactly when the amount is a whole number of a thousandth of it; a nghin with a fraction is dong.
  final bool exact = unit != MoneyUnit.dong && amount.abs() % step == BigInt.zero && (unit != MoneyUnit.thousand || amount.abs() % dongPerUnit(unit) == BigInt.zero);
  if (!exact) return MoneyParts('${negative ? '-' : ''}${groupDigits(amount, language)}', MoneyUnit.dong);
  return MoneyParts(_number(_scaled(amount, unit, 3), 3, negative, language), unit);
}

/// Whole dong with the thousands grouped (`420.000.000`); text that is not an amount is returned as it came.
String formatDong(String value, String language) {
  final BigInt? parsed = parseDong(value);
  return parsed == null ? value : '${parsed.isNegative ? '-' : ''}${groupDigits(parsed, language)}';
}

/// The exact sum of amounts; an amount that is not whole dong is left out of the sum, never guessed.
String sumDong(Iterable<String> amounts) {
  BigInt total = BigInt.zero;
  for (final String amount in amounts) {
    final BigInt? parsed = parseDong(amount);
    if (parsed != null) total += parsed;
  }
  return total.toString();
}

/// `later - earlier` in whole dong, so a fall is negative and never shown as zero.
String differenceDong(String later, String earlier) => ((parseDong(later) ?? BigInt.zero) - (parseDong(earlier) ?? BigInt.zero)).toString();
