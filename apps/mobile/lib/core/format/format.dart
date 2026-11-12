/// The one formatter of money, numbers, days and moments of the phone. A feature never formats an amount or a date itself
/// (`test/static/design_rules_test.dart` refuses `NumberFormat` and ad-hoc grouping in `lib/features`).
library;

export 'date_time.dart';
export 'labels.dart';
export 'money.dart';
export 'number.dart';
