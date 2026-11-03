import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/offline.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../conversation_changes.dart';
import '../conversation_commands.dart';
import '../conversation_labels.dart';
import '../conversation_models.dart';
import '../conversation_rules.dart';
import 'message_tile.dart';
import 'thread_actions.dart';
import 'thread_composer.dart';

/// The most pages of messages a thread reads (the messages come oldest first, so the thread is cut only past this many).
const int messagePageSize = 50;
const int messageMaxPages = 20;

/// MOB-36: one conversation tied to the records it is about. At the top it says in words whether the conversation is with someone
/// outside or among colleagues; every message says whether it went out or is a note; the text of a message is read when asked. The
/// person can answer, leave a note, resolve, reopen and give the conversation to a colleague. All of it is online and judged by the
/// server (consent, window, account, state); a refusal is told beside the form and what was written stays. Nothing of the thread is
/// kept on the device.
Widget buildConversationThreadScreen(BuildContext context, ScreenContext screen) => ConversationThreadScreen(conversationId: screen.pathParameters['conversationId'] ?? '');

/// The conversation and its messages in one answer, from the two reads of the web screen.
Future<Object?> readThread(MachvonApiClient client, String conversationId) async {
  final Object? conversation = await client.getResourcesConversationId(id: conversationId);
  final Object? messages = await readMerged(client, 'get_resources_channel_message', query: <String, Object?>{'conversation_id': conversationId, 'limit': messagePageSize}, maxPages: messageMaxPages);
  return <String, Object?>{'conversation': conversation, 'messages': messages};
}

class ConversationThreadScreen extends StatefulWidget {
  const ConversationThreadScreen({required this.conversationId, super.key});

  final String conversationId;

  @override
  State<ConversationThreadScreen> createState() => _ConversationThreadScreenState();
}

class _ConversationThreadScreenState extends State<ConversationThreadScreen> {
  int _changed = 0;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.conv.thread.title'),
      body: DataView<ConversationThread>(
        cacheKey: 'conversations.thread.${widget.conversationId}',
        keepCopy: false,
        reloadKey: _changed,
        read: (MachvonApiClient client) => readThread(client, widget.conversationId),
        parse: parseThread,
        asOf: (ConversationThread thread) => thread.asOf,
        builder: (BuildContext context, Loaded<ConversationThread> loaded) => _ThreadBody(thread: loaded.value, onChanged: () => setState(() => _changed += 1)),
      ),
    );
  }
}

enum _Act { send, note, resolve, reopen, assign }

class _ThreadBody extends ConsumerStatefulWidget {
  const _ThreadBody({required this.thread, required this.onChanged});

  final ConversationThread thread;
  final VoidCallback onChanged;

  @override
  ConsumerState<_ThreadBody> createState() => _ThreadBodyState();
}

class _ThreadBodyState extends ConsumerState<_ThreadBody> with CommandFlow<_ThreadBody> {
  late final ConversationCommands _commands = ConversationCommands(client: ref.read(apiClientProvider), isOnline: () => deviceIsOnline(ref));
  _Act _act = _Act.send;
  Future<void> Function()? _again;
  int _sentCount = 0;
  String _sentText = '';
  int _doneCount = 0;

  /// Runs one command of the thread and keeps what it takes to send the same one again after a lost answer.
  Future<void> _command(_Act act, Future<CommandOutcome> Function(bool again) send, {String sent = '', bool again = false}) async {
    _act = act;
    _again = () => _command(act, send, sent: sent, again: true);
    await run(() => send(again), onDone: () {
      if (act == _Act.send || act == _Act.note) {
        _sentCount += 1;
        _sentText = sent;
      } else {
        _doneCount += 1;
      }
      ref.read(conversationsChangedProvider.notifier).bump();
      widget.onChanged();
    });
    // A refusal can follow a step taken by somebody else: what is shown is read again, so the screen shows what the server holds.
    final CommandOutcome? result = outcome;
    if (mounted && result is CommandRefused && refusalChangesThread(result)) widget.onChanged();
  }

  void _send(MessageDraft draft) {
    final ConversationItem conversation = widget.thread.conversation;
    final SendRequest request = SendRequest(conversationId: conversation.id, version: conversation.version, channelAccountId: conversation.channelAccountId, draft: draft);
    _command(draft.note ? _Act.note : _Act.send, (bool again) => _commands.send(request, retryAfterUnknown: again), sent: draft.text.trim());
  }

  void _move(bool reopen, String reason) {
    final ConversationItem conversation = widget.thread.conversation;
    final MoveRequest request = MoveRequest(conversationId: conversation.id, version: conversation.version, reopen: reopen, reason: reason);
    _command(reopen ? _Act.reopen : _Act.resolve, (bool again) => _commands.move(request, retryAfterUnknown: again));
  }

  void _assign(String assigneeId, String reason) {
    final ConversationItem conversation = widget.thread.conversation;
    final AssignRequest request = AssignRequest(conversationId: conversation.id, version: conversation.version, assigneeId: assigneeId, reason: reason);
    _command(_Act.assign, (bool again) => _commands.assign(request, retryAfterUnknown: again));
  }

  /// Why no command can be sent now: the device is offline, or the tenant is read-only. The reason is written beside every action.
  String? _blocked(BuildContext context, bool offline, SessionSnapshot session) {
    if (offline) return context.t('mob.conv.gate.offline');
    if (session.isReadOnly) return context.t('mob.conv.gate.readOnly');
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final ConversationThread thread = widget.thread;
    final ConversationItem conversation = thread.conversation;
    final String? blocked = _blocked(context, isOffline(ref), ref.watch(sessionProvider));
    final ExternalGate gate = externalGateOf(conversation, enabled: ref.watch(externalReplyEnabledProvider));
    final CommandOutcome? result = outcome;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        // Every part has a key: a part that appears or goes (the outcome of a command) must not hand its place, and its State, to the next one, or the words being written would be lost with it.
        _KindBanner(key: const ValueKey<String>('kind'), conversation: conversation),
        _Header(key: const ValueKey<String>('header'), conversation: conversation),
        if (conversation.links.isNotEmpty) _Links(key: const ValueKey<String>('links'), links: conversation.links),
        SectionCard(
          key: const ValueKey<String>('messages'),
          title: context.t('mob.conv.messages.title'),
          children: <Widget>[
            if (thread.messages.isEmpty) Text(context.t('mob.conv.messages.none')),
            if (thread.moreMessages) Text(context.t('mob.conv.messages.partial'), style: Theme.of(context).textTheme.bodySmall),
            for (final ThreadMessage message in thread.messages) MessageTile(key: ValueKey<String>(message.id), message: message),
          ],
        ),
        if (result != null) _OutcomeView(key: const ValueKey<String>('outcome'), outcome: result, act: _act, onSendAgain: _again),
        ThreadComposer(key: const ValueKey<String>('composer'), conversation: conversation, gate: gate, blocked: blocked, sending: sending, onSend: _send, sentCount: _sentCount, sentText: _sentText),
        if (mayResolve(conversation.status) || mayReopen(conversation.status))
          MoveAction(
            key: ValueKey<String>(mayReopen(conversation.status) ? 'reopen' : 'resolve'),
            reopen: mayReopen(conversation.status),
            blocked: blocked,
            sending: sending,
            onMove: (String reason) => _move(mayReopen(conversation.status), reason),
            doneCount: _doneCount,
          ),
        if (mayAssign(conversation.status)) AssignAction(key: const ValueKey<String>('assign'), conversation: conversation, blocked: blocked, sending: sending, onAssign: _assign, doneCount: _doneCount),
      ],
    );
  }
}

/// The first thing on the screen: whether this conversation is with someone outside or among colleagues.
class _KindBanner extends StatelessWidget {
  const _KindBanner({required this.conversation, super.key});

  final ConversationItem conversation;

  @override
  Widget build(BuildContext context) {
    final String kind = kindLabel(context, conversation);
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      color: conversation.isExternal ? null : MachvonColors.selected,
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Semantics(
          container: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              StatusPill(label: kind, warn: conversation.isExternal),
              const SizedBox(height: MachvonSpace.space8),
              Text(
                conversation.isExternal
                    ? context.t('mob.conv.banner.external', <String, Object>{'channel': channelLabel(context, conversation.channel), 'contact': conversation.contactName})
                    : context.t('mob.conv.banner.internal'),
              ),
              const SizedBox(height: MachvonSpace.space8),
              Text(context.t('mob.conv.banner.petition'), style: Theme.of(context).textTheme.bodySmall),
            ],
          ),
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.conversation, super.key});

  final ConversationItem conversation;

  @override
  Widget build(BuildContext context) {
    final String? window = conversation.windowExpiresAt;
    return SectionCard(
      title: conversation.contactName,
      children: <Widget>[
        FactLine(label: context.t('mob.conv.header.channel.label'), value: '${channelLabel(context, conversation.channel)} · ${conversation.accountName}'),
        FactLine(label: context.t('mob.conv.header.status.label'), value: statusLabel(context, conversation.status)),
        FactLine(label: context.t('mob.conv.header.assignee.label'), value: '${conversation.assigneeName ?? context.t('mob.conv.inbox.assignee.none')}${conversation.queueUnitName == null ? '' : ' · ${conversation.queueUnitName}'}'),
        if (conversation.lastInboundAt != null) FactLine(label: context.t('mob.conv.header.last.label'), value: formatMoment(conversation.lastInboundAt!)),
        if (conversation.firstResponseDueAt != null) FactLine(label: context.t('mob.conv.header.sla.label'), value: formatMoment(conversation.firstResponseDueAt!)),
        if (conversation.isExternal) Text(window == null ? context.t('mob.conv.header.window.none') : context.t('mob.conv.header.window.until', <String, Object>{'time': formatMoment(window)}), style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

class _Links extends StatelessWidget {
  const _Links({required this.links, super.key});

  final List<RecordLink> links;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: context.t('mob.conv.links.title'),
      children: <Widget>[
        for (final RecordLink link in links) _LinkRow(link: link),
      ],
    );
  }
}

class _LinkRow extends StatelessWidget {
  const _LinkRow({required this.link});

  final RecordLink link;

  @override
  Widget build(BuildContext context) {
    final String kind = linkedKindLabel(context, link.kind);
    final String detail = link.converted ? context.t('mob.conv.links.converted', <String, Object>{'kind': kind}) : kind;
    // Only a project has a screen on the phone; the screen it opens asks the server again whether the person may see it.
    if (link.kind != LinkedKind.project) {
      return Padding(padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4), child: Text(context.t('mob.conv.links.noScreen', <String, Object>{'kind': detail})));
    }
    return TappableRow(
      semanticLabel: context.t('mob.conv.links.open.aria', <String, Object>{'kind': detail}),
      onTap: () => openScreen(context, 'MOB-10', pathSuffix: '/${Uri.encodeComponent(link.id)}', stacked: true),
      child: Row(children: <Widget>[Expanded(child: Text(detail)), const ExcludeSemantics(child: Icon(Icons.chevron_right))]),
    );
  }
}

/// The outcome of the last command, in words and outside the form: a refusal never makes the form disappear, so what the person
/// wrote is still there to send again. The card is a live region.
class _OutcomeView extends StatelessWidget {
  const _OutcomeView({required this.outcome, required this.act, required this.onSendAgain, super.key});

  final CommandOutcome outcome;
  final _Act act;
  final Future<void> Function()? onSendAgain;

  @override
  Widget build(BuildContext context) {
    final CommandOutcome current = outcome;
    switch (current) {
      case CommandDone():
        return OutcomeCard(title: _doneText(context));
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.conv.result.unknown.title'),
          lines: <String>[context.t('mob.conv.result.unknown.body')],
          actionLabel: context.t('mob.conv.result.unknown.action'),
          onAction: onSendAgain == null ? null : () => onSendAgain!(),
        );
      case CommandOffline():
        return OutcomeCard(title: context.t('mob.conv.result.offline.title'), lines: <String>[context.t('mob.conv.gate.offline')]);
      case final CommandRefused refused:
        return OutcomeCard(title: problemText(context, problemOf(refused)), code: refused.code);
    }
  }

  String _doneText(BuildContext context) {
    switch (act) {
      case _Act.send:
        return context.t('mob.conv.result.send.done');
      case _Act.note:
        return context.t('mob.conv.result.note.done');
      case _Act.resolve:
        return context.t('mob.conv.result.resolve.done');
      case _Act.reopen:
        return context.t('mob.conv.result.reopen.done');
      case _Act.assign:
        return context.t('mob.conv.result.assign.done');
    }
  }
}
