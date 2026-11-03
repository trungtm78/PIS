final RegExp _decimalShape = RegExp(r'^(-?)(\d+)(?:\.(\d+))?$');

/// An exact decimal, for the money the server sends as text (`"130000000"`, `"-12.50"`). Money is never a `double` on
/// the device: a figure shown to the person, compared with another or subtracted from it must be the exact one.
final class Decimal implements Comparable<Decimal> {
  const Decimal._(this._unscaled, this._scale);

  /// Reads the exact decimal text of the contract (`^-?[0-9]+(\.[0-9]+)?$`); null for anything else.
  static Decimal? tryParse(Object? value) {
    if (value is! String) return null;
    final RegExpMatch? match = _decimalShape.firstMatch(value);
    if (match == null) return null;
    final String fraction = match.group(3) ?? '';
    final BigInt unscaled = BigInt.parse('${match.group(2)}$fraction');
    return Decimal._(match.group(1) == '-' ? -unscaled : unscaled, fraction.length);
  }

  final BigInt _unscaled;
  final int _scale;

  BigInt _scaledTo(int scale) => _unscaled * BigInt.from(10).pow(scale - _scale);

  Decimal operator -(Decimal other) {
    final int scale = _scale > other._scale ? _scale : other._scale;
    return Decimal._(_scaledTo(scale) - other._scaledTo(scale), scale);
  }

  bool get isNegative => _unscaled.isNegative;
  bool get isZero => _unscaled == BigInt.zero;

  @override
  int compareTo(Decimal other) {
    final int scale = _scale > other._scale ? _scale : other._scale;
    return _scaledTo(scale).compareTo(other._scaledTo(scale));
  }

  @override
  bool operator ==(Object other) => other is Decimal && compareTo(other) == 0;

  @override
  int get hashCode => _normalized().hashCode;

  String _normalized() => _text(trimZeros: true);

  /// The plain text without grouping (`-12.50`).
  String toPlainString() => _text(trimZeros: false);

  /// The text with the thousands grouped by [separator] and the decimals by [decimalMark] (`1.234.567,5` in Vietnamese).
  String format({required String separator, required String decimalMark}) {
    final String plain = _text(trimZeros: true);
    final bool negative = plain.startsWith('-');
    final List<String> parts = (negative ? plain.substring(1) : plain).split('.');
    final String whole = parts.first;
    final StringBuffer grouped = StringBuffer();
    for (int i = 0; i < whole.length; i += 1) {
      if (i > 0 && (whole.length - i) % 3 == 0) grouped.write(separator);
      grouped.write(whole[i]);
    }
    return '${negative ? '-' : ''}$grouped${parts.length > 1 ? '$decimalMark${parts[1]}' : ''}';
  }

  String _text({required bool trimZeros}) {
    final bool negative = _unscaled.isNegative;
    String digits = _unscaled.abs().toString();
    if (_scale > 0) digits = digits.padLeft(_scale + 1, '0');
    String whole = _scale == 0 ? digits : digits.substring(0, digits.length - _scale);
    String fraction = _scale == 0 ? '' : digits.substring(digits.length - _scale);
    if (trimZeros) fraction = fraction.replaceFirst(RegExp(r'0+$'), '');
    if (whole.isEmpty) whole = '0';
    final String body = fraction.isEmpty ? whole : '$whole.$fraction';
    return negative && body != '0' ? '-$body' : body;
  }

  @override
  String toString() => toPlainString();
}
