import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/typography.dart';

/// A word, with an icon, on a soft fill the caller chooses from the palette: the level of an alert, a state of its life. The caller passes the
/// pair of colours of the state (`lateFg` on `lateBg`), so the contrast is the one the design measured, in both modes. The meaning is in the
/// icon and the word; the fill only backs it up. For a deadline use `DeadlineLabel`, for a business state `StatusPill`.
class TintChip extends StatelessWidget {
  const TintChip({required this.label, required this.ink, required this.fill, this.icon, this.semanticLabel, super.key});

  final String label;
  final Color ink;
  final Color fill;
  final IconData? icon;

  /// Replaces the words for a screen reader; null reads [label].
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: semanticLabel ?? label,
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(MachvonV2Radius.chip)),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s8, vertical: MachvonV2Space.s4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (icon != null) ...<Widget>[Icon(icon, size: 16, color: ink), const SizedBox(width: MachvonV2Space.s4)],
              Flexible(child: Text(label, style: context.v2text.label.copyWith(color: ink))),
            ],
          ),
        ),
      ),
    );
  }
}
