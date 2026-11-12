import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/components.dart';
import '../theme/typography.dart';

/// How serious a [NoticePanel] is. Each tone has its own icon, so the tone is told by a shape and words, never by colour alone.
enum NoticeTone { info, ok, warning, problem }

/// A message inside a form or a list that is about one thing and may offer one way out (design B): the outcome of a send ("Saved, it will be
/// sent when there is a connection"), the reason a file did not go up, a conflict to settle. It replaces the hand-built `Card` and
/// `BoxDecoration` boxes of the field screens. One panel is one live region, so a screen reader says it when it appears, and it never
/// takes the form away: what the person wrote stays beside it.
///
/// A [code] is the stable error code, small, selectable by the caller; [actionLabel] is a quiet button (48 high), the one thing that fixes it.
class NoticePanel extends StatelessWidget {
  const NoticePanel({
    required this.title,
    this.lines = const <String>[],
    this.tone = NoticeTone.info,
    this.icon,
    this.code,
    this.actionLabel,
    this.onAction,
    this.live = true,
    this.margin = const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
    super.key,
  });

  final String title;
  final List<String> lines;
  final NoticeTone tone;

  /// Replaces the icon of the tone.
  final IconData? icon;
  final String? code;
  final String? actionLabel;
  final VoidCallback? onAction;

  /// Announces the panel when it appears; off for a panel that is on screen from the start.
  final bool live;
  final EdgeInsetsGeometry margin;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Palette p = v2.palette;
    final MachvonV2Text text = context.v2text;
    final (Color fill, Color mark, IconData glyph) = switch (tone) {
      NoticeTone.info => (p.infoBg, p.infoFg, Icons.info_outline),
      NoticeTone.ok => (p.okBg, p.okFg, Icons.check_circle_outline),
      NoticeTone.warning => (p.soonBg, p.soonFg, Icons.warning_amber_rounded),
      NoticeTone.problem => (p.lateBg, p.lateFg, Icons.report_outlined),
    };
    return Padding(
      padding: margin,
      child: Semantics(
        container: true,
        liveRegion: live,
        child: Material(
          color: fill,
          borderRadius: BorderRadius.circular(MachvonV2Radius.control),
          child: Padding(
            padding: const EdgeInsets.all(MachvonV2Space.s12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    ExcludeSemantics(child: Icon(icon ?? glyph, size: 20, color: mark)),
                    const SizedBox(width: MachvonV2Space.s8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(title, style: text.bodyStrong.copyWith(color: mark)),
                          for (final String line in lines) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(line, style: text.body.copyWith(color: mark))),
                          if (code != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(code!, style: text.caption.copyWith(color: mark))),
                        ],
                      ),
                    ),
                  ],
                ),
                if (actionLabel != null && onAction != null) ...<Widget>[
                  const SizedBox(height: MachvonV2Space.s12),
                  OutlinedButton(onPressed: onAction, style: v2QuietButtonStyle(v2), child: Text(actionLabel!, textAlign: TextAlign.center)),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
