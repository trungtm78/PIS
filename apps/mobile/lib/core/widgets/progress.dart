import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../format/format.dart';
import '../l10n/app_strings.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';

/// A thin bar for a share of something (progress of a project, disbursement): 6 high, a sunken track, the primary colour for the filled
/// part, no gradient. [value] is 0 to 1. The share is said to a screen reader as a percent, with [label] in front when it is given
/// ("Disbursement, 58,1%"); the bar alone is not text, so the number must also be written near it by the screen.
class ProgressMeter extends StatelessWidget {
  const ProgressMeter({required this.value, this.label, this.width, this.height = MachvonV2Size.barHeight, super.key});

  final double value;
  final String? label;

  /// A fixed width (a bar in a row); null fills the width it is given.
  final double? width;
  final double height;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final double share = value.clamp(0, 1).toDouble();
    final String percent = '${formatPercent((share * 100).toStringAsFixed(1), AppStrings.of(context).language)}%';
    return Semantics(
      container: true,
      label: label == null ? percent : '$label, $percent',
      excludeSemantics: true,
      child: SizedBox(
        width: width,
        height: height,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(height / 2),
          child: Stack(
            children: <Widget>[
              Positioned.fill(child: ColoredBox(color: v2.palette.sunken)),
              FractionallySizedBox(widthFactor: share, heightFactor: 1, child: ColoredBox(color: v2.palette.primary)),
            ],
          ),
        ),
      ),
    );
  }
}

/// One bar of a [MiniChart]: a name, a value from 0 to [max] and the text of the value.
class MiniChartDatum {
  const MiniChartDatum({required this.label, required this.value, required this.valueText, this.max = 1});

  final String label;
  final double value;

  /// The value as the screen says it: "63 billion dong".
  final String valueText;

  /// The value that fills the bar; a shared scale is the largest value of the chart.
  final double max;
}

/// A small horizontal bar chart (disbursement by source of capital, rows of a report): a label and the value on one line and a bar
/// under it. The chart has no axes, no legend and no colour of its own: every bar is named and carries its value as text, so it is read
/// in full without seeing the bars. All the bars are drawn in the primary colour.
class MiniChart extends StatelessWidget {
  const MiniChart({required this.data, this.semanticLabel, super.key});

  final List<MiniChartDatum> data;

  /// What the chart shows, for a screen reader, read before the bars.
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return Semantics(
      container: true,
      label: semanticLabel,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          for (final MiniChartDatum item in data)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
              child: Semantics(
                container: true,
                label: '${item.label}: ${item.valueText}',
                excludeSemantics: true,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Expanded(child: Text(item.label, style: text.body)),
                        const SizedBox(width: MachvonV2Space.s8),
                        Text(item.valueText, style: text.label),
                      ],
                    ),
                    const SizedBox(height: MachvonV2Space.s4),
                    ProgressMeter(value: item.max <= 0 ? 0 : item.value / item.max),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
