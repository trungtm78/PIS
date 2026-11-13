import 'dart:io';

import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/theme/colors.dart';
import '../../core/theme/machvon_semantic.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/status_pill.dart';
import '../../core/widgets/tap_target.dart';
import '../command_support/field_widgets.dart' show RowAction;

/// One photograph of a record as a row (design B): its thumbnail, its name, its state in words and a shape (preparing, ready), its size, the
/// lines that say what happened to its place and time, and the ways out (remove, retry) as 48 high controls. A row being prepared shows a
/// bar that is still moving instead of a state that looks finished. The text of the row is one semantic node read as a sentence; the
/// actions and the [footer] (the note field) stay separate controls. A list of these is rows with hairlines, not boxes.
class PhotoRow extends StatelessWidget {
  const PhotoRow({
    this.path,
    required this.title,
    required this.stateLabel,
    required this.tone,
    this.size,
    this.facts = const <String>[],
    this.busy = false,
    this.actions = const <RowAction>[],
    this.footer,
    this.dividerAbove = true,
    super.key,
  });

  /// The file shown as the thumbnail; a file that cannot be drawn shows a broken-image glyph, never an exception. Null while the photograph is
  /// being prepared: the file is not opened then, because the preparation may delete it (a refused file) and an open file cannot be deleted.
  final String? path;
  final String title;
  final String stateLabel;
  final MachvonTone tone;

  /// "152,3 KB", from `formatBytes`.
  final String? size;

  /// What the person should know about the photograph, one line each (the place and time handling, the marks drawn).
  final List<String> facts;

  /// The photograph is being prepared: a bar that is still moving.
  final bool busy;
  final List<RowAction> actions;
  final Widget? footer;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String spoken = <String>[title, stateLabel, ?size, ...facts].join('. ');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (dividerAbove) Divider(height: 1, thickness: 1, color: v2.palette.line),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  ClipRRect(
                    borderRadius: BorderRadius.circular(MachvonV2Radius.control),
                    child: SizedBox(
                      width: 64,
                      height: 64,
                      child: ColoredBox(
                        color: v2.palette.sunken,
                        child: path == null
                            ? Icon(Icons.photo_outlined, color: v2.palette.ink3)
                            : Image.file(
                                File(path!),
                                fit: BoxFit.cover,
                                excludeFromSemantics: true,
                                errorBuilder: (BuildContext _, Object _, StackTrace? _) => Icon(Icons.broken_image_outlined, color: v2.palette.ink3),
                              ),
                      ),
                    ),
                  ),
                  const SizedBox(width: MachvonV2Space.s12),
                  Expanded(
                    child: Semantics(
                      container: true,
                      label: spoken,
                      excludeSemantics: true,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(title, style: text.bodyStrong),
                          const SizedBox(height: MachvonV2Space.s4),
                          Wrap(
                            spacing: MachvonV2Space.s8,
                            runSpacing: MachvonV2Space.s4,
                            crossAxisAlignment: WrapCrossAlignment.center,
                            children: <Widget>[
                              StatusPill(label: stateLabel, tone: tone),
                              if (size != null) Text(size!, style: text.caption.copyWith(color: v2.palette.ink2)),
                            ],
                          ),
                          if (busy)
                            Padding(
                              padding: const EdgeInsets.only(top: MachvonV2Space.s8),
                              child: LinearProgressIndicator(minHeight: 4, color: v2.palette.primary, backgroundColor: v2.palette.sunken),
                            ),
                          for (final String fact in facts) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(fact, style: text.caption.copyWith(color: v2.palette.ink2))),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              if (actions.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: MachvonV2Space.s8),
                  child: Wrap(
                    spacing: MachvonV2Space.s8,
                    children: <Widget>[
                      for (final RowAction action in actions)
                        TapTarget(
                          onTap: action.onPressed,
                          semanticLabel: action.label,
                          minHeight: MachvonV2Size.actionButton,
                          alignment: Alignment.center,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s12),
                            child: Text(action.label, style: text.label.copyWith(color: action.onPressed == null ? v2.palette.ink3 : v2.palette.primaryStrong)),
                          ),
                        ),
                    ],
                  ),
                ),
              ?footer,
            ],
          ),
        ),
      ],
    );
  }
}
