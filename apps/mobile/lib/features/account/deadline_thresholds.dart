import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/di/providers.dart' show apiClientProvider;
import '../../core/session/session.dart' show sessionProvider;
import '../../core/theme/colors.dart';
import '../project_workflow/pwf_models.dart';

/// The days that separate the three bands of a deadline for one person (design-system-v2 section 4): red below [lateBelow] days left, yellow
/// up to [soonUpTo] days, green beyond. The defaults are the system ones (1 and 3). A person may only be warned EARLIER than the rule of the
/// unit (R40), so a personal setting widens the yellow and red bands and never narrows them; the official warning, the escalation and the KPI
/// never read this (they follow the rule of the unit on the server).
///
/// This is the place for the personal setting: [deadlineThresholdsProvider] holds the thresholds in force for the person who is signed in, the personal ones where they set
/// them and the official ones of the rule otherwise (the same record MOB-82 edits), and is read again after a save.
final class DeadlineThresholds {
  const DeadlineThresholds({this.lateBelow = defaultLateBelow, this.soonUpTo = defaultSoonUpTo})
      : assert(lateBelow >= 0 && soonUpTo >= lateBelow, 'the yellow band starts where the red one ends');

  /// The system default: under one day left is red.
  static const int defaultLateBelow = 1;

  /// The system default: up to three days left is yellow.
  static const int defaultSoonUpTo = 3;

  static const DeadlineThresholds system = DeadlineThresholds();

  /// The thresholds in force for a person from their setting on the server (MOB-82). The server counts a band up to its day, the day itself included: red up to `red_days` left,
  /// yellow up to `yellow_days`, green beyond. Here the red band is the days below [lateBelow] and the yellow one the days up to [soonUpTo], so red is `lateBelow - 1` and the
  /// boundaries stay inclusive on the same days. A threshold the person did not set is the official one, and one the official rule does not give is the system one. A set that
  /// is not ordered (which the server refuses) is not shown: the system thresholds stand.
  factory DeadlineThresholds.effective(PwfPreference preference) {
    final int red = preference.red ?? preference.official?.red ?? system.lateBelow - 1;
    final int yellow = preference.yellow ?? preference.official?.yellow ?? system.soonUpTo;
    if (red < -1 || yellow <= red) return system;
    return DeadlineThresholds(lateBelow: red + 1, soonUpTo: yellow);
  }

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

/// The thresholds in force on this phone: the system ones until the setting of the person on the server has been read, then the personal thresholds (or the official ones where
/// they set none). A person or a tenant who signs in starts again from the system ones; a setting that cannot be read leaves them as they are, and it is read again when the
/// provider is invalidated (after MOB-82 saved a change).
class DeadlineThresholdsNotifier extends Notifier<DeadlineThresholds> {
  @override
  DeadlineThresholds build() {
    ref.watch(sessionProvider.select((session) => '${session.tenantId}|${session.userId}'));
    bool current = true;
    ref.onDispose(() => current = false);
    unawaited(_read(() => current));
    return DeadlineThresholds.system;
  }

  Future<void> _read(bool Function() stillCurrent) async {
    try {
      final PwfPreference? preference = parsePwfPreference(await ref.read(apiClientProvider).getDeadlinePreference());
      if (preference != null && stillCurrent()) state = DeadlineThresholds.effective(preference);
    } on Object {
      // Not read now (no network, no right): the preview shows the system thresholds, as before.
    }
  }
}

final NotifierProvider<DeadlineThresholdsNotifier, DeadlineThresholds> deadlineThresholdsProvider =
    NotifierProvider<DeadlineThresholdsNotifier, DeadlineThresholds>(DeadlineThresholdsNotifier.new);
