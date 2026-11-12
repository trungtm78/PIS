import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/format/format.dart';

import '../../support/widget_host.dart';

String _short(String dong, {String language = 'vi', int decimals = 1, MoneyUnit? unit}) {
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

    test('one thousand dong is 1 nghin, not 0,001 million; below one thousand it is exact dong', () {
      expect(_short('1000'), '1 thousand');
      expect(_short('999'), '999 dong');
      expect(_short('0'), '0 dong');
      expect(_short('1'), '1 dong');
      expect(_short('950000'), '950 thousand');
    });

    test('the boundaries: 999.999 dong, one million, 999.999.999, one billion', () {
      expect(_short('999999'), '1 million', reason: '999,999 thousand rounds to 1.000 and moves up');
      expect(_short('999949'), '999,9 thousand');
      expect(_short('1000000'), '1 million');
      expect(_short('999999999'), '1 billion', reason: '999,999999 million rounds to 1.000 and moves up');
      expect(_short('999949999'), '999,9 million');
      expect(_short('1000000000'), '1 billion');
      expect(_short('999999999999'), '1.000 billion');
    });

    test('one decimal at most, trailing zero dropped, marks of the language', () {
      expect(_short('928800000000'), '928,8 billion');
      expect(_short('1058300000000'), '1.058,3 billion');
      expect(_short('1058300000000', language: 'en'), '1,058.3 billion');
      expect(_short('420500000'), '420,5 million');
      expect(_short('420000000'), '420 million');
      expect(_short('2350000000'), '2,4 billion', reason: 'half rounds away from zero');
      expect(_short('2350000000', decimals: 2), '2,35 billion');
      expect(_short('2340000000'), '2,3 billion');
    });

    test('a fall keeps its sign in every unit and a rounded zero has none', () {
      expect(_short('-30000000'), '-30 million');
      expect(_short('-1000'), '-1 thousand');
      expect(_short('-2350000000'), '-2,4 billion');
    });

    test('a forced unit is kept and is not moved up', () {
      expect(_short('38000000000', unit: MoneyUnit.million), '38.000 million');
      expect(_short('1000', unit: MoneyUnit.million), '0 million');
      expect(_short('1000', unit: MoneyUnit.million, decimals: 3), '0,001 million');
      expect(_short('1500', unit: MoneyUnit.dong), '1.500 dong');
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
      expect(exact('1000'), '1 thousand');
      expect(exact('950000'), '950 thousand');
      expect(exact('1500'), '1.500 dong', reason: 'a nghin with a fraction is written in dong');
      expect(exact('999'), '999 dong');
      expect(exact('0'), '0 dong');
      expect(exact('-1049000000'), '-1,049 billion');
      expect(exact('-1500'), '-1.500 dong');
      expect(exact('999999999999999999'), '999.999.999.999.999.999 dong', reason: 'a huge amount that is not a whole million is whole dong');
      expect(moneyParts('1000', 'vi', unit: MoneyUnit.million)!.number, '0,001', reason: 'a forced unit in the exact mode holds every dong of a million');
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

    test('percent takes the decimal mark of the language, bytes the size unit', () {
      expect(formatPercent('14.0000', 'vi'), '14,0000');
      expect(formatPercent('14.0000', 'en'), '14.0000');
      expect(formatPercent('n/a', 'vi'), 'n/a');
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
        expect(moneyLabel(c, '1000'), '1 nghìn đồng');
        expect(moneyLabel(c, '420000000'), '420 triệu đồng');
        expect(moneyLabel(c, '999'), '999 đồng');
        expect(moneyLabel(c, null), 'Chưa có số liệu');
        expect(moneyLabel(c, 'abc'), 'abc');
        expect(moneyLabel(c, '38000000000', unit: MoneyUnit.million), '38.000 triệu đồng');
        expect(signedMoneyLabel(c, '50000000'), '+50 triệu đồng');
        expect(signedMoneyLabel(c, '-30000000'), '-30 triệu đồng');
        expect(signedMoneyLabel(c, '0'), '0 đồng');
        expect(signedMoneyLabel(c, null), 'Chưa có số liệu');
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
        expect(moneyLabel(c, '2000'), '2 thousand dong');
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
