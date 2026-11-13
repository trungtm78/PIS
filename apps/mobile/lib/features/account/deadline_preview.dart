import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/deadline.dart';
import 'deadline_thresholds.dart';

/// The preview of the three bands of a deadline for the thresholds in force (design-system-v2 section 4, "Nhắc hạn việc"): one line per
/// band with its shape, a sample label and the rule in words, then the note that the personal setting changes only the colour and the
/// reminder on this phone while the official warning and the KPI follow the rule of the unit. The shapes and the words carry the band,
/// the colour only backs them up.
class DeadlinePreview extends StatelessWidget {
  const DeadlinePreview({required this.thresholds, super.key});

  final DeadlineThresholds thresholds;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    String rule(DeadlineBand band) {
      switch (band) {
        case DeadlineBand.late:
          return context.t('mob.account.deadline.rule.late', <String, Object>{'days': thresholds.lateBelow});
        case DeadlineBand.soon:
          return context.t('mob.account.deadline.rule.soon', <String, Object>{'from': thresholds.soonFrom, 'to': thresholds.soonUpTo});
        case DeadlineBand.ok:
        case DeadlineBand.done:
          return context.t('mob.account.deadline.rule.ok', <String, Object>{'days': thresholds.soonUpTo});
      }
    }

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Semantics(container: true, label: context.t('mob.account.deadline.preview.label'), child: Text(context.t('mob.account.deadline.preview.label'), style: text.caption)),
          const SizedBox(height: MachvonV2Space.s8),
          for (final DeadlineBand band in const <DeadlineBand>[DeadlineBand.late, DeadlineBand.soon, DeadlineBand.ok])
            Padding(
              padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
              child: Row(
                children: <Widget>[
                  DeadlineGlyph(band: band),
                  const SizedBox(width: MachvonV2Space.s12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        DeadlineLabel.days(daysRemaining: thresholds.sampleDays(band), band: thresholds.bandOf(thresholds.sampleDays(band))),
                        Text(rule(band), style: text.caption),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          Text(context.t('mob.account.deadline.note'), style: text.caption),
        ],
      ),
    );
  }
}
