import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/format/format.dart';

import '../../support/widget_host.dart';

String _short(String dong, {String language = 'vi', int decimals = moneyShortDecimals, MoneyUnit? unit}) {
  final MoneyParts parts = moneyParts(dong, language, decimals: decimals, unit: unit)!;
  return '${parts.number} ${parts.unit.name}';
}

void main() {
  group('the unit of an amount follows its size (finding F-02: "38.000 triệu đồng", "0,001 triệu đồng")', () {
    test('38 billion dong is 38 ty, not 38.000 million', () {
      expect(_short('38000000000'), '38 billion');
      expect(_short('527000000000'), '527 billion');
      expect(_short('1534000000000'), '1.534 billion');
    });

    test('below one million an amount is whole dong with every digit: there is no nghin unit, on the phone as on the web', () {
      expect(_short('1000'), '1.000 dong', reason: 'never "1 nghin", never "0,001 million"');
      expect(_short('2000'), '2.000 dong');
      expect(_short('999'), '999 dong');
      expect(_short('0'), '0 dong');
      expect(_short('1'), '1 dong');
      expect(_short('950000'), '950.000 dong', reason: 'never "950 nghin"');
      expect(_short('950000', language: 'en'), '950,000 dong');
      expect(_short('123456'), '123.456 dong', reason: 'no digit of an amount below one million is rounded away');
      expect(moneyUnitFor(BigInt.from(1000)), MoneyUnit.dong);
      expect(moneyUnitFor(BigInt.from(999999)), MoneyUnit.dong);
      expect(moneyUnitFor(BigInt.from(-999999)), MoneyUnit.dong);
      expect(moneyUnitFor(BigInt.from(1000000)), MoneyUnit.million);
      expect(moneyUnitFor(BigInt.from(999999999)), MoneyUnit.million);
      expect(moneyUnitFor(BigInt.from(1000000000)), MoneyUnit.billion);
      expect(moneyUnitFor(BigInt.zero), MoneyUnit.dong);
    });

    test('the boundaries: 999.999 dong, one million, 999.994.999, 999.995.000, one billion, fifteen digits', () {
      expect(_short('999999'), '999.999 dong', reason: 'the last amount below one million keeps every digit and does not move up');
      expect(_short('999949'), '999.949 dong');
      expect(_short('1000000'), '1 million');
      expect(_short('1000001'), '1 million');
      expect(_short('1004999'), '1 million');
      expect(_short('1005000'), '1,01 million');
      expect(_short('999994999'), '999,99 million', reason: 'the last amount that stays in million at two decimals');
      expect(_short('999995000'), '1 billion', reason: '999,995 million rounds to 1.000,00 and moves up, never "1.000 million"');
      expect(_short('999999999'), '1 billion', reason: '999,999999 million rounds to 1.000 and moves up');
      expect(_short('999949999'), '999,95 million');
      expect(_short('1000000000'), '1 billion');
      expect(_short('1004999999'), '1 billion');
      expect(_short('1005000000'), '1,01 billion');
      expect(_short('999999999999'), '1.000 billion');
      expect(_short('123456789012345'), '123.456,79 billion', reason: 'a 15-digit amount: ty has no unit above it, the thousands are grouped');
      expect(_short('123456789012345', language: 'en'), '123,456.79 billion');
      expect(_short('999999999999999'), '1.000.000 billion');
    });

    test('two decimals at most, trailing zeros dropped, marks of the language', () {
      expect(moneyShortDecimals, 2, reason: 'the short form of the phone is the one of the web');
      expect(_short('928800000000'), '928,8 billion');
      expect(_short('1058300000000'), '1.058,3 billion');
      expect(_short('1058300000000', language: 'en'), '1,058.3 billion');
      expect(_short('420500000'), '420,5 million');
      expect(_short('420000000'), '420 million');
      expect(_short('1250000000'), '1,25 billion', reason: 'two decimals: no longer rounded to 1,3');
      expect(_short('1250000000', language: 'en'), '1.25 billion');
      expect(_short('1049123456'), '1,05 billion');
      expect(_short('1200000000'), '1,2 billion', reason: 'a trailing zero is dropped');
      expect(_short('2000000000'), '2 billion', reason: 'both zeros are dropped, with the decimal mark');
      expect(_short('2350000000'), '2,35 billion');
      expect(_short('2340000000'), '2,34 billion');
      expect(_short('1255000000'), '1,26 billion', reason: 'half rounds away from zero');
      expect(_short('1254999999'), '1,25 billion');
      expect(_short('2350000000', decimals: 1), '2,4 billion', reason: 'a caller that asks for one decimal still gets half away from zero');
      expect(_short('2340000000', decimals: 1), '2,3 billion');
      expect(_short('2350000000', decimals: 0), '2 billion');
      expect(_short('2500000000', decimals: 0), '3 billion');
    });

    test('a fall keeps its sign in every unit and a rounded zero has none', () {
      expect(_short('-30000000'), '-30 million');
      expect(_short('-1000'), '-1.000 dong');
      expect(_short('-999999'), '-999.999 dong');
      expect(_short('-2350000000'), '-2,35 billion');
      expect(_short('-1255000000'), '-1,26 billion', reason: 'half away from zero on a fall too');
      expect(_short('-999995000'), '-1 billion');
      expect(_short('-999994999'), '-999,99 million');
      expect(_short('-1'), '-1 dong');
      expect(_short('-0'), '0 dong');
      expect(_short('-4999', unit: MoneyUnit.million), '0 million', reason: 'a fall that rounds to zero is written without a sign');
      expect(_short('-5000', unit: MoneyUnit.million), '-0,01 million');
    });

    test('a forced unit is kept and is not moved up; nghin is only ever a unit a caller asks for', () {
      expect(_short('38000000000', unit: MoneyUnit.million), '38.000 million');
      expect(_short('1000', unit: MoneyUnit.million), '0 million');
      expect(_short('1000', unit: MoneyUnit.million, decimals: 3), '0,001 million');
      expect(_short('1500', unit: MoneyUnit.dong), '1.500 dong');
      expect(_short('950000', unit: MoneyUnit.thousand), '950 thousand');
      expect(_short('1500', unit: MoneyUnit.thousand), '1,5 thousand');
      expect(_short('1255', unit: MoneyUnit.thousand), '1,26 thousand');
      expect(_short('999999999', unit: MoneyUnit.thousand), '1.000.000 thousand');
    });

    test('the exact mode (the default) never hides a digit: the unit is kept while three decimals show the amount whole, else whole dong', () {
      String exact(String dong, {String language = 'vi'}) {
        final MoneyParts parts = moneyParts(dong, language)!;
        return '${parts.number} ${parts.unit.name}';
      }

      expect(exact('1049000000'), '1,049 billion', reason: 'an approver sees 1,049 billion, not 1 billion');
      expect(exact('1049123456'), '1.049.123.456 dong', reason: 'more than three decimals: whole dong');
      expect(exact('123456789'), '123.456.789 dong');
      expect(exact('38000000000'), '38 billion');
      expect(exact('1058300000000', language: 'en'), '1,058.3 billion');
      expect(exact('420500000'), '420,5 million');
      expect(exact('1000'), '1.000 dong', reason: 'the exact mode follows the same units: no nghin');
      expect(exact('950000'), '950.000 dong');
      expect(exact('999999'), '999.999 dong');
      expect(exact('1000000'), '1 million');
      expect(exact('1001000'), '1,001 million');
      expect(exact('1000500'), '1.000.500 dong', reason: 'a million that needs a fourth decimal is whole dong');
      expect(exact('1000000000'), '1 billion');
      expect(exact('1500'), '1.500 dong');
      expect(exact('999'), '999 dong');
      expect(exact('0'), '0 dong');
      expect(exact('-1049000000'), '-1,049 billion');
      expect(exact('-1500'), '-1.500 dong');
      expect(exact('-950000'), '-950.000 dong');
      expect(exact('123456789012345'), '123.456.789.012.345 dong', reason: 'a 15-digit amount that is not a whole million is whole dong');
      expect(exact('123456789000000'), '123.456,789 billion');
      expect(exact('999999999999999999'), '999.999.999.999.999.999 dong', reason: 'a huge amount that is not a whole million is whole dong');
      expect(moneyParts('1000', 'vi', unit: MoneyUnit.million)!.number, '0,001', reason: 'a forced unit in the exact mode holds every dong of a million');
      expect(moneyParts('1500', 'vi', unit: MoneyUnit.thousand), const MoneyParts('1,5', MoneyUnit.thousand), reason: 'nghin still exists when a caller forces it');
    });

    test('text that is not whole dong gives no parts and is returned as it came by the labels', () {
      expect(moneyParts('abc', 'vi'), isNull);
      expect(moneyParts('1.5', 'vi'), isNull);
      expect(moneyParts('1' * 25, 'vi'), isNull);
      expect(moneyUnitFor(BigInt.from(-5000000)), MoneyUnit.million);
      expect(dongPerUnit(MoneyUnit.billion), BigInt.from(1000000000));
      expect(const MoneyParts('1', MoneyUnit.dong), const MoneyParts('1', MoneyUnit.dong));
      expect(const MoneyParts('1', MoneyUnit.dong).hashCode, const MoneyParts('1', MoneyUnit.dong).hashCode);
      expect(const MoneyParts('1', MoneyUnit.dong), isNot(const MoneyParts('2', MoneyUnit.dong)));
      expect(const MoneyParts('1', MoneyUnit.dong).toString(), 'MoneyParts(1, dong)');
    });
  });

  group('exact money and numbers', () {
    test('whole dong are grouped and sums and differences are exact', () {
      expect(formatDong('420000000', 'vi'), '420.000.000');
      expect(formatDong('420000000', 'en'), '420,000,000');
      expect(formatDong('-1234', 'vi'), '-1.234');
      expect(formatDong('1.5', 'vi'), '1.5');
      expect(sumDong(<String>['100000000', '200000000', 'x']), '300000000');
      expect(differenceDong('90000000', '100000000'), '-10000000');
      expect(parseDong(12), isNull);
    });

    test('a decimal figure keeps every digit, with a plus for a rise when asked', () {
      expect(formatNumber('1234567.50', 'vi'), '1.234.567,5');
      expect(formatNumber('1234567.5', 'en'), '1,234,567.5');
      expect(formatNumber('20', 'vi', signed: true), '+20');
      expect(formatNumber('-20', 'vi', signed: true), '-20');
      expect(formatNumber('0', 'vi', signed: true), '0');
      expect(formatNumber('x', 'vi'), 'x');
      expect(formatNumber(null, 'vi'), '');
    });

    test('a percent is the figure without its sign: the decimal mark of the language, two decimals at most, trailing zeros dropped', () {
      expect(formatPercent('14.0000', 'vi'), '14');
      expect(formatPercent('14.0000', 'en'), '14');
      expect(formatPercent('96.5414', 'vi'), '96,54');
      expect(formatPercent('96.5414', 'en'), '96.54');
      expect(formatPercent('45.0000', 'vi'), '45');
      expect(formatPercent('197.5000', 'vi'), '197,5');
      expect(formatPercent('197.5000', 'en'), '197.5');
      expect(formatPercent('200.0', 'vi'), '200');
      expect(formatPercent('41.20', 'vi'), '41,2');
      expect(formatPercent('0', 'vi'), '0');
      expect(formatPercent('0.00', 'vi'), '0');
      expect(formatPercent('100', 'vi'), '100');
      expect(formatPercent(' 14.50 ', 'vi'), '14,5', reason: 'the space around a figure is not part of it');
      for (final String figure in <String>['14.0000', '96.5414', '-37.625', '1234.5']) {
        expect(formatPercent(figure, 'vi'), isNot(contains('%')), reason: 'the sentence or the caller writes the sign, once');
      }
    });

    test('a percent is rounded half away from zero on its digits, and its thousands are grouped', () {
      expect(formatPercent('37.625', 'vi'), '37,63');
      expect(formatPercent('37.624', 'vi'), '37,62');
      expect(formatPercent('-37.625', 'vi'), '-37,63', reason: 'away from zero, not up');
      expect(formatPercent('-37.624', 'vi'), '-37,62');
      expect(formatPercent('37.625', 'en'), '37.63');
      expect(formatPercent('99.999', 'vi'), '100', reason: 'the rounding carries into the whole part');
      expect(formatPercent('99.995', 'vi'), '100');
      expect(formatPercent('99.994', 'vi'), '99,99');
      expect(formatPercent('999.999', 'vi'), '1.000');
      expect(formatPercent('1234.5', 'vi'), '1.234,5');
      expect(formatPercent('1234.5', 'en'), '1,234.5');
      expect(formatPercent('-1234.5', 'vi'), '-1.234,5');
      expect(formatPercent('0.005', 'vi'), '0,01');
      expect(formatPercent('-0.005', 'vi'), '-0,01');
      expect(formatPercent('0.004', 'vi'), '0');
      expect(formatPercent('-0.004', 'vi'), '0', reason: 'a fall that rounds to zero has no sign');
      expect(formatPercent('-2.5', 'vi'), '-2,5');
      expect(formatPercent('1.005', 'vi'), '1,01', reason: 'on the digits, never through a double (1.005 is 1.00499... as a double)');
      expect(formatPercent('123456789012345678901234.555', 'vi'), '123.456.789.012.345.678.901.234,56', reason: 'more digits than a double holds');
      expect(formatPercent('37.625', 'vi', maxDecimals: 1), '37,6');
      expect(formatPercent('37.65', 'vi', maxDecimals: 1), '37,7');
      expect(formatPercent('37.5', 'vi', maxDecimals: 0), '38');
      expect(formatPercent('-37.5', 'vi', maxDecimals: 0), '-38');
      expect(formatPercent('37.4', 'vi', maxDecimals: 0), '37');
    });

    test('text that is not a number is returned as it came', () {
      expect(formatPercent('n/a', 'vi'), 'n/a');
      expect(formatPercent('', 'vi'), '');
      expect(formatPercent('12,5', 'vi'), '12,5');
      expect(formatPercent('1e3', 'vi'), '1e3');
      expect(formatPercent('.5', 'vi'), '.5');
      expect(formatPercent('5.', 'vi'), '5.');
      expect(formatPercent('14.0000%', 'vi'), '14.0000%', reason: 'a figure that already has its sign is not a figure of the server; the sign is never doubled');
      expect(formatPercent('+5', 'vi'), '+5');
    });

    test('every percent inside a sentence of the server is rewritten, and the words are left as they came', () {
      const String two = 'Tỷ lệ giải ngân 37.625% thấp hơn đường kỳ vọng 45.0000%';
      expect(percentsInText(two, 'vi'), 'Tỷ lệ giải ngân 37,63% thấp hơn đường kỳ vọng 45%');
      expect(percentsInText(two, 'en'), 'Tỷ lệ giải ngân 37.63% thấp hơn đường kỳ vọng 45%');
      expect(percentsInText('Giải ngân 96.5414%, lệch -4.10% so với kế hoạch 1234.50%', 'vi'), 'Giải ngân 96,54%, lệch -4,1% so với kế hoạch 1.234,5%');
      expect(percentsInText('14.0000%', 'vi'), '14%');
      expect(percentsInText('Vượt 200.0%.', 'vi'), 'Vượt 200%.');
      const String none = 'Dự án 12.5 km chậm 3 ngày, hợp đồng 01.2026/HĐ';
      expect(percentsInText(none, 'vi'), none, reason: 'only a number that is immediately followed by the sign is touched');
      expect(percentsInText(none, 'en'), none);
      expect(percentsInText('Không có số liệu', 'vi'), 'Không có số liệu');
      expect(percentsInText('', 'vi'), '');
      expect(percentsInText('Còn 50 % kế hoạch', 'vi'), 'Còn 50 % kế hoạch', reason: 'a sign that does not touch its number is left alone');
      expect(percentsInText('Tỷ lệ 37,63%', 'vi'), 'Tỷ lệ 37,63%', reason: 'a sentence already written for a person is not changed again');
      expect('%'.allMatches(percentsInText(two, 'vi')).length, 2, reason: 'no sign is added or lost');
    });

    test('bytes take the size unit and the decimal mark of the language', () {
      expect(formatBytes(512), '512 B');
      expect(formatBytes(1536), '1,5 KB');
      expect(formatBytes(1536, language: 'en'), '1.5 KB');
      expect(formatBytes(3 * 1024 * 1024), '3,0 MB');
    });
  });

  group('days and moments are Vietnam time, whatever the zone of the phone', () {
    test('a moment is date then time; English writes the year first', () {
      expect(formatMoment('2026-10-31T09:00:00Z'), '31/10/2026 16:00');
      expect(formatMoment('2026-10-31T20:30:00Z'), '01/11/2026 03:30');
      expect(formatMoment('2026-10-31T20:30:00Z', language: 'en'), '2026-11-01 03:30');
      expect(formatMoment('not an instant'), 'not an instant');
      expect(formatInstant(DateTime.utc(2026, 11, 3, 7, 5)), '03/11/2026 14:05');
      expect(formatInstant(DateTime.utc(2026, 11, 3, 7, 5), language: 'en'), '2026-11-03 14:05');
    });

    test('days, short days and times', () {
      expect(formatDay('2026-10-31'), '31/10/2026');
      expect(formatDay('2026-10-31', language: 'en'), '2026-10-31');
      expect(formatDay('2026-10-31T20:30:00Z'), '01/11/2026');
      expect(formatDay('2026-10-31T20:30:00Z', language: 'en'), '2026-11-01');
      expect(formatDay('???'), '???');
      expect(formatDayShort('2026-11-10'), '10/11');
      expect(formatDayShort('2026-11-10T20:00:00Z'), '11/11');
      expect(formatDayShort('???'), '???');
      expect(formatTime('2026-11-10T20:05:00Z'), '03:05');
      expect(formatTime('???'), '???');
      expect(vietnamDayOf(DateTime.utc(2026, 11, 3, 3)), '2026-11-03');
      expect(vietnamDayOf(DateTime.utc(2026, 11, 3, 18)), '2026-11-04');
      expect(vietnamOffset, const Duration(hours: 7));
    });

    test('the moment an answer describes: a day as a date, an instant with its time', () {
      expect(asOfLabel('2026-10-31'), '31/10/2026');
      expect(asOfLabel('2026-10-31T09:00:00Z'), '31/10/2026 16:00');
      expect(asOfLabel('2026-10-31', language: 'en'), '2026-10-31');
    });
  });

  group('the labels say the unit in the language of the interface', () {
    Future<void> inHost(WidgetTester tester, Locale locale, void Function(BuildContext context) body) async {
      await tester.pumpWidget(hostWidget(Builder(builder: (BuildContext context) {
        body(context);
        return const SizedBox.shrink();
      }), locale: locale));
    }

    testWidgets('Vietnamese', (WidgetTester tester) async {
      await inHost(tester, const Locale('vi'), (BuildContext c) {
        expect(moneyLabel(c, '38000000000'), '38 tỷ đồng');
        expect(moneyLabel(c, '1000'), '1.000 đồng', reason: 'there is no nghin unit: whole dong below one million');
        expect(moneyLabel(c, '2000'), '2.000 đồng');
        expect(moneyLabel(c, '950000'), '950.000 đồng');
        expect(moneyLabel(c, '1000', unit: MoneyUnit.thousand), '1 nghìn đồng', reason: 'only when a caller forces the unit');
        expect(moneyLabel(c, '420000000'), '420 triệu đồng');
        expect(moneyLabel(c, '999'), '999 đồng');
        expect(moneyLabel(c, null), 'Chưa có số liệu');
        expect(moneyLabel(c, 'abc'), 'abc');
        expect(moneyLabel(c, '38000000000', unit: MoneyUnit.million), '38.000 triệu đồng');
        expect(signedMoneyLabel(c, '50000000'), '+50 triệu đồng');
        expect(signedMoneyLabel(c, '-30000000'), '-30 triệu đồng');
        expect(signedMoneyLabel(c, '0'), '0 đồng');
        expect(signedMoneyLabel(c, null), 'Chưa có số liệu');
        expect(moneyShortLabel(c, '1049123456'), '1,05 tỷ đồng', reason: 'a row or a tile reads at a glance; the detail has every dong');
        expect(moneyShortLabel(c, '1250000000'), '1,25 tỷ đồng');
        expect(moneyShortLabel(c, '-1250000000'), '-1,25 tỷ đồng');
        expect(moneyShortLabel(c, '420500000'), '420,5 triệu đồng');
        expect(moneyShortLabel(c, '999960000'), '999,96 triệu đồng');
        expect(moneyShortLabel(c, '999994999'), '999,99 triệu đồng');
        expect(moneyShortLabel(c, '999995000'), '1 tỷ đồng', reason: 'never "1.000 triệu đồng"');
        expect(moneyShortLabel(c, '1000000000'), '1 tỷ đồng');
        expect(moneyShortLabel(c, '1000000'), '1 triệu đồng');
        expect(moneyShortLabel(c, '999999'), '999.999 đồng');
        expect(moneyShortLabel(c, '950000'), '950.000 đồng');
        expect(moneyShortLabel(c, '2000'), '2.000 đồng');
        expect(moneyShortLabel(c, '123456789012345'), '123.456,79 tỷ đồng');
        expect(moneyShortLabel(c, '0'), '0 đồng');
        expect(moneyShortLabel(c, 'abc'), 'abc', reason: 'text that is not an amount is returned as it came, with no unit');
        expect(moneyShortLabel(c, '999'), '999 đồng');
        expect(moneyShortLabel(c, null), 'Chưa có số liệu');
        expect(moneyExactLabel(c, '420000000'), '420.000.000 đồng');
        expect(moneyExactLabel(c, null), 'Chưa có số liệu');
        expect(moneyFullLabel(c, '2350000000'), '2.350.000.000 đồng (2,35 tỷ đồng)');
        expect(moneyFullLabel(c, '950000'), '950.000 đồng');
        expect(moneyFullLabel(c, 'abc'), 'abc đồng');
        expect(moneyFullLabel(c, null), 'Chưa có số liệu');
      });
    });

    testWidgets('English', (WidgetTester tester) async {
      await inHost(tester, const Locale('en'), (BuildContext c) {
        expect(moneyLabel(c, '38000000000'), '38 billion dong');
        expect(moneyLabel(c, '1058300000000'), '1,058.3 billion dong');
        expect(moneyLabel(c, '420500000'), '420.5 million dong');
        expect(moneyLabel(c, '2000'), '2,000 dong');
        expect(moneyLabel(c, '2000', unit: MoneyUnit.thousand), '2 thousand dong', reason: 'only when a caller forces the unit');
        expect(moneyShortLabel(c, '1250000000'), '1.25 billion dong');
        expect(moneyShortLabel(c, '950000'), '950,000 dong');
        expect(moneyLabel(c, '5'), '5 dong');
        expect(moneyLabel(c, null), 'No figure yet');
      });
    });

    testWidgets('deadlines: late, today, tomorrow, left', (WidgetTester tester) async {
      await inHost(tester, const Locale('vi'), (BuildContext c) {
        expect(formatDeadline(c, -2), 'Trễ 2 ngày');
        expect(formatDeadline(c, -1), 'Trễ 1 ngày');
        expect(formatDeadline(c, 0), 'Hôm nay');
        expect(formatDeadline(c, 1), 'Ngày mai');
        expect(formatDeadline(c, 8), 'Còn 8 ngày');
      });
      await inHost(tester, const Locale('en'), (BuildContext c) {
        expect(formatDeadline(c, -2), 'Late by 2 days');
        expect(formatDeadline(c, -1), 'Late by 1 day');
        expect(formatDeadline(c, 8), '8 days left');
      });
    });
  });
}
