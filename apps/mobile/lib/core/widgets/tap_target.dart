import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

/// The one way a shared widget becomes tappable: an ink well that is at least 44 by 44 (the touch minimum of the design), with the
/// role of a button, one semantic node and, when [semanticLabel] is given, that label instead of the texts inside.
///
/// A chip, a link, a tab, a row all use it, so the minimum cannot be forgotten in one of them.
class TapTarget extends StatelessWidget {
  const TapTarget({
    required this.child,
    required this.onTap,
    this.semanticLabel,
    this.selected,
    this.minHeight = MachvonV2Size.touchMin,
    this.minWidth = MachvonV2Size.touchMin,
    this.radius = MachvonV2Radius.control,
    this.alignment = Alignment.centerLeft,
    super.key,
  });

  final Widget child;

  /// Null draws the child as it is, not tappable, still with the minimum size.
  final VoidCallback? onTap;

  /// What a screen reader says; replaces the texts inside. Null keeps them.
  final String? semanticLabel;

  /// Set for a chip or a tab: whether it is the chosen one.
  final bool? selected;

  final double minHeight;
  final double minWidth;
  final double radius;
  final AlignmentGeometry alignment;

  @override
  Widget build(BuildContext context) {
    final Widget body = ConstrainedBox(
      constraints: BoxConstraints(minHeight: minHeight, minWidth: minWidth),
      child: Align(alignment: alignment, widthFactor: 1, child: child),
    );
    return Semantics(
      container: true,
      button: onTap != null,
      enabled: onTap != null,
      selected: selected,
      label: semanticLabel,
      excludeSemantics: semanticLabel != null,
      onTap: onTap,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(radius),
          child: body,
        ),
      ),
    );
  }
}
