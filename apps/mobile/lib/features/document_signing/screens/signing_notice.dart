import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/work_row.dart';

/// How a message of a command reads: the tone is a colour pair of the theme (never a colour of its own), and the words carry the meaning.
enum NoticeTone { done, warning, info, problem }

/// A message about a signing command, a refusal of the signature SDK or a failed read, outside the form: a refusal never makes the screen
/// disappear, so the document stays as the server holds it and what the person typed stays to send again. It is a live region, so a
/// screen reader announces it when it appears. It is a band across the screen, not a card.
class SigningNotice extends StatelessWidget {
  const SigningNotice({required this.title, this.lines = const <String>[], this.code, this.actionLabel, this.onAction, this.tone = NoticeTone.problem, super.key});

  final String title;
  final List<String> lines;

  /// The stable error code, shown small under the sentence.
  final String? code;
  final String? actionLabel;
  final VoidCallback? onAction;
  final NoticeTone tone;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final MachvonV2Palette p = v2.palette;
    final (Color fill, Color mark) = switch (tone) {
      NoticeTone.done => (p.okBg, p.okFg),
      NoticeTone.warning => (p.soonBg, p.soonFg),
      NoticeTone.info => (p.infoBg, p.infoFg),
      NoticeTone.problem => (p.lateBg, p.lateFg),
    };
    return Semantics(
      liveRegion: true,
      container: true,
      child: ColoredBox(
        color: fill,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(title, style: text.bodyStrong.copyWith(color: mark)),
              for (final String line in lines) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(line, style: text.body.copyWith(color: mark))),
              if (code != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(code!, style: text.caption.copyWith(color: mark))),
              if (actionLabel != null && onAction != null)
                Padding(
                  padding: const EdgeInsets.only(top: MachvonV2Space.s12),
                  child: Align(alignment: Alignment.centerLeft, child: OutlinedButton(onPressed: onAction, style: v2QuietButtonStyle(v2), child: Text(actionLabel!))),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A titled block of a document screen: the title is a band that is a heading for a screen reader, and the content runs under it across the
/// width, with no box around it. [padded] puts the sides of the screen around free text; rows (`InfoRow`) carry their own.
class SigningSection extends StatelessWidget {
  const SigningSection({required this.title, required this.children, this.padded = false, super.key});

  final String title;
  final List<Widget> children;
  final bool padded;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        GroupHeader(title: title),
        if (padded)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
          )
        else
          ...children,
      ],
    );
  }
}
