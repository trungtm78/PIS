import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

/// A grey bar that stands where a value will be: a loading screen shows these and never a 0 (design.md "States"). It is not
/// animated, so a reduced-motion setting needs no special case, and it says nothing to a screen reader: the screen that owns
/// it announces "loading" once.
class SkeletonBar extends StatelessWidget {
  const SkeletonBar({this.width, this.height = MachvonSpace.space24, this.onDark = false, super.key});

  final double? width;
  final double height;

  /// Drawn on the dark command block: a lighter bar so it still reads as a placeholder.
  final bool onDark;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: SizedBox(
        width: width,
        height: height,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: onDark ? MachvonColors.menuMuted.withValues(alpha: 0.28) : MachvonColors.border,
            borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.control)),
          ),
        ),
      ),
    );
  }
}
