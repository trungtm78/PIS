import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../l10n/app_strings.dart';
import '../theme/machvon_semantic.dart';
import 'status_pill.dart';

/// The line that goes with every number (design.md "ContextBar"): the scope it describes, the closing date, and how fresh it is,
/// separated by dots, and "Stale figures" in a pill when the figures are stale. [notes] are full sentences under the line (a copy kept
/// on the device says so). The line wraps at a large text scale; [onRefresh] is a 48 dp button.
class ContextBar extends StatelessWidget {
  const ContextBar({
    this.scope,
    this.closing,
    this.freshness,
    this.stale = false,
    this.notes = const <String>[],
    this.onRefresh,
    this.refreshTooltip,
    this.highlighted = false,
    super.key,
  });

  /// "Whole company · Year 2026".
  final String? scope;

  /// The closing date of the figures, already formatted ("30/10/2026"); worded by this widget as "Figures closed 30/10/2026".
  final String? closing;

  /// "Figures as of 07/11/2026 08:00" or "Loaded at 08:00".
  final String? freshness;

  /// Whether to show the "Stale figures" pill.
  final bool stale;
  final List<String> notes;
  final VoidCallback? onRefresh;
  final String? refreshTooltip;

  /// A copy kept on the device, or any state the reader must notice: a soft teal fill under the line.
  final bool highlighted;

  @override
  Widget build(BuildContext context) {
    final TextTheme text = Theme.of(context).textTheme;
    final List<String> parts = <String>[
      if (scope != null) scope!,
      if (closing != null) context.t('mob.ctx.closing.label', <String, Object>{'date': closing!}),
      if (freshness != null) freshness!,
    ];
    return Semantics(
      container: true,
      liveRegion: highlighted,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: highlighted ? Theme.of(context).colorScheme.primaryContainer : MachvonColors.surface2,
          border: const Border(bottom: BorderSide(color: MachvonColors.border)),
        ),
        child: Padding(
          padding: const EdgeInsets.only(left: MachvonSpace.space16, right: MachvonSpace.space4, top: MachvonSpace.space4, bottom: MachvonSpace.space4),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      if (parts.isNotEmpty) Text(parts.join(' · '), style: text.bodySmall),
                      for (final String note in notes) Text(note, style: text.bodySmall),
                      if (stale)
                        Padding(
                          padding: const EdgeInsets.only(top: MachvonSpace.space4),
                          child: StatusPill(label: context.t('mob.ctx.stale.badge'), tone: MachvonTone.warning),
                        ),
                    ],
                  ),
                ),
              ),
              if (onRefresh != null)
                IconButton(
                  onPressed: onRefresh,
                  tooltip: refreshTooltip,
                  icon: Icon(Icons.refresh, color: Theme.of(context).colorScheme.primary),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
