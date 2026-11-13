import 'package:flutter/material.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/offline/drafts/local_draft.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/state_view.dart';
import '../../read_support/navigate.dart';
import '../data/report_drafts.dart';
import '../data/submit_flow.dart';
import '../labels.dart';

/// The strips above a draft: no connection and a tenant that is read only. Each is one live strip (a [StatusBanner]) under the context of the
/// draft, never a second line saying the same; the draft stays in view below them, because a person in the field goes on with the draft they have.
class DraftBanners extends StatelessWidget {
  const DraftBanners({required this.offline, required this.readOnlySession, super.key});

  final bool offline;
  final bool readOnlySession;

  @override
  Widget build(BuildContext context) {
    if (!offline && !readOnlySession) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (offline) StatusBanner(text: context.t('mob.rep.offline.notice.body')),
        if (readOnlySession) StatusBanner(text: context.t('mob.rep.readOnly.notice.body'), tone: BannerTone.warning, icon: Icons.lock_outline),
      ],
    );
  }
}

/// What the person must know about the draft above its form: the draft waiting in the queue, the last refusal of the server, and what the
/// server said while the reference figures were read. Each is a [NoticePanel], one live region with the stable code and the way out.
class DraftNotices extends StatelessWidget {
  const DraftNotices({
    required this.snapshot,
    required this.status,
    required this.referenceProblem,
    this.tellsSending = false,
    super.key,
  });

  final DraftSnapshot snapshot;
  final SubmitStatus status;
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
        if (status.isPending && !tellsSending)
          NoticePanel(
            title: context.t('mob.rep.pending.notice.body'),
            icon: Icons.sync,
            actionLabel: context.t('mob.rep.pending.queue.action'),
            onAction: () => openScreen(context, 'MOB-41', stacked: true),
          ),
        if (blockedCode != null && !tellsSending)
          NoticePanel(
            tone: NoticeTone.problem,
            title: problemMessage(context, problemOfCode(blockedCode)),
            code: context.t('mob.rep.problem.code.label', <String, Object>{'code': blockedCode}),
          ),
        if (referenceProblem != null) NoticePanel(tone: NoticeTone.warning, title: problemMessage(context, referenceProblem!)),
      ],
    );
  }
}
