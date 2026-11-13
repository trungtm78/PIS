import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/connectivity/reachability.dart';
import '../../core/di/providers.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';
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
/// the person wrote is still there to send again. The announcement is a live region. [onDone] runs from "back to the approvals" (a sheet
/// closes itself there) and [onReopen] from "open the record again" after a version conflict (the task moved meanwhile: the screen reads it
/// again and the next decision goes out under the new version and a new key).
class OutcomeNotice extends StatelessWidget {
  const OutcomeNotice({required this.outcome, required this.onSendAgain, this.onDone, this.onReopen, super.key});

  final DecisionOutcome outcome;
  final VoidCallback onSendAgain;
  final VoidCallback? onDone;
  final VoidCallback? onReopen;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final DecisionOutcome result = outcome;
    final (IconData, Color) mark = switch (result) {
      Decided() => (Icons.check_circle_outline, v2.palette.okFg),
      ResultUnknown() => (Icons.help_outline, v2.palette.soonFg),
      DeviceOffline() => (Icons.cloud_off_outlined, v2.palette.infoFg),
      Refused() => (Icons.report_outlined, v2.palette.lateFg),
    };
    final List<Widget> children;
    switch (result) {
      case Decided():
        children = <Widget>[
          Text(context.t('mob.apv.result.done.title'), style: text.heading),
          Text(context.t('mob.apv.result.done.body'), style: text.body),
          const SizedBox(height: MachvonV2Space.s12),
          FilledButton(
            onPressed: () {
              onDone?.call();
              openScreen(context, 'MOB-23');
            },
            child: Text(context.t('mob.apv.result.back.action')),
          ),
        ];
      case ResultUnknown():
        children = <Widget>[
          Text(context.t('mob.apv.result.unknown.title'), style: text.heading),
          Text(context.t('mob.apv.result.unknown.body'), style: text.body),
          const SizedBox(height: MachvonV2Space.s12),
          OutlinedButton(onPressed: onSendAgain, child: Text(context.t('mob.apv.result.unknown.action'))),
        ];
      case DeviceOffline():
        children = <Widget>[Text(gateText(context, DecisionGate.offline), style: text.body)];
      case Refused():
        children = <Widget>[
          Text(problemText(context, problemOf(result.code)), style: text.bodyStrong.copyWith(color: v2.palette.lateFg)),
          if (result.reassigned) Text(context.t('mob.apv.problem.selfApproval.reassigned'), style: text.body),
          Text(result.code, style: text.caption),
          if (problemOf(result.code) == DecisionProblem.versionConflict && onReopen != null) ...<Widget>[
            const SizedBox(height: MachvonV2Space.s12),
            OutlinedButton(onPressed: onReopen, child: Text(context.t('mob.apv.result.reopen.action'))),
          ],
        ];
    }
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
      child: Semantics(
        liveRegion: true,
        container: true,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            ExcludeSemantics(child: Icon(mark.$1, size: 24, color: mark.$2)),
            const SizedBox(width: MachvonV2Space.s12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children)),
          ],
        ),
      ),
    );
  }
}
