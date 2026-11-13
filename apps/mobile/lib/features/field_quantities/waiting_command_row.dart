import 'package:flutter/material.dart';

import '../../core/offline/queue/offline_codes.dart';
import '../../core/offline/queue/queued_command.dart';
import '../../core/theme/machvon_semantic.dart';
import '../../core/widgets/notice_panel.dart';
import '../command_support/field_widgets.dart';
import '../offline/offline_labels.dart';

/// A record of this phone that is on its way (a quantity, a result of an inspection): where it stands in words, and when the server did not
/// take it why, with the stable code and the way to the queue, where it is sent again under the same key or settled. A command that waits for
/// a network or for the answer is a row of the list of uploads; one that was refused or came back in conflict is a panel that keeps the
/// reason and the code in view. The row is a live region, so a change of state is announced.
class WaitingCommandRow extends StatelessWidget {
  const WaitingCommandRow({
    required this.title,
    required this.command,
    required this.refusalText,
    required this.queueActionLabel,
    required this.onOpenQueue,
    this.dividerAbove = true,
    super.key,
  });

  /// What the record is ("BB-014 · 120,5").
  final String title;
  final QueuedCommand command;

  /// The words of a refusal of the server for its code (the code `RESULT_UNVERIFIABLE` is worded by the queue).
  final String Function(BuildContext context, String code) refusalText;
  final String queueActionLabel;
  final VoidCallback onOpenQueue;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final String? code = command.errorCode;
    final String? reason = command.state == CommandState.rejected && code != null && code != kResultUnverifiable ? refusalText(context, code) : reasonOf(context, command);
    final bool refused = command.state == CommandState.rejected;
    if (refused || command.state == CommandState.conflict) {
      return NoticePanel(
        tone: refused ? NoticeTone.problem : NoticeTone.warning,
        title: stateLabel(context, command.state),
        lines: <String>[title, ?reason],
        code: code,
        actionLabel: queueActionLabel,
        onAction: onOpenQueue,
      );
    }
    return Semantics(
      liveRegion: true,
      child: UploadRow(
        title: title,
        stateLabel: stateLabel(context, command.state),
        tone: command.state == CommandState.unknown ? MachvonTone.warning : MachvonTone.info,
        reason: reason,
        code: code,
        actions: <RowAction>[RowAction(label: queueActionLabel, onPressed: onOpenQueue)],
        dividerAbove: dividerAbove,
      ),
    );
  }
}
