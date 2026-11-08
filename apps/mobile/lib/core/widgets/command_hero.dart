import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../l10n/app_strings.dart';
import '../theme/app_theme.dart';
import 'skeleton.dart';

/// The dark command block of the leader home (design.md "CommandHero"): one eyebrow line, the number of the period in 32 px with
/// its unit, a sentence under it, an optional progress ring and up to a few actions. It is the one visual anchor of the screen.
///
/// A [value] of null is "still loading": the block shows grey bars, never a 0. The block reads to a screen reader as one
/// sentence (eyebrow, value with unit, caption); the actions stay separate buttons.
class CommandHero extends StatelessWidget {
  const CommandHero({
    required this.eyebrow,
    required this.value,
    this.unit,
    this.caption,
    this.ratio,
    this.ratioLabel,
    this.actions = const <CommandHeroAction>[],
    this.semanticLabel,
    super.key,
  });

  /// The small uppercase line above the number ("Investment pulse / October 2026").
  final String eyebrow;

  /// The number already formatted, or null while it loads.
  final String? value;

  /// The unit written after the number ("billion dong").
  final String? unit;

  /// One or two sentences under the number.
  final String? caption;

  /// Progress from 0 to 1 drawn as a ring beside the number; null draws no ring.
  final double? ratio;

  /// The text in the middle of the ring ("62%").
  final String? ratioLabel;

  final List<CommandHeroAction> actions;

  /// Read instead of the visible texts when the sentence should be said differently.
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final TextTheme text = Theme.of(context).textTheme;
    final bool loading = value == null;
    final String figureSpoken = loading ? context.t('mob.states.loading.label') : <String>[value!, if (unit != null) unit!].join(' ');
    final String spoken = semanticLabel ?? <String>[eyebrow, figureSpoken, if (caption != null) caption!].join('. ');
    final Widget figure = loading
        ? const Padding(padding: EdgeInsets.symmetric(vertical: MachvonSpace.space8), child: SkeletonBar(width: 168, height: 40, onDark: true))
        : Wrap(
            crossAxisAlignment: WrapCrossAlignment.end,
            spacing: MachvonSpace.space8,
            children: <Widget>[
              Text(value!, style: text.displaySmall?.copyWith(color: MachvonColors.menuText)),
              if (unit != null) Text(unit!, style: text.headlineSmall?.copyWith(color: MachvonColors.menuMuted, fontWeight: FontWeight.w500)),
            ],
          );
    final Widget message = Semantics(
      container: true,
      label: spoken,
      excludeSemantics: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(eyebrow.toUpperCase(), style: text.labelMedium?.copyWith(color: MachvonColors.menuMuted, letterSpacing: 0.72)),
          const SizedBox(height: MachvonSpace.space8),
          figure,
          if (caption != null) ...<Widget>[
            const SizedBox(height: MachvonSpace.space8),
            Text(caption!, style: text.bodyMedium?.copyWith(color: MachvonColors.menuMuted)),
          ],
        ],
      ),
    );
    // At a large text scale the actions stack, so a label never clips in half a row.
    final bool stackActions = MediaQuery.textScalerOf(context).scale(MachvonFont.mobileBody) > 21;
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: MachvonColors.workspaceCard,
        borderRadius: BorderRadius.all(Radius.circular(MachvonRadius.card)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            if (ratio != null && !loading)
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Expanded(child: message),
                  const SizedBox(width: MachvonSpace.space12),
                  _Ring(ratio: ratio!, label: ratioLabel),
                ],
              )
            else
              message,
            if (actions.isNotEmpty) ...<Widget>[
              const SizedBox(height: MachvonSpace.space16),
              if (stackActions)
                Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    for (int i = 0; i < actions.length; i += 1) ...<Widget>[if (i > 0) const SizedBox(height: MachvonSpace.space8), actions[i]],
                  ],
                )
              else
                IntrinsicHeight(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      for (int i = 0; i < actions.length; i += 1) ...<Widget>[
                        if (i > 0) const SizedBox(width: MachvonSpace.space8),
                        Expanded(child: actions[i]),
                      ],
                    ],
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A button on the dark block: white, with dark text, at least 48 dp high; the label wraps instead of clipping.
class CommandHeroAction extends StatelessWidget {
  const CommandHeroAction({required this.label, required this.onPressed, this.icon, super.key});

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final ButtonStyle style = FilledButton.styleFrom(
      backgroundColor: MachvonColors.surface,
      foregroundColor: MachvonColors.ink,
      minimumSize: const Size(MachvonTouch.androidDp, MachvonTouch.androidDp),
      padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space12, vertical: MachvonSpace.space8),
    );
    final Widget text = Text(label, textAlign: TextAlign.center);
    return icon == null
        ? FilledButton(onPressed: onPressed, style: style, child: text)
        : FilledButton.icon(onPressed: onPressed, style: style, icon: Icon(icon, size: MachvonSpace.space20), label: Flexible(child: text));
  }
}

class _Ring extends StatelessWidget {
  const _Ring({required this.ratio, this.label});

  final double ratio;
  final String? label;

  static const double size = 72;

  @override
  Widget build(BuildContext context) {
    final TextTheme text = Theme.of(context).textTheme;
    return ExcludeSemantics(
      child: SizedBox(
        width: size,
        height: size,
        child: CustomPaint(
          painter: _RingPainter(ratio.clamp(0, 1).toDouble()),
          child: Center(
            child: label == null ? null : Text(label!, style: text.labelMedium?.copyWith(color: MachvonColors.menuText, fontFeatures: kTabularFigures)),
          ),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.ratio);

  final double ratio;

  @override
  void paint(Canvas canvas, Size size) {
    const double stroke = 8;
    final Rect arc = (Offset.zero & size).deflate(stroke / 2);
    final Paint track = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..color = MachvonColors.menuMuted.withValues(alpha: 0.28);
    canvas.drawArc(arc, 0, math.pi * 2, false, track);
    if (ratio <= 0) return;
    final Paint progress = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round
      ..color = MachvonColors.selectedBar;
    canvas.drawArc(arc, -math.pi / 2, math.pi * 2 * ratio, false, progress);
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.ratio != ratio;
}
