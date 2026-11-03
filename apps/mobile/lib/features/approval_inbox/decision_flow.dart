import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/connectivity/reachability.dart';
import '../../core/di/providers.dart';
import '../../core/l10n/app_strings.dart';
import '../read_support/navigate.dart';
import 'approval_commands.dart';
import 'approval_support.dart';

/// What the two decision screens share: the commands of the screen (so that a retry after a lost answer keeps its key), the
/// outcome of the last send, and a guard against a second tap while a decision is on its way.
mixin DecisionFlow<T extends ConsumerStatefulWidget> on ConsumerState<T> {
  late final ApprovalCommands commands = ApprovalCommands(
    client: ref.read(apiClientProvider),
    isOnline: () => ref.read(reachabilityProvider) != Reachability.offline,
  );

  DecisionOutcome? outcome;
  bool sending = false;

  /// The decision that was sent last, exactly as it left the form. The form stays editable after a lost answer, but the person asking to
  /// send again means this decision: its key is the key of its content, so a changed field would be a second decision.
  ({DecisionRequest request, String returnText})? _sent;

  /// Sends the request once. A second call while one is on its way does nothing; a success tells the inbox to read again.
  Future<void> submit(DecisionRequest request, {String returnText = '', bool retryAfterUnknown = false}) async {
    if (sending) return;
    _sent = (request: request, returnText: returnText);
    setState(() {
      sending = true;
      outcome = null;
    });
    final DecisionOutcome result = await commands.send(request, returnText: returnText, retryAfterUnknown: retryAfterUnknown);
    if (!mounted) return;
    if (result is Decided) ref.read(approvalsChangedProvider.notifier).bump();
    setState(() {
      sending = false;
      outcome = result;
    });
  }

  /// Sends the last decision again after a lost answer, unchanged: the same content under the same key and version.
  Future<void> sendAgain() async {
    final ({DecisionRequest request, String returnText})? sent = _sent;
    if (sent == null) return;
    await submit(sent.request, returnText: sent.returnText, retryAfterUnknown: true);
  }
}

/// The outcome of a send, in words, outside the form: a refusal or an unknown result never makes the form disappear, so what
/// the person wrote is still there to send again. The announcement is a live region.
class OutcomeCard extends StatelessWidget {
  const OutcomeCard({required this.outcome, required this.onSendAgain, super.key});

  final DecisionOutcome outcome;
  final VoidCallback onSendAgain;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final DecisionOutcome result = outcome;
    final List<Widget> children;
    switch (result) {
      case Decided():
        children = <Widget>[
          Text(context.t('mob.apv.result.done.title'), style: theme.textTheme.titleMedium),
          Text(context.t('mob.apv.result.done.body')),
          const SizedBox(height: MachvonSpace.space12),
          FilledButton(onPressed: () => openScreen(context, 'MOB-23'), child: Text(context.t('mob.apv.result.back.action'))),
        ];
      case ResultUnknown():
        children = <Widget>[
          Text(context.t('mob.apv.result.unknown.title'), style: theme.textTheme.titleMedium),
          Text(context.t('mob.apv.result.unknown.body')),
          const SizedBox(height: MachvonSpace.space12),
          OutlinedButton(onPressed: onSendAgain, child: Text(context.t('mob.apv.result.unknown.action'))),
        ];
      case DeviceOffline():
        children = <Widget>[Text(gateText(context, DecisionGate.offline))];
      case Refused():
        children = <Widget>[
          Text(problemText(context, problemOf(result.code))),
          if (result.reassigned) Text(context.t('mob.apv.problem.selfApproval.reassigned')),
          Text(result.code, style: theme.textTheme.bodySmall),
        ];
    }
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Semantics(liveRegion: true, container: true, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children)),
      ),
    );
  }
}
