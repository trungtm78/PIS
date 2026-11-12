import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/machvon_semantic.dart';
import '../theme/typography.dart';
import '../widgets/work_row.dart';

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
    this.tone,
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

  /// The semantic tone of the icon (an error is danger, a refusal warning); null is the teal of the app. The icon is always
  /// there as well, so the state is never told by colour alone.
  final MachvonTone? tone;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Palette p = context.v2.palette;
    final MachvonV2Text text = context.v2text;
    final (Color circle, Color glyph) = switch (tone) {
      null => (p.primarySoft, p.primaryStrong),
      MachvonTone.success => (p.okBg, p.okFg),
      MachvonTone.warning => (p.soonBg, p.soonFg),
      MachvonTone.danger => (p.lateBg, p.lateFg),
      MachvonTone.info || MachvonTone.neutral => (p.infoBg, p.infoFg),
    };
    final Widget content = Padding(
      padding: const EdgeInsets.all(MachvonSpace.space24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Align(
            child: ExcludeSemantics(
              child: DecoratedBox(
                decoration: BoxDecoration(color: circle, shape: BoxShape.circle),
                child: Padding(
                  padding: const EdgeInsets.all(MachvonSpace.space16),
                  child: Icon(icon, size: MachvonSpace.space32, color: glyph),
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
                Text(title, textAlign: TextAlign.center, style: text.title, textScaler: cappedScaler(context, MachvonV2Type.titleScaleCap)),
                const SizedBox(height: MachvonSpace.space8),
                Text(body, textAlign: TextAlign.center, style: text.body.copyWith(color: p.ink2)),
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

/// The skeleton of a loading screen: seven rows in the shape of a list row (a glyph, two lines, a label), announced once as "loading" and
/// not animated, so that a reduced-motion setting needs no special case. It never shows a 0 or any other figure.
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
          padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
          children: <Widget>[for (int row = 0; row < rows; row += 1) const WorkRowSkeleton()],
        ),
      ),
    );
  }
}
