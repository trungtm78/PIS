import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';

/// How a [GlyphSquare] is tinted: the primary colour for what is new, the attention colours (the soon band) for what waits for the person,
/// neutral for what is done with. It is a tint on the shape and never the only word: the row beside it says the state in words.
enum GlyphTone { primary, attention, neutral }

/// The square at the start of a row that is not a deadline (a notification, a menu entry): an icon on a soft fill, the size of a
/// `DeadlineGlyph`. It is decoration, so a screen reader skips it; the row names itself.
class GlyphSquare extends StatelessWidget {
  const GlyphSquare({required this.icon, this.tone = GlyphTone.primary, this.size = MachvonV2Size.glyph, super.key});

  final IconData icon;
  final GlyphTone tone;
  final double size;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Palette p = context.v2.palette;
    final (Color fill, Color mark) = switch (tone) {
      GlyphTone.primary => (p.primarySoft, p.primaryStrong),
      GlyphTone.attention => (p.soonBg, p.soonFg),
      GlyphTone.neutral => (p.sunken, p.ink3),
    };
    return ExcludeSemantics(
      child: SizedBox(
        width: size,
        height: size,
        child: DecoratedBox(
          decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(MachvonV2Radius.glyph)),
          child: Center(child: Icon(icon, size: size * 0.55, color: mark)),
        ),
      ),
    );
  }
}
