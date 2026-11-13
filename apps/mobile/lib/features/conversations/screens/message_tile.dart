import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/section_panel.dart';
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
    final MachvonV2Text text = context.v2text;
    final MachvonV2Palette p = context.v2.palette;
    final ThreadMessage message = widget.message;
    final String direction = directionLabel(context, message.direction);
    final String when = formatMoment(message.createdAt);
    final String? delivery = message.delivery == null ? null : deliveryLabel(context, message.delivery!);
    return Semantics(
      container: true,
      label: context.t('mob.conv.messages.item.aria', <String, Object>{'direction': direction, 'time': when, 'delivery': delivery ?? ''}),
      child: Padding(
        padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
        child: OutlinedBlock(
          fill: message.isNote ? p.primarySoft : null,
          child: Padding(
            padding: const EdgeInsets.all(MachvonV2Space.s12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Wrap(
                  spacing: MachvonV2Space.s8,
                  runSpacing: MachvonV2Space.s4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: <Widget>[
                    Text(direction, style: text.bodyStrong),
                    Text(when, style: text.caption),
                    if (delivery != null) StatusPill(label: delivery, warn: message.delivery == Delivery.failed),
                  ],
                ),
                _body(context),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    switch (_state) {
      case _TextState.hidden:
        return Align(alignment: AlignmentDirectional.centerStart, child: TextButton(onPressed: _show, child: Text(context.t('mob.conv.text.show.action'))));
      case _TextState.loading:
        return Semantics(liveRegion: true, child: Text(context.t('mob.conv.text.loading.label'), style: context.v2text.body));
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
              Text(context.t('mob.conv.text.failed.label'), style: context.v2text.body),
              Text(_failure ?? '', style: context.v2text.caption),
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
        Padding(padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4), child: Text(text, style: context.v2text.body)),
        TextButton(onPressed: onHide, child: Text(context.t('mob.conv.text.hide.action'))),
      ],
    );
  }
}
