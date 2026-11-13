import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/glyph_square.dart';
import '../../../core/widgets/nav_row.dart' show SwitchRow;
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../conversation_changes.dart';
import '../conversation_labels.dart';
import '../conversation_models.dart';

/// The page size of the inbox and the most pages it follows.
const int conversationPageSize = 50;
const int conversationMaxPages = 4;

/// MOB-35: the conversations of the reader, in the queues of their units and assigned to them (the server decides which; the phone
/// adds none). Each row says in words whether the conversation is with someone outside or among colleagues. The names of the contacts
/// are personal data, so the list is not kept on the device: without a connection there is nothing to show but the offline state.
Widget buildConversationInboxScreen(BuildContext context, ScreenContext screen) => const ConversationInboxScreen();

class ConversationInboxScreen extends ConsumerStatefulWidget {
  const ConversationInboxScreen({super.key});

  @override
  ConsumerState<ConversationInboxScreen> createState() => _ConversationInboxScreenState();
}

class _ConversationInboxScreenState extends ConsumerState<ConversationInboxScreen> {
  ConversationStatus? _status;
  bool _mine = false;

  void _clear() => setState(() {
        _status = null;
        _mine = false;
      });

  @override
  Widget build(BuildContext context) {
    final List<String> active = <String>[
      if (_status != null) statusLabel(context, _status!),
      if (_mine) context.t('mob.conv.inbox.filterMine.label'),
    ];
    return ScreenFrame(
      title: context.t('mob.conv.inbox.title'),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _Filters(status: _status, mine: _mine, onStatus: (ConversationStatus? status) => setState(() => _status = status), onMine: (bool mine) => setState(() => _mine = mine)),
          Expanded(
            child: DataView<ConversationList>(
              cacheKey: 'conversations.inbox.${_status == null ? 'all' : statusWire(_status!)}.$_mine',
              keepCopy: false,
              reloadKey: ref.watch(conversationsChangedProvider),
              read: _read,
              parse: parseConversationList,
              asOf: (ConversationList list) => list.asOf,
              isEmpty: (ConversationList list) => list.items.isEmpty,
              activeFilters: active,
              onClearFilters: _clear,
              builder: (BuildContext context, Loaded<ConversationList> loaded) => _List(list: loaded.value),
            ),
          ),
        ],
      ),
    );
  }

  Future<Object?> _read(MachvonApiClient client) => readMerged(
        client,
        'get_resources_conversation',
        query: <String, Object?>{'limit': conversationPageSize, if (_status != null) 'status': statusWire(_status!), if (_mine) 'mine': true},
        maxPages: conversationMaxPages,
      );
}

class _Filters extends StatelessWidget {
  const _Filters({required this.status, required this.mine, required this.onStatus, required this.onMine});

  final ConversationStatus? status;
  final bool mine;
  final ValueChanged<ConversationStatus?> onStatus;
  final ValueChanged<bool> onMine;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(left: MachvonV2Space.s16, top: MachvonV2Space.s4, right: MachvonV2Space.s16),
          child: Text(context.t('mob.conv.inbox.intro'), style: context.v2text.caption),
        ),
        FilterChips<ConversationStatus?>(
          options: <ChipOption<ConversationStatus?>>[
            ChipOption<ConversationStatus?>(value: null, label: context.t('mob.conv.inbox.filterStatus.all')),
            for (final ConversationStatus value in ConversationStatus.values) ChipOption<ConversationStatus?>(value: value, label: statusLabel(context, value)),
          ],
          selected: status,
          onChanged: onStatus,
        ),
        SwitchRow(label: context.t('mob.conv.inbox.filterMine.label'), value: mine, onChanged: onMine),
      ],
    );
  }
}

class _List extends StatelessWidget {
  const _List({required this.list});

  final ConversationList list;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return ListView(
      children: <Widget>[
        for (final ConversationItem conversation in list.items) _Row(conversation: conversation),
        if (list.more)
          Padding(
            padding: const EdgeInsets.all(MachvonV2Space.s16),
            child: Text(context.t('mob.conv.inbox.more'), style: text.caption),
          ),
        Padding(
          padding: const EdgeInsets.all(MachvonV2Space.s16),
          child: Text(context.t('mob.conv.inbox.privacy'), style: text.caption),
        ),
      ],
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.conversation});

  final ConversationItem conversation;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String kind = kindLabel(context, conversation);
    final String status = statusLabel(context, conversation.status);
    final String assignee = conversation.assigneeName ?? context.t('mob.conv.inbox.assignee.none');
    final String? window = conversation.windowExpiresAt;
    return TappableRow(
      semanticLabel: context.t('mob.conv.inbox.row.aria', <String, Object>{'name': conversation.contactName, 'kind': kind, 'status': status, 'assignee': assignee}),
      onTap: () => openScreen(context, 'MOB-36', pathSuffix: '/${Uri.encodeComponent(conversation.id)}', stacked: true),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // Whether the conversation is with someone outside is told first, by the glyph and by the words of the pill beside it.
          GlyphSquare(icon: conversation.isExternal ? Icons.forum_outlined : Icons.groups_outlined, tone: conversation.isExternal ? GlyphTone.attention : GlyphTone.primary),
          const SizedBox(width: MachvonV2Space.s12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(conversation.contactName, style: text.bodyStrong),
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
                  child: Wrap(spacing: MachvonV2Space.s8, runSpacing: MachvonV2Space.s4, children: <Widget>[StatusPill(label: kind, warn: conversation.isExternal), StatusPill(label: status)]),
                ),
                Text('$assignee${conversation.queueUnitName == null ? '' : ' · ${conversation.queueUnitName}'}', style: text.caption),
                if (window != null) Text(context.t('mob.conv.inbox.window.until', <String, Object>{'time': formatMoment(window)}), style: text.caption),
                Text(context.t('mob.conv.inbox.messages.count', <String, Object>{'count': conversation.messageCount}), style: text.caption),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}
