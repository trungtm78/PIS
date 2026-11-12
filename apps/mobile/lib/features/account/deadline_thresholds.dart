import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/colors.dart';

/// The days that separate the three bands of a deadline for one person (design-system-v2 section 4): red below [lateBelow] days left, yellow
/// up to [soonUpTo] days, green beyond. The defaults are the system ones (1 and 3). A person may only be warned EARLIER than the rule of the
/// unit (R40), so a personal setting widens the yellow and red bands and never narrows them; the official warning, the escalation and the KPI
/// never read this (they follow the rule of the unit on the server).
///
/// This is the place for the personal setting. Today the phone only shows the preview of the defaults; the profile on the server
/// (`alert_notification_profile`) will fill [deadlineThresholdsProvider] when its API exists, with no change to the screens.
final class DeadlineThresholds {
  const DeadlineThresholds({this.lateBelow = defaultLateBelow, this.soonUpTo = defaultSoonUpTo})
      : assert(lateBelow >= 1 && soonUpTo >= lateBelow, 'the yellow band starts where the red one ends');

  /// The system default: under one day left is red.
  static const int defaultLateBelow = 1;

  /// The system default: up to three days left is yellow.
  static const int defaultSoonUpTo = 3;

  static const DeadlineThresholds system = DeadlineThresholds();

  final int lateBelow;
  final int soonUpTo;

  /// The band of a deadline with [daysRemaining] days left (negative when it has passed), the server's count.
  DeadlineBand bandOf(int daysRemaining) => DeadlineBand.fromDays(daysRemaining, lateBelow: lateBelow, soonUpTo: soonUpTo);

  /// The first day of the yellow band: the red band is the days below it.
  int get soonFrom => lateBelow;

  /// A day count that falls in [band], for the preview: it is read back through [bandOf], so the sample never disagrees with the rule.
  int sampleDays(DeadlineBand band) {
    switch (band) {
      case DeadlineBand.late:
        return lateBelow - 1;
      case DeadlineBand.soon:
        return lateBelow + 1 <= soonUpTo ? lateBelow + 1 : soonUpTo;
      case DeadlineBand.ok:
      case DeadlineBand.done:
        return soonUpTo + 2;
    }
  }

  @override
  bool operator ==(Object other) => other is DeadlineThresholds && other.lateBelow == lateBelow && other.soonUpTo == soonUpTo;

  @override
  int get hashCode => Object.hash(lateBelow, soonUpTo);
}

/// The thresholds in force on this phone: the system ones until the personal profile of the server fills them.
class DeadlineThresholdsNotifier extends Notifier<DeadlineThresholds> {
  @override
  DeadlineThresholds build() => DeadlineThresholds.system;
}

final NotifierProvider<DeadlineThresholdsNotifier, DeadlineThresholds> deadlineThresholdsProvider =
    NotifierProvider<DeadlineThresholdsNotifier, DeadlineThresholds>(DeadlineThresholdsNotifier.new);
