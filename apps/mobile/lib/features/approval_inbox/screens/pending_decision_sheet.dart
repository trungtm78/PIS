import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/sheets.dart';
import '../approval_commands.dart';
import '../approval_support.dart';
import '../decision_flow.dart';
import '../pending_decisions.dart';
import 'approval_detail_screen.dart';
import 'decision_panels.dart';

/// Opens a record that waits for the person outside the approval engine as a sheet: what the person decides on, read in full, then the decisions its own command takes.
Future<void> showPendingDecisionSheet(BuildContext context, PendingDecision item) {
  return showActionSheet<void>(
    context,
    title: pendingKindLabel(context, item.kind),
    builder: (BuildContext sheet) => PendingDecisionPanel(item: item),
  );
}

/// The decision on a pending record. The record is read before it is decided (the project, the task, the day, the reason, who asked, the period); the buttons are the actions the item names and each calls the command of
/// the module that owns the record, so the permission, the scope, the rule that nobody approves their own request and the audit row are those of that command. Online only, never queued, never one tap.
class PendingDecisionPanel extends ConsumerStatefulWidget {
  const PendingDecisionPanel({required this.item, super.key});

  final PendingDecision item;

  @override
  ConsumerState<PendingDecisionPanel> createState() => _PendingDecisionPanelState();
}

class _PendingDecisionPanelState extends ConsumerState<PendingDecisionPanel> {
  final TextEditingController _comment = TextEditingController();
  late final PendingCommands _commands = PendingCommands(client: ref.read(apiClientProvider), isOnline: () => ref.read(reachabilityProvider) != Reachability.offline);
  DecisionOutcome? _outcome;
  PendingAction? _last;
  String? _wordsProblem;
  bool _sending = false;

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  Future<void> _submit(PendingAction action, {bool again = false}) async {
    if (_sending) return;
    final PendingWords? problem = checkPendingWords(action, _comment.text);
    if (problem != null) {
      setState(() => _wordsProblem = pendingWordsText(context, problem, action));
      return;
    }
    setState(() {
      _sending = true;
      _wordsProblem = null;
      _outcome = null;
      _last = action;
    });
    final DecisionOutcome result = await _commands.send(widget.item, action, _comment.text, retryAfterUnknown: again);
    if (!mounted) return;
    if (result is Decided) ref.read(approvalsChangedProvider.notifier).bump();
    setState(() {
      _sending = false;
      _outcome = result;
    });
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final PendingDecision item = widget.item;
    final SessionSnapshot session = ref.watch(sessionProvider);
    final DecisionOutcome? result = _outcome;
    final bool done = result is Decided;
    final bool offline = isOffline(ref);
    final DecisionGate gate = offline ? DecisionGate.offline : (session.isReadOnly ? DecisionGate.readOnly : DecisionGate.open);
    final String language = AppStrings.of(context).language;
    return Column(
      key: const ValueKey<String>('pending-decision'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (result != null)
          _PendingOutcome(outcome: result, onSendAgain: () => _submit(_last!, again: true), onDone: () => Navigator.of(context).pop()),
        if (!done) ...<Widget>[
          if (item.initiatorName != null) InfoRow(label: context.t('mob.apv.sum.row.sender'), value: item.initiatorName),
          InfoRow(label: context.t('mob.apv.sum.row.sent'), value: formatDay(item.submittedAt, language: language)),
          ApprovalSummaryView(summary: item.summary),
          const SizedBox(height: MachvonV2Space.s8),
          TextField(
            controller: _comment,
            maxLines: 4,
            maxLength: 500,
            readOnly: _sending,
            decoration: InputDecoration(labelText: item.actions.any((PendingAction one) => one.reasonRequired) ? context.t('mob.apv.pend.reason.label') : context.t('mob.apv.pend.comment.label'), errorText: _wordsProblem),
          ),
          Text(context.t('mob.apv.pend.audit'), style: text.caption),
          const SizedBox(height: MachvonV2Space.s12),
          if (gate != DecisionGate.open) GateReason(text: gateText(context, gate)),
          for (final PendingAction action in item.actions)
            Padding(
              padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
              child: action.choice == PendingChoice.approve
                  ? FilledButton(onPressed: gate == DecisionGate.open && !_sending ? () => _submit(action) : null, child: Text(_sending && _last == action ? context.t('mob.apv.confirm.sending.label') : pendingChoiceLabel(context, action.choice)))
                  : OutlinedButton(onPressed: gate == DecisionGate.open && !_sending ? () => _submit(action) : null, child: Text(pendingChoiceLabel(context, action.choice))),
            ),
        ],
      ],
    );
  }
}

/// The outcome of a send, in words: the same notice as the approval of a task, with the two refusals only the commands of PWF give.
class _PendingOutcome extends StatelessWidget {
  const _PendingOutcome({required this.outcome, required this.onSendAgain, required this.onDone});

  final DecisionOutcome outcome;
  final VoidCallback onSendAgain;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    final DecisionOutcome result = outcome;
    if (result is Refused) {
      final MachvonV2 v2 = context.v2;
      final DecisionProblem problem = pendingProblemOf(result.code);
      return Semantics(
        liveRegion: true,
        container: true,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(problemText(context, problem), style: context.v2text.bodyStrong.copyWith(color: v2.palette.lateFg)),
              Text(result.code, style: context.v2text.caption),
            ],
          ),
        ),
      );
    }
    return OutcomeNotice(outcome: result, onSendAgain: onSendAgain, onDone: onDone);
  }
}
