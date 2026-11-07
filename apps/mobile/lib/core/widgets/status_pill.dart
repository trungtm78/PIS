import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/machvon_semantic.dart';

/// A short status in a rounded box (a state, a priority, a kind): one of the five semantic tones, always an icon and a text, so
/// the state is never told by colour alone.
///
/// `warn: true` is the older way to say [MachvonTone.warning]; with neither, the pill is neutral. The text wraps at a large text
/// scale instead of clipping.
class StatusPill extends StatelessWidget {
  const StatusPill({required this.label, this.tone, this.warn = false, this.icon, super.key});

  final String label;
  final MachvonTone? tone;
  final bool warn;

  /// Replaces the icon of the tone.
  final IconData? icon;

  MachvonTone get _tone => tone ?? (warn ? MachvonTone.warning : MachvonTone.neutral);

  @override
  Widget build(BuildContext context) {
    final MachvonSemantic semantic = context.semantic;
    final MachvonTone resolved = _tone;
    final Color strong = semantic.onSoft(resolved);
    final TextStyle? style = Theme.of(context).textTheme.labelMedium?.copyWith(color: strong);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: semantic.soft(resolved),
        borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.pill)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space8, vertical: MachvonSpace.space4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            ExcludeSemantics(
              child: Padding(
                padding: const EdgeInsets.only(top: 1),
                child: Icon(icon ?? semantic.icon(resolved), size: 14, color: strong),
              ),
            ),
            const SizedBox(width: MachvonSpace.space4),
            Flexible(child: Text(label, style: style)),
          ],
        ),
      ),
    );
  }
}
