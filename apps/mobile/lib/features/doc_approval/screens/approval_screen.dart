import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../document_signing/screens/signing_screen.dart';
import '../../document_signing/signing_commands.dart' show SigningProblem, isRetryable, problemOf;
import '../../document_signing/signing_models.dart';
import '../../document_signing/signing_support.dart' show isOffline, problemText;
import '../../read_support/widgets.dart';
import '../return_commands.dart';

/// DOC-22: a leader approves and signs a document on the phone (ST-DOC-020, DOC 4, CXN-DOC-07). It is the signing view of MOB-67 (the
/// documents that wait for the leader's signature, the final PDF, the comparison with the version before it, the way of signing and the
/// confirmation with the one-time code of the remote certificate authority), with what the web DOC-22 adds: the document can be given
/// back to its drafter with a reason. Signing and returning are online only and are never queued (a signing command in the offline
/// queue would be a signature nobody asked for); without a parameter the screen lists the documents, with `?doc=<id>` it opens one.
Widget buildApprovalScreen(BuildContext context, ScreenContext screen) {
  final String? id = screen.queryParameters['doc'];
  return id == null || id.isEmpty
      ? SigningWaitingList(screenId: 'DOC-22', title: context.t('mob.docapv.list.title'))
      : SigningDocumentView(documentId: id, title: context.t('mob.docapv.detail.title'), footer: _returnCard);
}

Widget _returnCard(BuildContext context, SigningDocument document, {required bool fromCopy, required VoidCallback onChanged}) =>
    ReturnCard(key: const ValueKey<String>('return-card'), document: document, fromCopy: fromCopy, onChanged: onChanged);

/// Why the document cannot be given back now; the reason is written beside the disabled button.
enum ReturnGate { open, offline, readOnly }

ReturnGate returnGateOf({required bool offline, required bool fromCopy, required SessionSnapshot session}) {
  if (offline || fromCopy) return ReturnGate.offline;
  if (session.isReadOnly) return ReturnGate.readOnly;
  return ReturnGate.open;
}

class ReturnCard extends ConsumerStatefulWidget {
  const ReturnCard({required this.document, required this.fromCopy, required this.onChanged, super.key});

  final SigningDocument document;
  final bool fromCopy;
  final VoidCallback onChanged;

  @override
  ConsumerState<ReturnCard> createState() => _ReturnCardState();
}

class _ReturnCardState extends ConsumerState<ReturnCard> with CommandFlow<ReturnCard> {
  late final ReturnCommands _commands = ReturnCommands(client: ref.read(apiClientProvider), isOnline: () => deviceIsOnline(ref));
  final TextEditingController _reason = TextEditingController();
  bool _open = false;
  ReasonProblem? _problem;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _send({bool again = false}) async {
    final SigningDocument document = widget.document;
    final String words = _reason.text;
    await run(() => _commands.giveBack(document.id, document.version, words, retryAfterUnknown: again), onDone: () {
      _reason.clear();
      setState(() => _open = false);
      widget.onChanged();
    });
    // A refusal leaves the document as it was on the server: read it again so that the screen shows that and not what the phone assumed.
    if (mounted && outcome is CommandRefused) widget.onChanged();
  }

  void _submit() {
    final ReasonProblem? problem = checkReason(_reason.text);
    setState(() => _problem = problem);
    if (problem == null) _send();
  }

  String _problemLine(BuildContext context, ReasonProblem problem) {
    switch (problem) {
      case ReasonProblem.required:
        return context.t('mob.docapv.return.reason.required');
      case ReasonProblem.tooShort:
        return context.t('mob.docapv.return.reason.tooShort');
      case ReasonProblem.tooLong:
        return context.t('mob.docapv.return.reason.tooLong');
    }
  }

  Widget _outcome(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return OutcomeCard(title: context.t('mob.docapv.return.done.title'), lines: <String>[context.t('mob.docapv.return.done.body')]);
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.docapv.return.unknown.title'),
          lines: <String>[context.t('mob.docapv.return.unknown.body')],
          actionLabel: context.t('mob.docapv.return.unknown.action'),
          onAction: () => _send(again: true),
        );
      case CommandOffline():
        return OutcomeCard(title: context.t('mob.docapv.return.gate.offline'));
      case CommandRefused():
        final SigningProblem problem = problemOf(result, completing: false);
        return OutcomeCard(
          title: problemText(context, problem),
          code: result.code,
          actionLabel: isRetryable(problem) ? context.t('mob.docapv.return.retry.action') : null,
          onAction: isRetryable(problem) ? () => _send(again: true) : null,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final SigningDocument document = widget.document;
    final CommandOutcome? result = outcome;
    final bool returnable = document.isSubmitted && !document.isLeaderSigned;
    final ReturnGate gate = returnGateOf(offline: isOffline(ref), fromCopy: widget.fromCopy, session: ref.watch(sessionProvider));
    final bool ready = gate == ReturnGate.open && !sending;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (result != null) _outcome(context, result),
        if (returnable)
          SectionCard(
            title: context.t('mob.docapv.return.title'),
            children: <Widget>[
              Text(context.t('mob.docapv.return.intro'), style: Theme.of(context).textTheme.bodyMedium),
              const SizedBox(height: MachvonSpace.space8),
              if (gate == ReturnGate.offline) GateNote(text: context.t('mob.docapv.return.gate.offline')),
              if (gate == ReturnGate.readOnly) GateNote(text: context.t('mob.docapv.return.gate.readOnly')),
              if (!_open)
                OutlinedButton(onPressed: gate == ReturnGate.open ? () => setState(() => _open = true) : null, child: Text(context.t('mob.docapv.return.open')))
              else ...<Widget>[
                TextField(
                  controller: _reason,
                  readOnly: sending,
                  minLines: 3,
                  maxLines: 6,
                  textCapitalization: TextCapitalization.sentences,
                  decoration: InputDecoration(labelText: context.t('mob.docapv.return.reason.label'), errorText: _problem == null ? null : _problemLine(context, _problem!)),
                ),
                const SizedBox(height: MachvonSpace.space8),
                FilledButton(onPressed: ready ? _submit : null, child: Text(sending ? context.t('mob.docapv.return.sending') : context.t('mob.docapv.return.submit'))),
                const SizedBox(height: MachvonSpace.space8),
                TextButton(
                  onPressed: sending ? null : () => setState(() {
                    _open = false;
                    _problem = null;
                  }),
                  child: Text(context.t('mob.docapv.return.cancel')),
                ),
              ],
            ],
          ),
      ],
    );
  }
}
