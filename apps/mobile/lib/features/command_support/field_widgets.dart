import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/machvon_semantic.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/action_bar.dart';
import '../../core/widgets/notice_panel.dart';
import '../../core/widgets/progress.dart';
import '../../core/widgets/status_pill.dart';
import '../../core/widgets/tap_target.dart';

/// A titled block of a form of the field screens (design B): a heading for a screen reader, a hairline above and the fields under it, with no
/// box around them. A form is a column of such blocks, so the screen is read by heading and the one action stays in the bar at its foot.
class FormSection extends StatelessWidget {
  const FormSection({required this.title, required this.children, this.caption, this.first = false, super.key});

  final String title;
  final List<Widget> children;

  /// One line under the heading that says what the block is for.
  final String? caption;

  /// The first block of a screen has no hairline above it.
  final bool first;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return Padding(
      padding: const EdgeInsets.only(top: MachvonV2Space.s8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (!first) Divider(height: 1, thickness: 1, color: v2.palette.line),
          Padding(
            padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s12, MachvonV2Space.s16, MachvonV2Space.s8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Semantics(header: true, child: Text(title, style: text.heading)),
                if (caption != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(caption!, style: text.caption.copyWith(color: v2.palette.ink2))),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
          ),
          const SizedBox(height: MachvonV2Space.s8),
        ],
      ),
    );
  }
}

/// The sticky bar of a field form: one primary button and at most one quiet one. While a send is on its way the button says so and is locked;
/// offline the button offers to save for later instead of "send" (a report from the field is kept on the phone and goes up when there is a
/// network), and a locked button always says why, so it is never a silent dead end.
class FieldSendBar extends StatelessWidget {
  const FieldSendBar({
    required this.label,
    required this.onSend,
    this.sending = false,
    this.offline = false,
    this.why,
    this.secondary,
    super.key,
  });

  /// The words of the primary action while the device is online ("Send report").
  final String label;

  /// Null locks the button; [why] then says what is missing.
  final VoidCallback? onSend;
  final bool sending;
  final bool offline;
  final String? why;
  final ActionBarButton? secondary;

  @override
  Widget build(BuildContext context) {
    final bool locked = onSend == null || sending;
    return ActionBar(
      primary: ActionBarButton(
        label: sending ? context.t('mob.field.sending.label') : (offline ? context.t('mob.field.save.offline.action') : label),
        icon: sending ? Icons.sync : (offline ? Icons.cloud_off_outlined : null),
        onPressed: locked ? null : onSend,
      ),
      secondary: secondary,
      why: sending ? null : why,
    );
  }
}

/// What the user can do to an item of a list that is on its way ([UploadRow], a queue row): its words and what it does.
class RowAction {
  const RowAction({required this.label, required this.onPressed});

  final String label;

  /// Null shows the action locked (another item is being sent).
  final VoidCallback? onPressed;
}

/// One item that goes to the server (a photograph, a file, a queued command): its name, its state in words and a shape, its size, the share
/// sent as a bar and as text, the reason and the stable code when it did not arrive, and the ways out (retry, cancel, resolve) as 48 high
/// buttons. One row is one semantic node, read as a sentence; the actions stay separate controls. A list of these is rows with hairlines, not boxes.
class UploadRow extends StatelessWidget {
  const UploadRow({
    required this.title,
    required this.stateLabel,
    required this.tone,
    this.size,
    this.progress,
    this.progressText,
    this.reason,
    this.code,
    this.actions = const <RowAction>[],
    this.dividerAbove = true,
    super.key,
  });

  final String title;
  final String stateLabel;
  final MachvonTone tone;
  final String? size;

  /// 0 to 1 while a transfer is on its way; null draws no bar.
  final double? progress;
  final String? progressText;
  final String? reason;
  final String? code;
  final List<RowAction> actions;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String spoken = <String>[title, stateLabel, ?size, ?progressText, ?reason, ?code].join('. ');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (dividerAbove) Divider(height: 1, thickness: 1, color: v2.palette.line),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Semantics(
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
                    if (progress != null) ...<Widget>[const SizedBox(height: MachvonV2Space.s8), ProgressMeter(value: progress!)],
                    if (progressText != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(progressText!, style: text.caption.copyWith(color: v2.palette.ink2))),
                    if (reason != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(reason!, style: text.body)),
                    if (code != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(code!, style: text.caption.copyWith(color: v2.palette.ink2))),
                  ],
                ),
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
            ],
          ),
        ),
      ],
    );
  }
}

/// The panel that says a report was kept on the phone and will go up when there is a network ("Saved, it will be sent when there is a
/// connection"), with the way to the queue. It is the receipt of an offline send: nothing is lost and nothing is sent twice.
class SavedForLaterPanel extends StatelessWidget {
  const SavedForLaterPanel({required this.onOpenQueue, super.key});

  final VoidCallback onOpenQueue;

  @override
  Widget build(BuildContext context) => NoticePanel(
        tone: NoticeTone.info,
        icon: Icons.cloud_off_outlined,
        title: context.t('mob.field.saved.offline.title'),
        lines: <String>[context.t('mob.field.saved.offline.body')],
        actionLabel: context.t('mob.field.queue.action'),
        onAction: onOpenQueue,
      );
}
