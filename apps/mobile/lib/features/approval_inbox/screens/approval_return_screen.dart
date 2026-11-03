import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../read_support/amounts.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/widgets.dart';
import '../approval_commands.dart';
import '../approval_models.dart';
import '../approval_support.dart';
import '../decision_flow.dart';
import 'approval_detail_screen.dart';

/// MOB-26: the return of a record for completion. The form does not send until the person has given the reasons, at least one
/// section to fix and the day the corrections are due (the same checks as the web, judged again by the server). The decision of
/// a task carries one reason, so the sections and the day travel inside it. Like an approval it is online only, needs the second
/// factor, and is never queued.
Widget buildApprovalReturnScreen(BuildContext context, ScreenContext screen) => ApprovalReturnScreen(taskId: screen.pathParameters['taskId'] ?? '');

class ApprovalReturnScreen extends ConsumerWidget {
  const ApprovalReturnScreen({required this.taskId, super.key});

  final String taskId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ScreenFrame(
      title: context.t('mob.apv.return.title'),
      body: DataView<ApprovalDetail>(
        cacheKey: 'approvals.task.$taskId',
        read: (MachvonApiClient client) => readApprovalDetail(client, taskId, withRecord: false),
        parse: parseApprovalDetail,
        builder: (BuildContext context, Loaded<ApprovalDetail> loaded) => _ReturnForm(task: loaded.value.task, fromCopy: loaded.fromCache),
      ),
    );
  }
}

class _ReturnForm extends ConsumerStatefulWidget {
  const _ReturnForm({required this.task, required this.fromCopy});

  final ApprovalTask task;
  final bool fromCopy;

  @override
  ConsumerState<_ReturnForm> createState() => _ReturnFormState();
}

class _ReturnFormState extends ConsumerState<_ReturnForm> with DecisionFlow<_ReturnForm> {
  final TextEditingController _reason = TextEditingController();
  final TextEditingController _sections = TextEditingController();
  final TextEditingController _due = TextEditingController();
  Map<String, ReturnProblem> _problems = const <String, ReturnProblem>{};

  @override
  void dispose() {
    _reason.dispose();
    _sections.dispose();
    _due.dispose();
    super.dispose();
  }

  DecisionRequest get _request => DecisionRequest(
        taskId: widget.task.id,
        version: widget.task.version,
        kind: DecisionKind.returnBack,
        comment: _reason.text,
        sections: sectionsOf(_sections.text),
        dueDay: _due.text.trim().isEmpty ? null : _due.text.trim(),
      );

  String _composed(BuildContext context) {
    final DecisionRequest request = _request;
    return ApprovalCommands.returnReason(
      request,
      sectionsLabel: context.t('mob.apv.return.compose.sections'),
      dueLabel: context.t('mob.apv.return.compose.due'),
      dueText: request.dueDay == null ? '' : asOfLabel(request.dueDay!),
    );
  }

  /// Checks the form; only a form that passes is sent.
  void _send(BuildContext context) {
    final String composed = _composed(context);
    final Map<String, ReturnProblem> problems = checkReturn(reason: _reason.text, sectionsText: _sections.text, dueDay: _due.text, composedLength: composed.runes.length);
    setState(() => _problems = problems);
    if (problems.isEmpty) submit(_request, returnText: composed);
  }

  @override
  Widget build(BuildContext context) {
    final SessionSnapshot session = ref.watch(sessionProvider);
    final DecisionGate gate = gateOf(task: widget.task, offline: isOffline(ref), fromCopy: widget.fromCopy, session: session);
    final DecisionOutcome? result = outcome;
    final bool done = result is Decided;
    String? error(String field) => _problems[field] == null ? null : returnProblemText(context, _problems[field]!);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        if (result != null) OutcomeCard(outcome: result, onSendAgain: () => submit(_request, returnText: _composed(context), retryAfterUnknown: true)),
        if (!done)
          SectionCard(
            title: businessTypeLabel(context, widget.task.businessType),
            children: <Widget>[
              TextField(controller: _reason, maxLines: 4, readOnly: sending, decoration: InputDecoration(labelText: context.t('mob.apv.return.reason.label'), errorText: error('reason'))),
              const SizedBox(height: MachvonSpace.space12),
              TextField(controller: _sections, maxLines: 5, readOnly: sending, decoration: InputDecoration(labelText: context.t('mob.apv.return.sections.label'), errorText: error('sections'))),
              const SizedBox(height: MachvonSpace.space12),
              TextField(controller: _due, keyboardType: TextInputType.datetime, readOnly: sending, decoration: InputDecoration(labelText: context.t('mob.apv.return.due.label'), errorText: error('due'))),
              const SizedBox(height: MachvonSpace.space16),
              if (gate != DecisionGate.open)
                Semantics(liveRegion: true, child: Padding(padding: const EdgeInsets.only(bottom: MachvonSpace.space8), child: Text(gateText(context, gate)))),
              FilledButton(
                onPressed: gate == DecisionGate.open && !sending ? () => _send(context) : null,
                child: Text(sending ? context.t('mob.apv.confirm.sending.label') : context.t('mob.apv.return.submit.action')),
              ),
            ],
          ),
      ],
    );
  }
}
