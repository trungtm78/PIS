import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/offline/drafts/local_draft.dart';
import '../../read_support/navigate.dart';
import '../data/report_drafts.dart';
import '../data/submit_flow.dart';
import '../labels.dart';

/// A line of text that tells something about the draft. It is one live region, so a screen reader says it when it appears, and
/// it never hides the form: the person goes on with the draft they have.
class NoticeLine extends StatelessWidget {
  const NoticeLine({required this.text, this.icon = Icons.info_outline, this.action, this.error = false, super.key});

  final String text;
  final IconData icon;
  final Widget? action;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: MachvonSpace.space8),
      child: Semantics(
        container: true,
        liveRegion: true,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: error ? theme.colorScheme.errorContainer : MachvonColors.selected,
            borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.control)),
          ),
          child: Padding(
            padding: const EdgeInsets.all(MachvonSpace.space12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    ExcludeSemantics(child: Icon(icon, size: MachvonSpace.space20, color: error ? theme.colorScheme.onErrorContainer : theme.colorScheme.primary)),
                    const SizedBox(width: MachvonSpace.space8),
                    Expanded(child: Text(text, style: theme.textTheme.bodyMedium?.copyWith(color: error ? theme.colorScheme.onErrorContainer : MachvonColors.ink))),
                  ],
                ),
                if (action != null) action!,
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// What the person must know about the draft above its form: no connection, a tenant that is read only, the draft waiting in the
/// queue, the last refusal of the server, and what the server said while the reference figures were read.
class DraftNotices extends StatelessWidget {
  const DraftNotices({
    required this.snapshot,
    required this.status,
    required this.readOnlySession,
    required this.offline,
    required this.referenceProblem,
    this.tellsSending = false,
    super.key,
  });

  final DraftSnapshot snapshot;
  final SubmitStatus status;
  final bool readOnlySession;
  final bool offline;
  final ReportProblem? referenceProblem;

  /// The screen tells the sending itself (MOB-20), so the notices about the queue and the refusal are left to it.
  final bool tellsSending;

  @override
  Widget build(BuildContext context) {
    final LocalDraft draft = snapshot.draft;
    final String? blockedCode = status.stage == SubmitStage.rejected || status.stage == SubmitStage.conflict ? status.code : (draft.status == DraftStatus.blocked ? draft.blockedCode : null);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (offline) NoticeLine(icon: Icons.cloud_off_outlined, text: context.t('mob.rep.offline.notice.body')),
        if (readOnlySession) NoticeLine(icon: Icons.lock_outline, text: context.t('mob.rep.readOnly.notice.body')),
        if (status.isPending && !tellsSending)
          NoticeLine(
            icon: Icons.sync,
            text: context.t('mob.rep.pending.notice.body'),
            action: TextButton(
              style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
              onPressed: () => openScreen(context, 'MOB-41', stacked: true),
              child: Text(context.t('mob.rep.pending.queue.action')),
            ),
          ),
        if (blockedCode != null && !tellsSending)
          NoticeLine(
            icon: Icons.error_outline,
            error: true,
            text: '${problemMessage(context, problemOfCode(blockedCode))} ${context.t('mob.rep.problem.code.label', <String, Object>{'code': blockedCode})}',
          ),
        if (referenceProblem != null) NoticeLine(icon: Icons.warning_amber_outlined, text: problemMessage(context, referenceProblem!)),
      ],
    );
  }
}
