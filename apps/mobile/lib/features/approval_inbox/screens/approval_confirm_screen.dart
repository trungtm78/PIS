import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../approval_commands.dart';
import '../approval_models.dart';
import '../approval_support.dart';
import '../decision_flow.dart';
import 'approval_detail_screen.dart';

/// MOB-25: the confirmation of an approval. One button, pressed on purpose: there is no swipe and no one-tap path from a list or
/// from a push. The server demands a second factor for an approval (`approval.decide` needs `aal2`); when the person has not
/// passed one recently it refuses with `MFA_REQUIRED`, the decision is not recorded, the session takes the person through the
/// check (MOB-03), and the decision is sent again, under a new key, only when the person confirms again. There is no digital
/// signature in this release. Offline, or on a copy of the task, the button is disabled and says why; nothing is queued.
Widget buildApprovalConfirmScreen(BuildContext context, ScreenContext screen) => ApprovalConfirmScreen(taskId: screen.pathParameters['taskId'] ?? '');

class ApprovalConfirmScreen extends ConsumerWidget {
  const ApprovalConfirmScreen({required this.taskId, super.key});

  final String taskId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ScreenFrame(
      title: context.t('mob.apv.confirm.title'),
      body: DataView<ApprovalDetail>(
        cacheKey: 'approvals.task.$taskId',
        read: (MachvonApiClient client) => readApprovalDetail(client, taskId, withRecord: false),
        parse: parseApprovalDetail,
        builder: (BuildContext context, Loaded<ApprovalDetail> loaded) => _ConfirmForm(task: loaded.value.task, fromCopy: loaded.fromCache),
      ),
    );
  }
}

class _ConfirmForm extends ConsumerStatefulWidget {
  const _ConfirmForm({required this.task, required this.fromCopy});

  final ApprovalTask task;
  final bool fromCopy;

  @override
  ConsumerState<_ConfirmForm> createState() => _ConfirmFormState();
}

class _ConfirmFormState extends ConsumerState<_ConfirmForm> with DecisionFlow<_ConfirmForm> {
  final TextEditingController _comment = TextEditingController();

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  DecisionRequest get _request => DecisionRequest(taskId: widget.task.id, version: widget.task.version, kind: DecisionKind.approve, comment: _comment.text);

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final SessionSnapshot session = ref.watch(sessionProvider);
    final DecisionGate gate = gateOf(task: widget.task, offline: isOffline(ref), fromCopy: widget.fromCopy, session: session);
    final DecisionOutcome? result = outcome;
    final bool done = result is Decided;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        if (result != null) OutcomeCard(outcome: result, onSendAgain: sendAgain),
        if (!done) ...<Widget>[
          SectionCard(
            title: context.t('mob.apv.confirm.summary', <String, Object>{'type': businessTypeLabel(context, widget.task.businessType), 'step': widget.task.stepName}),
            children: <Widget>[
              TextField(
                controller: _comment,
                maxLines: 4,
                maxLength: 2000,
                readOnly: sending,
                decoration: InputDecoration(labelText: context.t('mob.apv.confirm.comment.label')),
              ),
              Text(context.t('mob.apv.confirm.stepUp.note'), style: theme.textTheme.bodySmall),
              const SizedBox(height: MachvonSpace.space4),
              Text(context.t('mob.apv.confirm.signature.note'), style: theme.textTheme.bodySmall),
              Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () => openScreen(context, 'MOB-67'), child: Text(context.t('mob.apv.confirm.signature.action')))),
            ],
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (gate != DecisionGate.open)
                  Semantics(liveRegion: true, child: Padding(padding: const EdgeInsets.only(bottom: MachvonSpace.space8), child: Text(gateText(context, gate)))),
                FilledButton(
                  onPressed: gate == DecisionGate.open && !sending ? () => submit(_request) : null,
                  child: Text(sending ? context.t('mob.apv.confirm.sending.label') : context.t('mob.apv.confirm.submit.action')),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}
