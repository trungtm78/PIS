import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';

/// A section of a detail screen that is folded until it is asked for (MOB-79): its title with the number it holds, and a chevron that says whether it is open. The
/// section is one button for a screen reader that says its title and whether it is open ("Mở Lịch sử", "Thu gọn Lịch sử"); the content is not built while it is folded, so a
/// long screen of folds stays light. The person's choice is kept while the screen is open, through a refresh of its data.
class PwfFold extends StatefulWidget {
  const PwfFold({
    required this.title,
    required this.children,
    this.count,
    this.initiallyOpen = false,
    super.key,
  });

  final String title;
  final List<Widget> children;

  /// The number of things in it (left out when null or zero).
  final int? count;
  final bool initiallyOpen;

  @override
  State<PwfFold> createState() => _PwfFoldState();
}

class _PwfFoldState extends State<PwfFold> {
  late bool _open = widget.initiallyOpen;

  @override
  void didUpdateWidget(PwfFold oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A fold that is asked to be open from now on (a request waiting for a decision appeared in it) opens by itself; it is never shut for the person.
    if (!oldWidget.initiallyOpen && widget.initiallyOpen) _open = true;
  }

  void _toggle() => setState(() => _open = !_open);

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final int? count = widget.count == null || widget.count == 0
        ? null
        : widget.count;
    final String name = count == null
        ? widget.title
        : '${widget.title}, $count';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Semantics(
              container: true,
              button: true,
              expanded: _open,
              label: _open
                  ? context.t('mob.pwfs.task.fold.close', <String, Object>{
                      'title': name,
                    })
                  : context.t('mob.pwfs.task.fold.open', <String, Object>{
                      'title': name,
                    }),
              onTap: _toggle,
              excludeSemantics: true,
              child: Material(
                type: MaterialType.transparency,
                child: InkWell(
                  onTap: _toggle,
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(
                      minHeight: MachvonV2Size.touchMin,
                    ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: MachvonV2Space.s16,
                        vertical: MachvonV2Space.s12,
                      ),
                      child: Row(
                        children: <Widget>[
                          Expanded(
                            child: Text(widget.title, style: text.heading),
                          ),
                          if (count != null)
                            Padding(
                              padding: const EdgeInsets.only(
                                right: MachvonV2Space.s8,
                              ),
                              child: Text('$count', style: text.caption),
                            ),
                          Icon(
                            _open ? Icons.expand_less : Icons.expand_more,
                            color: v2.palette.ink2,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
            if (_open) ...widget.children,
            if (_open) const SizedBox(height: MachvonV2Space.s8),
          ],
        ),
        SizedBox(height: 1, child: ColoredBox(color: v2.palette.line)),
      ],
    );
  }
}
