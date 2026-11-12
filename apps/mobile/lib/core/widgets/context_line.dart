import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../l10n/app_strings.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import 'tap_target.dart';

/// The one line of context under the title of a screen: the scope, the closing date and how fresh the data is, separated by dots, in one
/// line that opens on a tap to show it whole. It replaces the two bars (context and freshness) that said the same thing twice and took
/// a seventh of the height of the screen. When the figures are stale a warning icon and the words say so; the line is a live region, so
/// the change is announced.
class ContextLine extends StatefulWidget {
  const ContextLine({required this.parts, this.stale = false, this.onRefresh, this.refreshLabel, super.key});

  /// The pieces of the line, already worded: "Whole company", "Closed 30/10/2026", "Updated 08:00".
  final List<String> parts;

  /// Shows the "Stale figures" notice with its icon.
  final bool stale;

  /// A refresh button at the end (48 by 48); null hides it.
  final VoidCallback? onRefresh;

  /// The name of the refresh button for a screen reader.
  final String? refreshLabel;

  @override
  State<ContextLine> createState() => _ContextLineState();
}

class _ContextLineState extends State<ContextLine> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String line = widget.parts.join(' · ');
    final bool large = largeText(context);
    final Widget words = Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        if (widget.stale) ...<Widget>[
          Icon(Icons.warning_amber_rounded, size: 16, color: v2.palette.soonFg),
          const SizedBox(width: MachvonV2Space.s4),
          Text(context.t('mob.ctx.stale.badge'), style: text.captionStrong.copyWith(color: v2.palette.soonFg)),
          const SizedBox(width: MachvonV2Space.s8),
        ],
        Expanded(child: Text(line, style: text.caption, maxLines: _open || large ? null : 1, overflow: _open || large ? TextOverflow.visible : TextOverflow.ellipsis)),
      ],
    );
    return Semantics(
      container: true,
      liveRegion: true,
      child: DecoratedBox(
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: v2.palette.line))),
        child: Row(
          children: <Widget>[
            Expanded(
              child: TapTarget(
                onTap: () => setState(() => _open = !_open),
                radius: 0,
                semanticLabel: widget.stale ? '${context.t('mob.ctx.stale.badge')}. $line' : line,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
                  child: SizedBox(width: double.infinity, child: words),
                ),
              ),
            ),
            if (widget.onRefresh != null)
              SizedBox(
                width: 48,
                height: 48,
                child: IconButton(onPressed: widget.onRefresh, tooltip: widget.refreshLabel, icon: Icon(Icons.refresh, color: v2.palette.primaryStrong)),
              ),
          ],
        ),
      ),
    );
  }
}
