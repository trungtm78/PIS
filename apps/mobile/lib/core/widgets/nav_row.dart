import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/typography.dart';
import 'tap_target.dart';

/// A row of a menu (design B): an icon in a square at the start, the words, what the row holds now (a language, a state) and a chevron when
/// it opens something. At least 48 high, one semantic node read as a button. The row of the account tab and of the shortcut sheet of the
/// projects are this row, so a menu looks the same wherever it is.
class NavRow extends StatelessWidget {
  const NavRow({required this.label, required this.onTap, this.icon, this.value, this.valueWidget, this.semanticLabel, this.dividerAbove = false, this.chevron = true, super.key});

  final String label;
  final IconData? icon;

  /// What the row holds now, at the end ("Vietnamese", "On").
  final String? value;

  /// A value that is not text (a status label); [value] is then its spoken form.
  final Widget? valueWidget;
  final VoidCallback? onTap;
  final String? semanticLabel;
  final bool dividerAbove;

  /// Whether the row shows the chevron of "opens another screen".
  final bool chevron;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final Widget row = Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
      child: Row(
        children: <Widget>[
          if (icon != null) ...<Widget>[
            ExcludeSemantics(
              child: SizedBox(
                width: MachvonV2Size.glyph,
                height: MachvonV2Size.glyph,
                child: DecoratedBox(
                  decoration: BoxDecoration(color: v2.palette.primarySoft, borderRadius: BorderRadius.circular(MachvonV2Radius.glyph)),
                  child: Icon(icon, size: 20, color: v2.palette.primaryStrong),
                ),
              ),
            ),
            const SizedBox(width: MachvonV2Space.s12),
          ],
          Expanded(child: Text(label, style: text.body)),
          if (valueWidget != null || value != null) ...<Widget>[
            const SizedBox(width: MachvonV2Space.s8),
            Flexible(child: valueWidget ?? Text(value!, style: text.caption, textAlign: TextAlign.end)),
          ],
          if (chevron && onTap != null) ExcludeSemantics(child: Icon(Icons.chevron_right, color: v2.palette.ink3)),
        ],
      ),
    );
    final Widget body = ConstrainedBox(constraints: const BoxConstraints(minHeight: MachvonV2Size.rowMinHeight), child: row);
    final String spoken = semanticLabel ?? (value == null ? label : '$label: $value');
    final Widget tappable = TapTarget(onTap: onTap, semanticLabel: spoken, radius: 0, child: SizedBox(width: double.infinity, child: body));
    if (!dividerAbove) return tappable;
    final double inset = icon == null ? MachvonV2Space.s16 : MachvonV2Space.s16 + MachvonV2Size.glyph + MachvonV2Space.s12;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(padding: EdgeInsets.only(left: inset), child: SizedBox(height: 1, child: ColoredBox(color: v2.palette.line))),
        tappable,
      ],
    );
  }
}

/// A row with a switch (design B): the words, one line of help under them and the switch at the end; the whole row is the switch, one node
/// that says whether it is on. [onChanged] null locks it (while its state is being read).
class SwitchRow extends StatelessWidget {
  const SwitchRow({required this.label, required this.value, required this.onChanged, this.help, this.dividerAbove = false, super.key});

  final String label;
  final String? help;
  final bool value;
  final ValueChanged<bool>? onChanged;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final Widget row = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: MachvonV2Size.rowMinHeight),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[Text(label, style: text.body), if (help != null) Text(help!, style: text.caption)],
              ),
            ),
            const SizedBox(width: MachvonV2Space.s12),
            ExcludeSemantics(child: Switch(value: value, onChanged: onChanged)),
          ],
        ),
      ),
    );
    return Semantics(
      container: true,
      toggled: value,
      enabled: onChanged != null,
      label: help == null ? label : '$label. $help',
      excludeSemantics: true,
      onTap: onChanged == null ? null : () => onChanged!(!value),
      child: DecoratedBox(
        decoration: BoxDecoration(border: dividerAbove ? Border(top: BorderSide(color: v2.palette.line)) : null),
        child: InkWell(onTap: onChanged == null ? null : () => onChanged!(!value), child: row),
      ),
    );
  }
}
