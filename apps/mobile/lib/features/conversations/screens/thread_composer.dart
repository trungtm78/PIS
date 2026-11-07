import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../command_support/command_flow.dart';
import '../conversation_labels.dart';
import '../conversation_models.dart';
import '../conversation_rules.dart';

/// The form of the thread: a message to the person outside, or a note that never leaves the system. When the conversation is
/// internal, or the application does not offer external replies, or the conversation is not with an agent, the form is a note form
/// and says why, beside it. The switch changes the colour and the words of the form, so a note is never taken for a message.
class ThreadComposer extends StatefulWidget {
  const ThreadComposer({
    required this.conversation,
    required this.gate,
    required this.blocked,
    required this.sending,
    required this.onSend,
    required this.sentCount,
    required this.sentText,
    super.key,
  });

  final ConversationItem conversation;
  final ExternalGate gate;

  /// Why nothing at all can be sent now (offline, a read-only tenant); null when sending is possible.
  final String? blocked;
  final bool sending;
  final void Function(MessageDraft draft) onSend;

  /// How many messages were recorded and the text of the last one: the form clears itself when the text it holds was sent.
  final int sentCount;
  final String sentText;

  @override
  State<ThreadComposer> createState() => _ThreadComposerState();
}

class _ThreadComposerState extends State<ThreadComposer> {
  final TextEditingController _text = TextEditingController();
  bool _note = false;
  String _purpose = defaultPurpose;
  bool _invalid = false;

  @override
  void didUpdateWidget(ThreadComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Only the words that were sent are cleared: what the person has begun to write since stays.
    if (widget.sentCount != oldWidget.sentCount && _text.text.trim() == widget.sentText) _text.clear();
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _external => widget.gate == ExternalGate.open && !_note;

  void _submit() {
    final bool problem = textProblem(_text.text);
    setState(() => _invalid = problem);
    if (problem || widget.sending || widget.blocked != null) return;
    widget.onSend(_external ? MessageDraft.external(text: _text.text, purpose: _purpose) : MessageDraft.note(text: _text.text));
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ConversationItem conversation = widget.conversation;
    if (widget.gate == ExternalGate.closed) {
      return Padding(padding: const EdgeInsets.all(MachvonSpace.space16), child: GateNote(text: gateText(context, widget.gate)));
    }
    final String channel = channelLabel(context, conversation.channel);
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      color: _external ? null : MachvonColors.primarySoft,
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Semantics(
          container: true,
          label: _external ? context.t('mob.conv.composer.send.aria') : context.t('mob.conv.composer.note.aria'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Semantics(header: true, child: Text(_external ? context.t('mob.conv.composer.send.title') : context.t('mob.conv.composer.note.title'), style: theme.textTheme.titleMedium)),
              if (widget.gate == ExternalGate.open)
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(context.t('mob.conv.composer.note.switch')),
                  value: _note,
                  onChanged: widget.sending ? null : (bool value) => setState(() => _note = value),
                )
              else
                GateNote(text: gateText(context, widget.gate)),
              Text(
                _external ? context.t('mob.conv.composer.send.hint', <String, Object>{'contact': conversation.contactName, 'channel': channel}) : context.t('mob.conv.composer.note.hint'),
                style: theme.textTheme.bodySmall,
              ),
              if (_external) ...<Widget>[
                const SizedBox(height: MachvonSpace.space12),
                DropdownButtonFormField<String>(
                  initialValue: _purpose,
                  isExpanded: true,
                  decoration: InputDecoration(labelText: context.t('mob.conv.composer.purpose.label')),
                  items: <DropdownMenuItem<String>>[for (final String purpose in purposes) DropdownMenuItem<String>(value: purpose, child: Text(purposeLabel(context, purpose)))],
                  onChanged: widget.sending ? null : (String? value) => setState(() => _purpose = value ?? defaultPurpose),
                ),
              ],
              const SizedBox(height: MachvonSpace.space12),
              TextField(
                controller: _text,
                maxLines: 5,
                readOnly: widget.sending,
                decoration: InputDecoration(
                  labelText: context.t('mob.conv.composer.text.label'),
                  errorText: _invalid ? context.t('mob.conv.composer.text.invalid', <String, Object>{'max': messageTextMax}) : null,
                ),
              ),
              const SizedBox(height: MachvonSpace.space12),
              if (widget.blocked != null) GateNote(text: widget.blocked!),
              FilledButton(
                onPressed: widget.sending || widget.blocked != null ? null : _submit,
                child: Text(
                  widget.sending
                      ? context.t('mob.conv.composer.sending.label')
                      : _external
                          ? context.t('mob.conv.composer.send.action', <String, Object>{'contact': conversation.contactName, 'channel': channel})
                          : context.t('mob.conv.composer.note.action'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
