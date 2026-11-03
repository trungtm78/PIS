import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

/// The card every message state is drawn on: an icon, a title, a body and what the state offers to do. It scrolls, so a
/// large text scale or a small screen never overflows, and its message is one live region, so TalkBack and VoiceOver
/// announce it when it appears.
class StateCard extends StatelessWidget {
  const StateCard({
    required this.icon,
    required this.title,
    required this.body,
    required this.announcement,
    this.details = const <Widget>[],
    this.actions = const <Widget>[],
    super.key,
  });

  final IconData icon;
  final String title;
  final String body;

  /// What a screen reader says when the card appears: the title, the body and the facts in one sentence. The visible
  /// texts are hidden from the screen reader, so it says the message once, as one live region; the buttons stay separate.
  final String announcement;

  /// Facts under the message (the error code, the reference).
  final List<Widget> details;

  /// Buttons under the facts.
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final Widget content = Padding(
      padding: const EdgeInsets.all(MachvonSpace.space24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Align(
            child: ExcludeSemantics(
              child: DecoratedBox(
                decoration: const BoxDecoration(color: MachvonColors.selected, shape: BoxShape.circle),
                child: Padding(
                  padding: const EdgeInsets.all(MachvonSpace.space16),
                  child: Icon(icon, size: MachvonSpace.space32, color: theme.colorScheme.primary),
                ),
              ),
            ),
          ),
          const SizedBox(height: MachvonSpace.space16),
          Semantics(
            container: true,
            liveRegion: true,
            label: announcement,
            excludeSemantics: true,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text(title, textAlign: TextAlign.center, style: theme.textTheme.titleLarge),
                const SizedBox(height: MachvonSpace.space8),
                Text(body, textAlign: TextAlign.center, style: theme.textTheme.bodyMedium),
                for (final Widget detail in details) ...<Widget>[const SizedBox(height: MachvonSpace.space12), detail],
              ],
            ),
          ),
          for (final Widget action in actions) ...<Widget>[const SizedBox(height: MachvonSpace.space12), action],
        ],
      ),
    );
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) => SingleChildScrollView(
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.hasBoundedHeight ? constraints.maxHeight : 0),
          child: Center(child: content),
        ),
      ),
    );
  }
}

/// The skeleton of a loading screen: seven bars as in the web, announced once as "loading" and not animated, so that a
/// reduced-motion setting needs no special case.
class LoadingView extends StatelessWidget {
  const LoadingView({required this.label, super.key});

  final String label;
  static const int rows = 7;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      liveRegion: true,
      label: label,
      child: ExcludeSemantics(
        child: ListView(
          physics: const NeverScrollableScrollPhysics(),
          padding: const EdgeInsets.all(MachvonSpace.space16),
          children: <Widget>[
            for (int row = 0; row < rows; row += 1)
              const Padding(
                padding: EdgeInsets.only(bottom: MachvonSpace.space12),
                child: SizedBox(
                  height: MachvonSpace.space24,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: MachvonColors.border,
                      borderRadius: BorderRadius.all(Radius.circular(MachvonRadius.control)),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
