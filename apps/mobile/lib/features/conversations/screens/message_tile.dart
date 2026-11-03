import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../read_support/moment.dart';
import '../../read_support/widgets.dart';
import '../conversation_labels.dart';
import '../conversation_models.dart';

/// One message of the thread. The text is personal data and is not in the list: it is read when the person asks for it, held in this
/// tile only, and let go when the tile is hidden or the screen is left. A note for the colleagues is set apart by its colour and by
/// its words, so it is never taken for a message that went out.
class MessageTile extends ConsumerStatefulWidget {
  const MessageTile({required this.message, super.key});

  final ThreadMessage message;

  @override
  ConsumerState<MessageTile> createState() => _MessageTileState();
}

enum _TextState { hidden, loading, shown, masked, failed }

class _MessageTileState extends ConsumerState<MessageTile> {
  _TextState _state = _TextState.hidden;
  String? _text;
  String? _failure;

  Future<void> _show() async {
    setState(() => _state = _TextState.loading);
    try {
      final String? text = parseMessageText(await ref.read(apiClientProvider).getResourcesChannelMessageId(id: widget.message.id));
      if (!mounted) return;
      setState(() {
        _text = text;
        _state = text == null ? _TextState.masked : _TextState.shown;
      });
    } on Object catch (error) {
      if (!mounted) return;
      final ProblemView problem = ProblemView.from(error, reachability: ref.read(reachabilityProvider));
      setState(() {
        _failure = problem.code;
        _state = _TextState.failed;
      });
    }
  }

  void _hide() => setState(() {
        _text = null;
        _failure = null;
        _state = _TextState.hidden;
      });

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ThreadMessage message = widget.message;
    final String direction = directionLabel(context, message.direction);
    final String when = formatMoment(message.createdAt);
    final String? delivery = message.delivery == null ? null : deliveryLabel(context, message.delivery!);
    return Semantics(
      container: true,
      label: context.t('mob.conv.messages.item.aria', <String, Object>{'direction': direction, 'time': when, 'delivery': delivery ?? ''}),
      child: Container(
        margin: const EdgeInsets.only(bottom: MachvonSpace.space8),
        padding: const EdgeInsets.all(MachvonSpace.space12),
        decoration: BoxDecoration(
          color: message.isNote ? MachvonColors.selected : null,
          border: Border.all(color: MachvonColors.border),
          borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.control)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Wrap(
              spacing: MachvonSpace.space8,
              runSpacing: MachvonSpace.space4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: <Widget>[
                Text(direction, style: theme.textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w700)),
                Text(when, style: theme.textTheme.bodySmall),
                if (delivery != null) StatusPill(label: delivery, warn: message.delivery == Delivery.failed),
              ],
            ),
            _body(context),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    switch (_state) {
      case _TextState.hidden:
        return Align(alignment: AlignmentDirectional.centerStart, child: TextButton(onPressed: _show, child: Text(context.t('mob.conv.text.show.action'))));
      case _TextState.loading:
        return Semantics(liveRegion: true, child: Text(context.t('mob.conv.text.loading.label')));
      case _TextState.shown:
        return _TextBlock(text: _text ?? '', onHide: _hide);
      case _TextState.masked:
        return _TextBlock(text: context.t('mob.conv.text.masked.label'), onHide: _hide);
      case _TextState.failed:
        return Semantics(
          liveRegion: true,
          container: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(context.t('mob.conv.text.failed.label')),
              Text(_failure ?? '', style: Theme.of(context).textTheme.bodySmall),
              TextButton(onPressed: _show, child: Text(context.t('mob.conv.text.retry.action'))),
            ],
          ),
        );
    }
  }
}

class _TextBlock extends StatelessWidget {
  const _TextBlock({required this.text, required this.onHide});

  final String text;
  final VoidCallback onHide;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4), child: Text(text)),
        TextButton(onPressed: onHide, child: Text(context.t('mob.conv.text.hide.action'))),
      ],
    );
  }
}
