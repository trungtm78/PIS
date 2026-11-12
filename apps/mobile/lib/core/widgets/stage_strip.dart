import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/typography.dart';

/// The stage of a project in one strip: [total] segments (6 stages of the project cycle), the finished ones in the primary colour, the
/// current one filled by how far it has got, and one line under it that names the stage ("Stage 4/6 · Implementation") with the count of
/// finished tasks at the end. The segments carry no labels, so nothing is cut at a large text scale; the line is the text.
class StageStrip extends StatelessWidget {
  const StageStrip({
    required this.total,
    required this.current,
    required this.label,
    this.currentFraction = 0,
    this.trailing,
    super.key,
  }) : assert(total > 0 && current >= 0 && current <= total, 'current is a stage from 0 (none started) to total');

  /// The number of stages.
  final int total;

  /// The stage in progress, 1 to [total]; 0 when none has started, [total] when all are finished and [currentFraction] is 1.
  final int current;

  /// How far the current stage has got, 0 to 1.
  final double currentFraction;

  /// "Stage 4/6 · Implementation": the sentence the segments stand for, also the name for a screen reader.
  final String label;

  /// "Tasks done 7/12".
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final double fraction = currentFraction.clamp(0, 1).toDouble();
    Widget segment(int index) {
      final int stage = index + 1;
      final double filled = stage < current ? 1 : (stage == current ? fraction : 0);
      return Expanded(
        child: ClipRRect(
          borderRadius: BorderRadius.circular(MachvonV2Size.stageSegmentHeight / 2),
          child: SizedBox(
            height: MachvonV2Size.stageSegmentHeight,
            child: Stack(
              children: <Widget>[
                Positioned.fill(child: ColoredBox(color: v2.palette.line)),
                if (filled > 0) FractionallySizedBox(widthFactor: filled, child: ColoredBox(color: v2.palette.primary)),
              ],
            ),
          ),
        ),
      );
    }

    return Semantics(
      container: true,
      label: trailing == null ? label : '$label. $trailing',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                for (int index = 0; index < total; index += 1) ...<Widget>[
                  if (index > 0) const SizedBox(width: MachvonV2Space.s4),
                  segment(index),
                ],
              ],
            ),
            const SizedBox(height: 6),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(child: Text(label, style: text.captionStrong)),
                if (trailing != null) ...<Widget>[const SizedBox(width: MachvonV2Space.s8), Flexible(child: Text(trailing!, textAlign: TextAlign.end, style: text.caption))],
              ],
            ),
          ],
        ),
      ),
    );
  }
}
