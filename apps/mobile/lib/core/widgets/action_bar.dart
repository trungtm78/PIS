import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/components.dart';
import '../theme/typography.dart';

/// A button of an [ActionBar]: its words, what it does and an optional icon.
class ActionBarButton {
  const ActionBarButton({required this.label, required this.onPressed, this.icon});

  final String label;

  /// Null locks the button (the explanation is [ActionBar.why]).
  final VoidCallback? onPressed;
  final IconData? icon;
}

/// The sticky bar at the foot of a screen of one task (design B): one solid primary button and at most one quiet one, side by side, on a
/// surface with the upward shadow `e2` (the only shadow besides the sheet and the floating button). When the primary button is locked a line
/// above says why ("Approval needs a connection"), so a locked button is never a silent dead end. Buttons are 48 high.
///
/// Two buttons at most is a rule of the design, so the type takes a primary and an optional secondary and nothing else.
class ActionBar extends StatelessWidget {
  const ActionBar({required this.primary, this.secondary, this.why, super.key});

  final ActionBarButton primary;
  final ActionBarButton? secondary;

  /// Why the primary button is locked; shown only when [ActionBarButton.onPressed] of the primary is null.
  final String? why;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final bool locked = primary.onPressed == null;
    Widget content(ActionBarButton button) => Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (button.icon != null) ...<Widget>[Icon(button.icon, size: 20), const SizedBox(width: MachvonV2Space.s8)],
            Flexible(child: Text(button.label, textAlign: TextAlign.center)),
          ],
        );
    final Widget main = FilledButton(onPressed: primary.onPressed, style: v2PrimaryButtonStyle(v2), child: content(primary));
    final Widget? quiet = secondary == null ? null : OutlinedButton(onPressed: secondary!.onPressed, style: v2QuietButtonStyle(v2), child: content(secondary!));
    return DecoratedBox(
      decoration: BoxDecoration(
        color: v2.palette.surface,
        border: Border(top: BorderSide(color: v2.palette.line)),
        boxShadow: v2.e2,
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s12, MachvonV2Space.s16, MachvonV2Space.s12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              if (locked && why != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
                  child: Semantics(
                    liveRegion: true,
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Icon(Icons.info_outline, size: 16, color: v2.palette.lateFg),
                        const SizedBox(width: MachvonV2Space.s4),
                        Expanded(child: Text(why!, style: text.caption.copyWith(color: v2.palette.lateFg))),
                      ],
                    ),
                  ),
                ),
              // Two buttons share the row while the words fit; a large text scale stacks them so no word is cut.
              if (quiet == null)
                main
              else
                LayoutBuilder(
                  builder: (BuildContext context, BoxConstraints box) {
                    final bool stack = MediaQuery.textScalerOf(context).scale(1) >= MachvonV2Type.clampFreeFrom || box.maxWidth < 280;
                    return stack
                        ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: <Widget>[main, const SizedBox(height: MachvonV2Space.s8), quiet])
                        : Row(children: <Widget>[Expanded(child: quiet), const SizedBox(width: MachvonV2Space.s8), Expanded(flex: 2, child: main)]);
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The floating button of a root screen ("Report"): 56 high, 16 radius, solid primary, the upward shadow. Used once per screen.
class FloatingPill extends StatelessWidget {
  const FloatingPill({required this.icon, required this.label, required this.onPressed, super.key});

  final IconData icon;
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return Semantics(
      container: true,
      button: true,
      label: label,
      excludeSemantics: true,
      onTap: onPressed,
      child: DecoratedBox(
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(MachvonV2Radius.card), boxShadow: v2.e2),
      child: Material(
        color: v2.palette.primary,
        borderRadius: BorderRadius.circular(MachvonV2Radius.card),
        child: InkWell(
          onTap: onPressed,
          borderRadius: BorderRadius.circular(MachvonV2Radius.card),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: MachvonV2Size.fab, minWidth: MachvonV2Size.fab),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(icon, size: 22, color: v2.palette.onPrimary),
                  const SizedBox(width: MachvonV2Space.s8),
                  Flexible(child: Text(label, style: context.v2text.bodyStrong.copyWith(color: v2.palette.onPrimary))),
                ],
              ),
            ),
          ),
        ),
      ),
      ),
    );
  }
}
