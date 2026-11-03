import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import 'moment.dart';
import 'money.dart';

/// An amount of whole dong in millions of dong, written in the language of the interface (`420 triệu đồng`).
String millionsLabel(BuildContext context, String? vnd) {
  if (vnd == null) return context.t('mob.read.money.none');
  return context.t('mob.read.money.millions', <String, Object>{'value': formatMillions(vnd, AppStrings.of(context).language)});
}

/// The exact amount in dong, grouped (`420.000.000 đồng`).
String dongLabel(BuildContext context, String? vnd) {
  if (vnd == null) return context.t('mob.read.money.none');
  return context.t('mob.read.money.dong', <String, Object>{'value': formatDong(vnd, AppStrings.of(context).language)});
}

/// The moment an answer describes: a day (`2026-10-31`) as a date, an instant in Vietnam time.
String asOfLabel(String asOf) => RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(asOf) ? formatDay(asOf) : formatMoment(asOf);
