import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/typography.dart';

/// A label and its value on one line, with a hairline above (design B "InfoRow"): the facts of a detail screen. It draws nothing when
/// there is no value: a field that is not known is left out, not shown as "None yet", and a 0 appears only when it is really 0 (the caller
/// passes null for "not known" and "0" for zero). The label and the value are one semantic node, read "label: value".
///
/// The label has two fifths of the row and the value three; a label that needs a little more (a few words such as "Tổng mức đầu tư") takes up to 55 percent
/// before it wraps, so it is not broken in two beside a short value. Both wrap, and every value ends at the edge of the row: the values of a group line up on
/// the right whatever their length, and a long value or a large text scale never cuts either.
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
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints constraints) {
              // The room of the two columns, without the gap between them. Unbounded (a row measured for its intrinsic size) falls back to the fixed two to three split.
              final double room = constraints.maxWidth.isFinite ? constraints.maxWidth - MachvonV2Space.s16 : double.nan;
              final Widget labelText = Text(label, style: text.body.copyWith(color: v2.palette.ink2));
              // The value column always ends at the edge of the row, so the values of a group line up on the right whatever their length.
              final Widget valueBox = Align(alignment: Alignment.topRight, child: valueWidget ?? Text(value!, textAlign: TextAlign.end, style: text.bodyStrong));
              return Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  if (room.isNaN || room <= 0) Expanded(flex: 2, child: labelText) else ConstrainedBox(constraints: BoxConstraints(minWidth: room * 0.4, maxWidth: room * 0.55), child: labelText),
                  const SizedBox(width: MachvonV2Space.s16),
                  if (room.isNaN || room <= 0) Expanded(flex: 3, child: valueBox) else Expanded(child: valueBox),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}
