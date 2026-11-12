import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../l10n/app_strings.dart';
import '../theme/colors.dart';
import '../theme/components.dart';
import '../theme/typography.dart';
import 'tap_target.dart';

/// What a [StateView] tells: nothing to show, something failed, no connection, no permission. Each has its own icon, so the state is told
/// by a shape and words, never by colour alone.
enum StateKind { empty, error, offline, denied }

/// A full-area state with a way out (design B "StateView"): a glyph in a circle, a title, one sentence and the action that fixes it
/// ("Try again", "Clear filters", "See upcoming tasks"). A state without an action is a dead end, so the action is part of the design: the
/// caller names it, or knowingly leaves it out. The view scrolls, so a large text scale or a short screen never overflows, and its
/// message is one live region announced once when it appears.
class StateView extends StatelessWidget {
  const StateView({
    required this.kind,
    this.title,
    this.body,
    this.icon,
    this.actionLabel,
    this.onAction,
    this.secondaryLabel,
    this.onSecondary,
    this.details = const <Widget>[],
    super.key,
  });

  final StateKind kind;

  /// Replaces the standard title of the kind ("Nothing here yet", "Cannot load the data", "You are offline", "No access").
  final String? title;

  /// Replaces the standard sentence of the kind.
  final String? body;

  /// Replaces the icon of the kind (a tick in a circle for "you are done for today").
  final IconData? icon;
  final String? actionLabel;
  final VoidCallback? onAction;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;

  /// Facts under the sentence: the filters in use, the error code.
  final List<Widget> details;

  IconData get _icon => icon ?? switch (kind) {
        StateKind.empty => Icons.inbox_outlined,
        StateKind.error => Icons.report_outlined,
        StateKind.offline => Icons.cloud_off_outlined,
        StateKind.denied => Icons.lock_outline,
      };

  // Each key is written out so the string check can see it is in use.
  String _title(BuildContext context) {
    switch (kind) {
      case StateKind.empty:
        return context.t('mob.states.empty.title');
      case StateKind.error:
        return context.t('mob.states.error.title');
      case StateKind.offline:
        return context.t('mob.states.offline.title');
      case StateKind.denied:
        return context.t('mob.states.denied.title');
    }
  }

  String _body(BuildContext context) {
    switch (kind) {
      case StateKind.empty:
        return context.t('mob.states.empty.body');
      case StateKind.error:
        return context.t('mob.states.error.body');
      case StateKind.offline:
        return context.t('mob.states.offline.body');
      case StateKind.denied:
        return context.t('mob.states.denied.body');
    }
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final MachvonV2Palette p = v2.palette;
    final (Color fill, Color mark) = switch (kind) {
      StateKind.empty => (p.okBg, p.okFg),
      StateKind.error => (p.lateBg, p.lateFg),
      StateKind.offline => (p.infoBg, p.infoFg),
      StateKind.denied => (p.soonBg, p.soonFg),
    };
    final String heading = title ?? _title(context);
    final String sentence = body ?? _body(context);
    final Widget content = Padding(
      padding: const EdgeInsets.fromLTRB(MachvonV2Space.s32, MachvonV2Space.s32, MachvonV2Space.s32, MachvonV2Space.s24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Align(
            child: ExcludeSemantics(
              child: SizedBox(
                width: MachvonV2Size.glyphEmpty,
                height: MachvonV2Size.glyphEmpty,
                child: DecoratedBox(decoration: BoxDecoration(color: fill, shape: BoxShape.circle), child: Icon(_icon, size: 32, color: mark)),
              ),
            ),
          ),
          const SizedBox(height: MachvonV2Space.s16),
          Semantics(
            container: true,
            liveRegion: true,
            label: '$heading. $sentence',
            excludeSemantics: true,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text(heading, textAlign: TextAlign.center, style: text.title, textScaler: cappedScaler(context, MachvonV2Type.titleScaleCap)),
                const SizedBox(height: MachvonV2Space.s8),
                Text(sentence, textAlign: TextAlign.center, style: text.body.copyWith(color: p.ink2)),
                for (final Widget detail in details) ...<Widget>[const SizedBox(height: MachvonV2Space.s12), detail],
              ],
            ),
          ),
          if (actionLabel != null) ...<Widget>[
            const SizedBox(height: MachvonV2Space.s24),
            FilledButton(onPressed: onAction, style: v2PrimaryButtonStyle(v2), child: Text(actionLabel!, textAlign: TextAlign.center)),
          ],
          if (secondaryLabel != null) ...<Widget>[
            const SizedBox(height: MachvonV2Space.s8),
            OutlinedButton(onPressed: onSecondary, style: v2QuietButtonStyle(v2), child: Text(secondaryLabel!, textAlign: TextAlign.center)),
          ],
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

/// The tone of a [StatusBanner].
enum BannerTone { info, warning, late }

/// The one strip above the content that tells the state of the connection or of the data (design B "StatusBanner"): a tint, an icon, the
/// sentence and, when something can be done, an action (a whole-strip tap that opens it, or a separate button). One strip says everything
/// (offline, changes waiting, a warning): there are never two strips telling one thing. It is a live region, so the change is announced.
class StatusBanner extends StatelessWidget {
  const StatusBanner({required this.text, this.tone = BannerTone.info, this.icon, this.onTap, this.actionLabel, this.onAction, super.key});

  final String text;
  final BannerTone tone;

  /// Replaces the icon of the tone.
  final IconData? icon;

  /// The whole strip opens something (shown with a chevron); the strip is then one button.
  final VoidCallback? onTap;

  /// A separate button at the end, such as "Understood".
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Palette p = v2.palette;
    final (Color fill, Color mark, IconData glyph) = switch (tone) {
      BannerTone.info => (p.infoBg, p.infoFg, Icons.cloud_off_outlined),
      BannerTone.warning => (p.soonBg, p.soonFg, Icons.warning_amber_rounded),
      BannerTone.late => (p.lateBg, p.lateFg, Icons.report_outlined),
    };
    final Widget row = Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          ExcludeSemantics(child: Icon(icon ?? glyph, size: 20, color: mark)),
          const SizedBox(width: MachvonV2Space.s8),
          Expanded(child: Text(text, style: context.v2text.captionStrong.copyWith(color: mark))),
          if (onTap != null) ExcludeSemantics(child: Icon(Icons.chevron_right, size: 20, color: mark)),
          if (actionLabel != null) TapTarget(onTap: onAction, radius: MachvonV2Radius.chip, alignment: Alignment.center, child: Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s8), child: Text(actionLabel!, style: context.v2text.label.copyWith(color: mark)))),
        ],
      ),
    );
    return Semantics(
      container: true,
      liveRegion: true,
      child: DecoratedBox(
        decoration: BoxDecoration(color: fill, border: Border(bottom: BorderSide(color: p.line))),
        child: onTap == null
            ? ConstrainedBox(constraints: const BoxConstraints(minHeight: MachvonV2Size.touchMin), child: row)
            : TapTarget(onTap: onTap, semanticLabel: text, radius: 0, child: SizedBox(width: double.infinity, child: row)),
      ),
    );
  }
}
