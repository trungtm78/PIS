import 'package:flutter/widgets.dart';

import '../l10n/app_strings.dart';
import 'money.dart';

/// An amount of whole dong in the unit that fits it, in the language of the interface: `38 ty dong`, `1,049 ty dong`, `420 trieu dong`,
/// `1 nghin dong`, `999 dong`. Exact by default (no digit is hidden); pass `decimals: 1` for the short form of a row or a tile. A missing
/// amount says so; text that is not an amount is returned as it came. See `moneyParts`.
String moneyLabel(BuildContext context, String? vnd, {int? decimals, MoneyUnit? unit, bool signed = false}) {
  if (vnd == null) return context.t('mob.format.money.none');
  final MoneyParts? parts = moneyParts(vnd, AppStrings.of(context).language, decimals: decimals, unit: unit);
  if (parts == null) return vnd;
  final bool rise = signed && !parts.number.startsWith('-') && parts.number != '0';
  return _withUnit(context, rise ? '+${parts.number}' : parts.number, parts.unit);
}

/// The same with its sign (`+50 trieu dong`, `-30 trieu dong`), for a change.
String signedMoneyLabel(BuildContext context, String? vnd) => moneyLabel(context, vnd, signed: true);

/// The exact amount in dong, grouped (`420.000.000 dong`): for the detail of an amount, a confirmation, a payment.
String moneyExactLabel(BuildContext context, String? vnd) {
  if (vnd == null) return context.t('mob.format.money.none');
  return context.t('mob.format.money.dong', <String, Object>{'value': formatDong(vnd, AppStrings.of(context).language)});
}

/// The exact amount with the short one beside it from one million on (`2.350.000.000 dong (2,35 ty dong)`).
String moneyFullLabel(BuildContext context, String? vnd) {
  final BigInt? amount = vnd == null ? null : parseDong(vnd);
  if (vnd == null || amount == null || amount.abs() < dongPerUnit(MoneyUnit.million)) return moneyExactLabel(context, vnd);
  return context.t('mob.format.money.full', <String, Object>{'exact': moneyExactLabel(context, vnd), 'short': moneyLabel(context, vnd, decimals: 2)});
}

// Each key is written out so the string check can see it is in use.
String _withUnit(BuildContext context, String number, MoneyUnit unit) {
  final Map<String, Object> values = <String, Object>{'value': number};
  switch (unit) {
    case MoneyUnit.dong:
      return context.t('mob.format.money.dong', values);
    case MoneyUnit.thousand:
      return context.t('mob.format.money.thousand', values);
    case MoneyUnit.million:
      return context.t('mob.format.money.million', values);
    case MoneyUnit.billion:
      return context.t('mob.format.money.billion', values);
  }
}

/// A deadline as a person says it, from the number of calendar days the server counted in Vietnam time (negative when it has passed):
/// `Tre 2 ngay`, `Hom nay`, `Ngay mai`, `Con 8 ngay`. The phone never counts the days itself.
String formatDeadline(BuildContext context, int daysRemaining) {
  if (daysRemaining < -1) return context.t('mob.format.deadline.late', <String, Object>{'days': -daysRemaining});
  if (daysRemaining == -1) return context.t('mob.format.deadline.lateOne');
  if (daysRemaining == 0) return context.t('mob.format.deadline.today');
  if (daysRemaining == 1) return context.t('mob.format.deadline.tomorrow');
  return context.t('mob.format.deadline.left', <String, Object>{'days': daysRemaining});
}
