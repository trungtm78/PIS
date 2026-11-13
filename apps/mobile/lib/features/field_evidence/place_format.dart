import 'package:flutter/widgets.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';

/// A coordinate in the decimal mark of the language of the screen (`10,762622` in Vietnamese, `10.762622` in English), from its wire text
/// (`fixedDecimal`, or the text the server gave back): the digits are those of the wire, none is dropped.
String coordinateLabel(BuildContext context, String wire) => wire.replaceFirst('.', decimalMark(AppStrings.of(context).language));

/// How far off a measured position may be, in whole metres.
String metresLabel(BuildContext context, double metres) => formatNumber(metres.round().toString(), AppStrings.of(context).language);
