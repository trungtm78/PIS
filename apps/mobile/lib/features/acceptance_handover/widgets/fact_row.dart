import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/tap_target.dart';

/// A row of a list of records that carries what a person needs to pick one: a glyph, the number of the record, up to three lines of
/// facts and a state at the end. It is one tap target and is read as one button; a large text scale lets the lines wrap and moves the
/// state under them, so nothing is cut.
class FactRow extends StatelessWidget {
  const FactRow({
    required this.title,
    required this.lines,
    required this.semanticLabel,
    required this.onTap,
    this.icon = Icons.fact_check_outlined,
    this.trailing,
    this.dividerAbove = false,
    super.key,
  });

  final String title;

  /// The facts under the title, most important first.
  final List<String> lines;
  final String semanticLabel;
  final VoidCallback? onTap;
  final IconData icon;

  /// The state of the record (a pill); under the lines at a large text scale.
  final Widget? trailing;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final bool large = largeText(context);
    final Widget main = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(title, style: text.bodyStrong),
        for (final String line in lines) Text(line, style: text.caption.copyWith(color: v2.palette.ink2)),
        if (large && trailing != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: trailing),
      ],
    );
    final Widget row = Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          ExcludeSemantics(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(MachvonV2Radius.glyph),
              child: ColoredBox(
                color: v2.palette.primarySoft,
                child: SizedBox(width: MachvonV2Size.glyph, height: MachvonV2Size.glyph, child: Icon(icon, size: 22, color: v2.palette.primaryStrong)),
              ),
            ),
          ),
          const SizedBox(width: MachvonV2Space.s12),
          Expanded(child: main),
          if (!large && trailing != null) ...<Widget>[const SizedBox(width: MachvonV2Space.s8), ConstrainedBox(constraints: const BoxConstraints(maxWidth: 124), child: trailing)],
          if (onTap != null) ExcludeSemantics(child: Icon(Icons.chevron_right, color: v2.palette.ink3)),
        ],
      ),
    );
    final Widget tappable = TapTarget(
      onTap: onTap,
      semanticLabel: semanticLabel,
      radius: 0,
      minHeight: MachvonV2Size.rowMinHeight,
      child: SizedBox(width: double.infinity, child: row),
    );
    if (!dividerAbove) return tappable;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(left: MachvonV2Space.s16 + MachvonV2Size.glyph + MachvonV2Space.s12),
          child: SizedBox(height: 1, child: ColoredBox(color: v2.palette.line)),
        ),
        tappable,
      ],
    );
  }
}
