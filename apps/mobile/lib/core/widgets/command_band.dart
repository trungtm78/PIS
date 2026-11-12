import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/typography.dart';
import 'app_scaffold.dart';

/// The dark command band of a leader home (the brand anchor of the design): a title, one large figure with its unit, one bar and two
/// lines of notes. In a tenant overlay it takes the tenant `menu` colour. The figure is drawn once and is a single semantic node that
/// reads the label, the figure and the bar together.
class CommandBand extends StatelessWidget {
  const CommandBand({
    required this.title,
    required this.label,
    required this.figure,
    required this.unit,
    required this.progress,
    required this.progressLabel,
    required this.footStart,
    required this.footEnd,
    this.subtitle,
    this.actions = const <Widget>[],
    this.showBack,
    super.key,
  });

  /// "Overview".
  final String title;
  final String? subtitle;

  /// What the figure is: "Cumulative disbursement 2026 by the State Treasury".
  final String label;

  /// The figure with the marks of the language: "1.058,3".
  final String figure;

  /// "billion dong".
  final String unit;

  /// 0 to 1, drawn as the bar; the share is also said in [progressLabel].
  final double progress;

  /// The sentence the bar stands for, for a screen reader: "Disbursed 58.1% of the capital plan".
  final String progressLabel;
  final String footStart;
  final String footEnd;
  final List<Widget> actions;
  final bool? showBack;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return ColoredBox(
      color: v2.palette.header,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          AppTopBar(actions: actions, showBack: showBack, onHeader: true),
          LargeTitleHeader(title: title, subtitle: subtitle, onHeader: true),
          Padding(
            padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, 0, MachvonV2Space.s16, MachvonV2Space.s24),
            child: Semantics(
              container: true,
              label: '$label: $figure $unit. $progressLabel. $footStart. $footEnd',
              excludeSemantics: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(label, style: text.label.copyWith(color: v2.palette.onHeader2)),
                  const SizedBox(height: 2),
                  Wrap(
                    crossAxisAlignment: WrapCrossAlignment.end,
                    spacing: MachvonV2Space.s8,
                    children: <Widget>[
                      Text(figure, style: text.display.copyWith(color: v2.palette.onHeader), textScaler: cappedScaler(context, MachvonV2Type.displayScaleCap)),
                      Padding(
                        padding: const EdgeInsets.only(bottom: MachvonV2Space.s4),
                        child: Text(unit, style: text.label.copyWith(color: v2.palette.onHeader2)),
                      ),
                    ],
                  ),
                  const SizedBox(height: MachvonV2Space.s12),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(MachvonV2Size.heroBarHeight / 2),
                    child: SizedBox(
                      height: MachvonV2Size.heroBarHeight,
                      child: Stack(
                        children: <Widget>[
                          Positioned.fill(child: ColoredBox(color: v2.palette.header2)),
                          FractionallySizedBox(widthFactor: progress.clamp(0, 1).toDouble(), heightFactor: 1, child: ColoredBox(color: v2.palette.accentOnDark)),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: MachvonV2Space.s8),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Expanded(child: Text(footStart, style: text.caption.copyWith(color: v2.palette.onHeader2))),
                      const SizedBox(width: MachvonV2Space.s8),
                      Flexible(child: Text(footEnd, textAlign: TextAlign.end, style: text.caption.copyWith(color: v2.palette.onHeader2))),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
