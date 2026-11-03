import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/state/screen_state.dart';
import '../../command_support/command_flow.dart' show GateNote;
import '../../read_support/widgets.dart';
import '../conversation_labels.dart';
import '../conversation_models.dart';
import '../conversation_rules.dart';

/// Resolve or reopen: one button that opens a form for the reason (10 to 2000 characters, the rule of the web). Which of the two is
/// offered follows the state of the conversation; the form starts over when the state changes, so a confirmation is never given
/// to the opposite action.
class MoveAction extends StatefulWidget {
  const MoveAction({required this.reopen, required this.blocked, required this.sending, required this.onMove, required this.doneCount, super.key});

  final bool reopen;
  final String? blocked;
  final bool sending;
  final void Function(String reason) onMove;

  /// How many commands were recorded: the form closes when it grows.
  final int doneCount;

  @override
  State<MoveAction> createState() => _MoveActionState();
}

class _MoveActionState extends State<MoveAction> {
  final TextEditingController _reason = TextEditingController();
  bool _asking = false;
  bool _invalid = false;

  @override
  void didUpdateWidget(MoveAction oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.doneCount != oldWidget.doneCount) {
      _asking = false;
      _reason.clear();
    }
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  void _confirm() {
    final bool problem = moveReasonProblem(_reason.text);
    setState(() => _invalid = problem);
    if (!problem && !widget.sending && widget.blocked == null) widget.onMove(_reason.text);
  }

  @override
  Widget build(BuildContext context) {
    final String label = widget.reopen ? context.t('mob.conv.reopen.action') : context.t('mob.conv.resolve.action');
    return SectionCard(
      title: label,
      children: <Widget>[
        if (!_asking)
          OutlinedButton(onPressed: widget.blocked == null ? () => setState(() => _asking = true) : null, child: Text(label))
        else ...<Widget>[
          TextField(
            controller: _reason,
            maxLines: 3,
            readOnly: widget.sending,
            decoration: InputDecoration(labelText: context.t('mob.conv.move.reason.label'), errorText: _invalid ? context.t('mob.conv.move.reason.invalid') : null),
          ),
          const SizedBox(height: MachvonSpace.space12),
          FilledButton(onPressed: widget.sending ? null : _confirm, child: Text(context.t('mob.conv.move.confirm.action', <String, Object>{'action': label}))),
          TextButton(onPressed: widget.sending ? null : () => setState(() => _asking = false), child: Text(context.t('mob.conv.move.cancel.action'))),
        ],
        if (widget.blocked != null) GateNote(text: widget.blocked!),
      ],
    );
  }
}

/// Give the conversation to a colleague who may answer in its queue. The list of colleagues is read when the form is opened; a
/// person who may not assign is told so by the server's refusal, and nothing is shown that they could not use.
class AssignAction extends ConsumerStatefulWidget {
  const AssignAction({required this.conversation, required this.blocked, required this.sending, required this.onAssign, required this.doneCount, super.key});

  final ConversationItem conversation;
  final String? blocked;
  final bool sending;
  final void Function(String assigneeId, String reason) onAssign;
  final int doneCount;

  @override
  ConsumerState<AssignAction> createState() => _AssignActionState();
}

class _AssignActionState extends ConsumerState<AssignAction> {
  final TextEditingController _reason = TextEditingController();
  bool _asking = false;
  bool _loading = false;
  ConversationProblem? _readProblem;
  List<Assignee> _assignees = const <Assignee>[];
  String? _chosen;
  bool _missing = false;
  bool _long = false;

  @override
  void didUpdateWidget(AssignAction oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.doneCount != oldWidget.doneCount) {
      _asking = false;
      _chosen = null;
      _reason.clear();
    }
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _open() async {
    setState(() {
      _asking = true;
      _loading = true;
      _readProblem = null;
    });
    try {
      final List<Assignee> assignees = parseAssignees(await ref.read(apiClientProvider).listConversationAssignees(conversationId: widget.conversation.id));
      if (!mounted) return;
      setState(() {
        _assignees = assignees;
        _loading = false;
      });
    } on Object catch (error) {
      if (!mounted) return;
      final ProblemView problem = ProblemView.from(error, reachability: ref.read(reachabilityProvider));
      setState(() {
        _readProblem = problem.state == ScreenState.denied ? ConversationProblem.denied : ConversationProblem.general;
        _loading = false;
      });
    }
  }

  void _confirm() {
    final bool missing = _chosen == null;
    final bool long = assignReasonProblem(_reason.text);
    setState(() {
      _missing = missing;
      _long = long;
    });
    if (!missing && !long && !widget.sending && widget.blocked == null) widget.onAssign(_chosen!, _reason.text);
  }

  @override
  Widget build(BuildContext context) {
    final String label = context.t('mob.conv.assign.action');
    return SectionCard(
      title: label,
      children: <Widget>[
        if (!_asking)
          OutlinedButton(onPressed: widget.blocked == null ? _open : null, child: Text(label))
        else ...<Widget>[
          if (_loading) Semantics(liveRegion: true, child: Text(context.t('mob.conv.assign.loading.label'))),
          if (_readProblem != null) Semantics(liveRegion: true, child: Text(problemText(context, _readProblem!))),
          if (!_loading && _readProblem == null && _assignees.isEmpty) Semantics(liveRegion: true, child: Text(context.t('mob.conv.assign.none.label'))),
          if (_assignees.isNotEmpty) ...<Widget>[
            DropdownButtonFormField<String>(
              initialValue: _chosen,
              isExpanded: true,
              decoration: InputDecoration(labelText: context.t('mob.conv.assign.member.label'), errorText: _missing ? context.t('mob.conv.assign.member.invalid') : null),
              items: <DropdownMenuItem<String>>[for (final Assignee person in _assignees) DropdownMenuItem<String>(value: person.membershipId, child: Text(person.displayName))],
              onChanged: widget.sending ? null : (String? value) => setState(() => _chosen = value),
            ),
            const SizedBox(height: MachvonSpace.space12),
            TextField(
              controller: _reason,
              maxLines: 3,
              readOnly: widget.sending,
              decoration: InputDecoration(labelText: context.t('mob.conv.assign.reason.label'), errorText: _long ? context.t('mob.conv.assign.reason.invalid', <String, Object>{'max': assignReasonMax}) : null),
            ),
            const SizedBox(height: MachvonSpace.space12),
            FilledButton(onPressed: widget.sending ? null : _confirm, child: Text(context.t('mob.conv.assign.confirm.action'))),
          ],
          TextButton(onPressed: widget.sending ? null : () => setState(() => _asking = false), child: Text(context.t('mob.conv.move.cancel.action'))),
        ],
        if (widget.blocked != null) GateNote(text: widget.blocked!),
      ],
    );
  }
}
