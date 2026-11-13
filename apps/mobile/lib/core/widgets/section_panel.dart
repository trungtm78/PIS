import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/typography.dart';

/// A titled block of a screen (design B): a heading, the content under it and a hairline at the foot, on the surface of the screen. It is what
/// the card of the first design became: a block is told apart by its heading and its rule, not by a box with a shadow, so a long screen of
/// blocks stays light to scroll. The heading is a heading for a screen reader, so the blocks can be walked through by heading.
class SectionPanel extends StatelessWidget {
  const SectionPanel({required this.title, required this.children, this.trailing, this.semanticLabel, this.padded = true, super.key});

  final String title;

  /// The content; a row of a list passes `padded: false` so it can run to the edges and carry its own padding.
  final List<Widget> children;

  /// What sits at the end of the heading line (a unit chip, a link).
  final Widget? trailing;

  /// Read instead of the visible texts when the whole block is one fact to a screen reader.
  final String? semanticLabel;
  final bool padded;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final Widget heading = Semantics(container: true, header: true, child: Text(title, style: context.v2text.heading));
    return Semantics(
      container: true,
      label: semanticLabel,
      child: DecoratedBox(
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: v2.palette.line))),
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: padded ? MachvonV2Space.s16 : 0, vertical: MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Padding(
                padding: EdgeInsets.symmetric(horizontal: padded ? 0 : MachvonV2Space.s16),
                child: trailing == null
                    ? heading
                    : Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[Expanded(child: heading), const SizedBox(width: MachvonV2Space.s8), Flexible(child: trailing!)],
                      ),
              ),
              const SizedBox(height: MachvonV2Space.s8),
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}

/// A small note in a rounded chip on the sunken fill: a unit ("Unit: billion dong"), a scope. It is text only; a state is a `StatusPill` or a
/// `DeadlineLabel`, which carry a shape as well.
class NoteChip extends StatelessWidget {
  const NoteChip({required this.label, super.key});

  final String label;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return DecoratedBox(
      decoration: BoxDecoration(color: v2.palette.sunken, borderRadius: BorderRadius.circular(MachvonV2Radius.chip)),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s8, vertical: MachvonV2Space.s4),
        child: Text(label, style: context.v2text.caption),
      ),
    );
  }
}

/// A hairline across the width, inset at the start: the separator between two rows of one block.
class RowRule extends StatelessWidget {
  const RowRule({this.inset = MachvonV2Space.s16, super.key});

  final double inset;

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.only(left: inset),
        child: SizedBox(height: 1, child: ColoredBox(color: context.v2.palette.line)),
      );
}

/// A block with a thin outline and the radius of a control: a figure of the steering views that is read on its own (a unit with its colour and
/// its reason). The outline is a hairline of the design, so it does not stand for a control; it carries no shadow. A [fill] sets the block
/// apart by more than its outline (a note for colleagues, as against a message that went out).
class OutlinedBlock extends StatelessWidget {
  const OutlinedBlock({required this.child, this.fill, super.key});

  final Widget child;

  /// The colour behind the content; null leaves the surface of the screen.
  final Color? fill;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: fill,
        border: Border.all(color: context.v2.palette.line),
        borderRadius: BorderRadius.circular(MachvonV2Radius.control),
      ),
      child: child,
    );
  }
}
