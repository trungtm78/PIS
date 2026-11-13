import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';

/// One sentence under the title of a step that says what the step is for: body text in the secondary ink, inset like the fields under it.
class StepNote extends StatelessWidget {
  const StepNote(this.text, {this.small = false, super.key});

  final String text;

  /// A caption under a block (the CTMTQG note, where a figure comes from) instead of a sentence of the step.
  final bool small;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text type = context.v2text;
    return Padding(
      padding: EdgeInsets.fromLTRB(MachvonV2Space.s16, small ? MachvonV2Space.s4 : MachvonV2Space.s12, MachvonV2Space.s16, MachvonV2Space.s4),
      child: Text(text, style: (small ? type.caption : type.body).copyWith(color: v2.palette.ink2)),
    );
  }
}

/// The heading of a block of a step, under a hairline: one heading for a screen reader, with the facts (`InfoRow`) and the fields of the block
/// under it. The first block of a screen has no hairline above it.
class StepHeading extends StatelessWidget {
  const StepHeading(this.title, {this.first = false, super.key});

  final String title;
  final bool first;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (!first) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Divider(height: 1, thickness: 1, color: v2.palette.line)),
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s12, MachvonV2Space.s16, MachvonV2Space.s4),
          child: Semantics(container: true, header: true, child: Text(title, style: context.v2text.heading)),
        ),
      ],
    );
  }
}

/// A column of fields inset by the margin of the screen, for a step whose fields are not under a [FormSection] heading.
class StepFields extends StatelessWidget {
  const StepFields({required this.children, super.key});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
      );
}
