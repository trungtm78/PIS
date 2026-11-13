import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../theme/colors.dart';
import '../theme/components.dart';
import '../theme/typography.dart';

/// Opens a bottom sheet (design B): the sheet radius at the top, a handle, the upward shadow, a scrim over the screen; it scrolls when its
/// content is taller than the screen (a large text scale), keeps clear of the keyboard and the system bars, and closes on the scrim, on
/// the handle button and on the back button. The result is what the content passes to `Navigator.pop`.
Future<T?> showActionSheet<T>(BuildContext context, {required WidgetBuilder builder, String? title, bool dismissible = true}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    isDismissible: dismissible,
    enableDrag: dismissible,
    builder: (BuildContext sheet) => ActionSheet(title: title, child: builder(sheet)),
  );
}

/// The body of a sheet: the handle, an optional title (Title, 22/30) and the content, in a scroll view. Use it through [showActionSheet].
class ActionSheet extends StatelessWidget {
  const ActionSheet({required this.child, this.title, super.key});

  final Widget child;
  final String? title;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: v2.palette.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(MachvonV2Radius.sheet)),
        boxShadow: v2.e2,
      ),
      // The content keeps clear of the keyboard (the view insets) and of a bottom system area (the safe area): the last button is never behind either.
      child: SingleChildScrollView(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: SafeArea(
          top: false,
          child: Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, MachvonV2Space.s24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Center(
                child: ExcludeSemantics(
                  child: SizedBox(width: 36, height: 4, child: DecoratedBox(decoration: BoxDecoration(color: v2.palette.lineStrong, borderRadius: BorderRadius.circular(2)))),
                ),
              ),
              const SizedBox(height: MachvonV2Space.s12),
              if (title != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: MachvonV2Space.s12),
                  child: Semantics(container: true, header: true, child: Text(title!, style: context.v2text.title, textScaler: cappedScaler(context, MachvonV2Type.titleScaleCap))),
                ),
              child,
            ],
          ),
        ),
        ),
      ),
    );
  }
}

/// The content of a confirmation sheet: what will happen in a few facts (the consequence, the check of the documents), a note that the
/// decision is written to the audit log under the person's name, a solid primary button and, under it, a quiet one that leaves. The primary
/// button is a button of its own full width, so the words never break; "no" is the quiet one, so the destructive path needs a
/// deliberate tap. Used through [showConfirmSheet].
class ConfirmSheet extends StatelessWidget {
  const ConfirmSheet({
    required this.facts,
    required this.confirmLabel,
    required this.cancelLabel,
    this.auditNote,
    this.destructive = false,
    super.key,
  });

  final List<String> facts;
  final String confirmLabel;
  final String cancelLabel;

  /// "This decision is written to the audit log under your name."
  final String? auditNote;

  /// Marks the primary button with the late colours (a refusal, a deletion) instead of the primary colour.
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final ButtonStyle confirmStyle = destructive
        ? v2PrimaryButtonStyle(v2).copyWith(backgroundColor: WidgetStatePropertyAll<Color>(v2.palette.lateMark), foregroundColor: WidgetStatePropertyAll<Color>(v2.palette.onPrimary))
        : v2PrimaryButtonStyle(v2);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final String fact in facts)
          Padding(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Padding(padding: const EdgeInsets.only(top: 2), child: Icon(Icons.check_circle_outline, size: 18, color: v2.palette.primaryStrong)),
                const SizedBox(width: 10),
                Expanded(child: Text(fact, style: text.body)),
              ],
            ),
          ),
        if (auditNote != null) Padding(padding: const EdgeInsets.only(bottom: MachvonV2Space.s12), child: Text(auditNote!, style: text.caption)),
        const SizedBox(height: MachvonV2Space.s4),
        FilledButton(onPressed: () => Navigator.pop(context, true), style: confirmStyle, child: Text(confirmLabel, textAlign: TextAlign.center)),
        const SizedBox(height: MachvonV2Space.s8),
        OutlinedButton(onPressed: () => Navigator.pop(context, false), style: v2QuietButtonStyle(v2), child: Text(cancelLabel, textAlign: TextAlign.center)),
      ],
    );
  }
}

/// Asks for a decision in a [ConfirmSheet] and answers true only when the person confirmed; closing the sheet any other way is "no".
Future<bool> showConfirmSheet(
  BuildContext context, {
  required String title,
  required List<String> facts,
  required String confirmLabel,
  required String cancelLabel,
  String? auditNote,
  bool destructive = false,
}) async {
  final bool? confirmed = await showActionSheet<bool>(
    context,
    title: title,
    builder: (BuildContext sheet) => ConfirmSheet(facts: facts, confirmLabel: confirmLabel, cancelLabel: cancelLabel, auditNote: auditNote, destructive: destructive),
  );
  return confirmed ?? false;
}
