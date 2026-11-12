import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/typography.dart';

/// A label and its value on one line, with a hairline above (design B "InfoRow"): the facts of a detail screen. It draws nothing when
/// there is no value: a field that is not known is left out, not shown as "None yet", and a 0 appears only when it is really 0 (the caller
/// passes null for "not known" and "0" for zero). The label and the value are one semantic node, read "label: value".
///
/// The value takes the width it needs and the label wraps, so a long value or a large text scale never cuts either.
class InfoRow extends StatelessWidget {
  const InfoRow({required this.label, required this.value, this.divider = true, this.valueWidget, super.key});

  final String label;

  /// The value as text; null or empty hides the row.
  final String? value;

  /// A value that is not text (a status label, a button); used instead of [value] and then [value] is its spoken form.
  final Widget? valueWidget;

  /// The hairline above the row; the first row of a group turns it off.
  final bool divider;

  @override
  Widget build(BuildContext context) {
    if (value == null || value!.isEmpty) return const SizedBox.shrink();
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return Semantics(
      container: true,
      label: '$label: $value',
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(border: divider ? Border(top: BorderSide(color: v2.palette.line)) : null),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Flexible(flex: 2, child: Text(label, style: text.body.copyWith(color: v2.palette.ink2))),
              const SizedBox(width: MachvonV2Space.s16),
              Flexible(flex: 3, child: Align(alignment: Alignment.topRight, child: valueWidget ?? Text(value!, textAlign: TextAlign.end, style: text.bodyStrong))),
            ],
          ),
        ),
      ),
    );
  }
}
