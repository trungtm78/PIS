import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/theme/colors.dart';
import '../../core/theme/machvon_semantic.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/tap_target.dart';

/// The square glyph at the start of a row of the field screens (a contract, a diary): an icon on a soft tile. It says nothing a screen reader
/// needs (the row has its own words), so it is left out of the semantics.
class FieldGlyph extends StatelessWidget {
  const FieldGlyph({required this.icon, this.alert = false, super.key});

  final IconData icon;

  /// Draws the tile in the colours of a state that needs the person (a conflict, a refusal).
  final bool alert;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return ExcludeSemantics(
      child: SizedBox(
        width: MachvonV2Size.glyph,
        height: MachvonV2Size.glyph,
        child: Material(
          color: alert ? v2.palette.lateBg : v2.palette.primarySoft,
          borderRadius: BorderRadius.circular(MachvonV2Radius.glyph),
          child: Icon(icon, size: 24, color: alert ? v2.palette.lateFg : v2.palette.primaryStrong),
        ),
      ),
    );
  }
}

/// One quiet action under a row: words in the link colour on a tap area 48 high, so a row can offer a second thing to do without a button.
class QuietAction extends StatelessWidget {
  const QuietAction({required this.label, required this.onTap, super.key});

  final String label;

  /// Null shows the action locked.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return TapTarget(
      onTap: onTap,
      semanticLabel: label,
      minHeight: MachvonV2Size.actionButton,
      alignment: Alignment.center,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s12),
        child: Text(label, style: context.v2text.label.copyWith(color: onTap == null ? v2.palette.ink3 : v2.palette.primaryStrong)),
      ),
    );
  }
}

/// The quiet actions of a row, aligned with its text and wrapping onto a second line when the words are long or the text is large.
class ActionLinks extends StatelessWidget {
  const ActionLinks({required this.actions, super.key});

  final List<QuietAction> actions;

  @override
  Widget build(BuildContext context) {
    if (actions.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(left: MachvonV2Space.s4, right: MachvonV2Space.s16, bottom: MachvonV2Space.s4),
      child: Wrap(runSpacing: MachvonV2Space.s4, children: actions),
    );
  }
}

/// The tone of a status pill for the state of a contract: running work is calm, a pause is a warning, an end is a problem.
MachvonTone contractTone(String status) {
  switch (status) {
    case 'ACTIVE':
      return MachvonTone.success;
    case 'SUSPENDED':
      return MachvonTone.warning;
    case 'TERMINATED':
    case 'CANCELLED':
      return MachvonTone.danger;
    default:
      return MachvonTone.neutral;
  }
}
