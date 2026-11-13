import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/sheets.dart';
import '../../read_support/navigate.dart';
import '../approval_commands.dart';
import '../approval_models.dart';
import '../approval_support.dart';
import '../decision_flow.dart';

/// How the decision panels are shown: in a bottom sheet over the detail (the way of the phone design: the facts of the decision, then the
/// button) or as the screen of MOB-25 and MOB-26 (a deep link, a push that opens the task). Both carry the same panel, so the same rules
/// hold in both: online only, never queued, never on a copy of the task, the same key for the same intention.
enum PanelHost { sheet, screen }

/// Opens the confirmation of an approval as a sheet over the detail. [onClosed] runs when the sheet is gone.
Future<void> showApprovalConfirmSheet(BuildContext context, {required ApprovalTask task, required String? unitName, required bool fromCopy}) {
  return showActionSheet<void>(
    context,
    title: context.t('mob.apv.confirm.title'),
    builder: (BuildContext sheet) => ApprovalConfirmPanel(task: task, unitName: unitName, fromCopy: fromCopy, host: PanelHost.sheet),
  );
}

/// Opens the return of a record as a sheet over the detail.
Future<void> showApprovalReturnSheet(BuildContext context, {required ApprovalTask task, required String? unitName, required bool fromCopy}) {
  return showActionSheet<void>(
    context,
    title: context.t('mob.apv.return.title'),
    builder: (BuildContext sheet) => ApprovalReturnPanel(task: task, unitName: unitName, fromCopy: fromCopy, host: PanelHost.sheet),
  );
}

/// The facts a person decides on, as rows (the kind of record, the step, the unit, the amount in full, the deadline).
class DecisionFacts extends StatelessWidget {
  const DecisionFacts({required this.task, required this.unitName, super.key});

  final ApprovalTask task;
  final String? unitName;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final MachvonV2 v2 = context.v2;
    Widget line(String label, String? value) {
      if (value == null || value.isEmpty) return const SizedBox.shrink();
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
        child: MergeSemantics(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Flexible(flex: 2, child: Text(label, style: text.body.copyWith(color: v2.palette.ink2))),
              const SizedBox(width: MachvonV2Space.s12),
              Flexible(flex: 3, child: Text(value, textAlign: TextAlign.end, style: text.bodyStrong)),
            ],
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(bottom: MachvonV2Space.s4),
          child: Text(
            context.t('mob.apv.confirm.summary', <String, Object>{'type': businessTypeLabel(context, task.businessType), 'step': task.stepName}),
            style: text.heading,
          ),
        ),
        line(context.t('mob.apv.detail.content.amount'), task.amountVnd == null ? null : moneyFullLabel(context, task.amountVnd)),
        line(context.t('mob.apv.detail.content.unit'), unitName),
        line(context.t('mob.apv.detail.content.due'), formatMoment(task.dueAt)),
      ],
    );
  }
}

class ApprovalConfirmPanel extends ConsumerStatefulWidget {
  const ApprovalConfirmPanel({required this.task, required this.unitName, required this.fromCopy, required this.host, super.key});

  final ApprovalTask task;
  final String? unitName;
  final bool fromCopy;
  final PanelHost host;

  @override
  ConsumerState<ApprovalConfirmPanel> createState() => _ApprovalConfirmPanelState();
}

/// MOB-25 and the confirmation sheet: one button, pressed on purpose: there is no swipe and no one-tap path from a list or from a push. The
/// server demands a second factor for an approval (`approval.decide` needs `aal2`); when the person has not passed one recently it refuses
/// with `MFA_REQUIRED`, the decision is not recorded, the session takes the person through the check (MOB-03), and the decision is sent
/// again, under a new key, only when the person confirms again. There is no digital signature in this release. Offline, or on a copy of the
/// task, the button is disabled and says why; nothing is queued.
class _ApprovalConfirmPanelState extends ConsumerState<ApprovalConfirmPanel> with DecisionFlow<ApprovalConfirmPanel> {
  final TextEditingController _comment = TextEditingController();

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  DecisionRequest get _request => DecisionRequest(taskId: widget.task.id, version: widget.task.version, kind: DecisionKind.approve, comment: _comment.text);

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final SessionSnapshot session = ref.watch(sessionProvider);
    final DecisionGate gate = gateOf(task: widget.task, offline: isOffline(ref), fromCopy: widget.fromCopy, session: session);
    final DecisionOutcome? result = outcome;
    final bool done = result is Decided;
    return PanelFrame(
      host: widget.host,
      children: <Widget>[
        if (result != null)
          OutcomeNotice(
            outcome: result,
            onSendAgain: sendAgain,
            onDone: widget.host == PanelHost.sheet ? () => Navigator.of(context).pop() : null,
            onReopen: () => reopenTask(context, ref, widget.task.id, widget.host),
          ),
        if (!done) ...<Widget>[
          DecisionFacts(task: widget.task, unitName: widget.unitName),
          const SizedBox(height: MachvonV2Space.s12),
          TextField(
            controller: _comment,
            maxLines: 4,
            maxLength: 2000,
            readOnly: sending,
            decoration: InputDecoration(labelText: context.t('mob.apv.confirm.comment.label')),
          ),
          Text(context.t('mob.apv.confirm.audit'), style: text.caption),
          const SizedBox(height: MachvonV2Space.s12),
          if (gate != DecisionGate.open) GateReason(text: gateText(context, gate)),
          FilledButton(
            onPressed: gate == DecisionGate.open && !sending ? () => submit(_request) : null,
            child: Text(sending ? context.t('mob.apv.confirm.sending.label') : context.t('mob.apv.confirm.submit.action'), textAlign: TextAlign.center),
          ),
          const SizedBox(height: MachvonV2Space.s8),
          OutlinedButton(onPressed: sending ? null : () => reviewRecord(context, widget.task.id), child: Text(context.t('mob.apv.confirm.review.action'), textAlign: TextAlign.center)),
          const SizedBox(height: MachvonV2Space.s16),
          Text(context.t('mob.apv.confirm.stepUp.note'), style: text.caption),
          const SizedBox(height: MachvonV2Space.s4),
          Text(context.t('mob.apv.confirm.signature.note'), style: text.caption),
          Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () => openScreen(context, 'MOB-67'), child: Text(context.t('mob.apv.confirm.signature.action')))),
        ],
      ],
    );
  }
}

class ApprovalReturnPanel extends ConsumerStatefulWidget {
  const ApprovalReturnPanel({required this.task, required this.unitName, required this.fromCopy, required this.host, super.key});

  final ApprovalTask task;
  final String? unitName;
  final bool fromCopy;
  final PanelHost host;

  @override
  ConsumerState<ApprovalReturnPanel> createState() => _ApprovalReturnPanelState();
}

/// MOB-26 and the return sheet: the return of a record for completion. The form does not send until the person has given the reasons, at
/// least one section to fix and the day the corrections are due (the same checks as the web, judged again by the server). The decision of a
/// task carries one reason, so the sections and the day travel inside it. Like an approval it is online only, needs the second factor, and
/// is never queued.
class _ApprovalReturnPanelState extends ConsumerState<ApprovalReturnPanel> with DecisionFlow<ApprovalReturnPanel> {
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
    return PanelFrame(
      host: widget.host,
      children: <Widget>[
        if (result != null)
          OutcomeNotice(
            outcome: result,
            onSendAgain: sendAgain,
            onDone: widget.host == PanelHost.sheet ? () => Navigator.of(context).pop() : null,
            onReopen: () => reopenTask(context, ref, widget.task.id, widget.host),
          ),
        if (!done) ...<Widget>[
          Padding(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s12),
            child: Text(businessTypeLabel(context, widget.task.businessType), style: context.v2text.heading),
          ),
          TextField(controller: _reason, maxLines: 4, readOnly: sending, decoration: InputDecoration(labelText: context.t('mob.apv.return.reason.label'), errorText: error('reason'))),
          const SizedBox(height: MachvonV2Space.s12),
          TextField(controller: _sections, maxLines: 5, readOnly: sending, decoration: InputDecoration(labelText: context.t('mob.apv.return.sections.label'), errorText: error('sections'))),
          const SizedBox(height: MachvonV2Space.s12),
          TextField(controller: _due, keyboardType: TextInputType.datetime, readOnly: sending, decoration: InputDecoration(labelText: context.t('mob.apv.return.due.label'), errorText: error('due'))),
          const SizedBox(height: MachvonV2Space.s16),
          if (gate != DecisionGate.open) GateReason(text: gateText(context, gate)),
          FilledButton(
            onPressed: gate == DecisionGate.open && !sending ? () => _send(context) : null,
            child: Text(sending ? context.t('mob.apv.confirm.sending.label') : context.t('mob.apv.return.submit.action'), textAlign: TextAlign.center),
          ),
          const SizedBox(height: MachvonV2Space.s8),
          OutlinedButton(onPressed: sending ? null : () => reviewRecord(context, widget.task.id), child: Text(context.t('mob.apv.confirm.review.action'), textAlign: TextAlign.center)),
        ],
      ],
    );
  }
}

/// The frame of a panel: a column that shrinks to its content in a sheet (the sheet scrolls it) and is padded as a page on a screen.
class PanelFrame extends StatelessWidget {
  const PanelFrame({required this.host, required this.children, super.key});

  final PanelHost host;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final Column column = Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: children);
    if (host == PanelHost.sheet) return column;
    return Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8), child: column);
  }
}

/// Why the decision cannot be made now, next to the disabled button, as a live region (a disabled button alone says nothing).
class GateReason extends StatelessWidget {
  const GateReason({required this.text, super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return Semantics(
      liveRegion: true,
      child: Padding(
        padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            ExcludeSemantics(child: Icon(Icons.lock_outline, size: 18, color: v2.palette.soonFg)),
            const SizedBox(width: MachvonV2Space.s8),
            Expanded(child: Text(text, style: context.v2text.captionStrong.copyWith(color: v2.palette.soonFg))),
          ],
        ),
      ),
    );
  }
}

/// "Review the record": a sheet closes over the detail it came from; the screen goes back to it (or opens it when it was opened on its own).
void reviewRecord(BuildContext context, String taskId) {
  final NavigatorState navigator = Navigator.of(context);
  if (navigator.canPop()) {
    navigator.pop();
  } else {
    openScreen(context, 'MOB-24', pathSuffix: '/${Uri.encodeComponent(taskId)}');
  }
}

/// After a version conflict: the task moved, so the detail reads it again. In a sheet the sheet closes and the detail under it follows the
/// counter of decisions; the screen opens the detail, which reads the task fresh.
void reopenTask(BuildContext context, WidgetRef ref, String taskId, PanelHost host) {
  if (host == PanelHost.sheet) {
    ref.read(approvalsChangedProvider.notifier).bump();
    Navigator.of(context).pop();
    return;
  }
  openScreen(context, 'MOB-24', pathSuffix: '/${Uri.encodeComponent(taskId)}');
}
