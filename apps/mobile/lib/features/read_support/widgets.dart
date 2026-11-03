import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

/// The frame of a screen that reads: a title bar (with the back button when the screen was opened from another) and the
/// body under it.
class ScreenFrame extends StatelessWidget {
  const ScreenFrame({required this.title, required this.body, this.actions = const <Widget>[], super.key});

  final String title;
  final Widget body;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title), actions: actions),
      body: body,
    );
  }
}

/// A titled block of a screen. The title is a heading for a screen reader, so the blocks can be walked through by heading.
class SectionCard extends StatelessWidget {
  const SectionCard({required this.title, required this.children, this.semanticLabel, super.key});

  final String title;
  final List<Widget> children;

  /// Read instead of the visible texts when the block is one fact to a screen reader.
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Semantics(
          container: true,
          label: semanticLabel,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Semantics(header: true, child: Text(title, style: theme.textTheme.titleMedium)),
              const SizedBox(height: MachvonSpace.space8),
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}

/// A label and its value on one line that wraps (no overflow at a large text scale); a screen reader says them together.
class FactLine extends StatelessWidget {
  const FactLine({required this.label, required this.value, super.key});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
      child: MergeSemantics(
        child: Wrap(
          spacing: MachvonSpace.space8,
          children: <Widget>[
            Text('$label:', style: theme.textTheme.bodySmall),
            Text(value, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }
}

/// A short status in a rounded box (a state, a priority, a kind).
class StatusPill extends StatelessWidget {
  const StatusPill({required this.label, this.warn = false, super.key});

  final String label;
  final bool warn;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: warn ? MachvonColors.selected : MachvonColors.border,
        borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.control)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space8, vertical: MachvonSpace.space4),
        child: Text(label, style: theme.textTheme.labelMedium?.copyWith(color: MachvonColors.ink)),
      ),
    );
  }
}

/// A row of a list that opens something: at least 48 logical pixels high, one tap target, read as one button.
class TappableRow extends StatelessWidget {
  const TappableRow({required this.semanticLabel, required this.onTap, required this.child, super.key});

  final String semanticLabel;
  final VoidCallback? onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: onTap != null,
      label: semanticLabel,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
            child: child,
          ),
        ),
      ),
    );
  }
}
