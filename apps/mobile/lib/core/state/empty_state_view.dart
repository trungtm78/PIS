import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../l10n/app_strings.dart';
import '../widgets/section_panel.dart';
import 'state_card.dart';

/// The empty state (MOB-52): there is nothing to show. It names the filters that are in use, because an empty list with
/// a filter usually means "the filter is too narrow", and offers to clear them; with no filter it tells the user what
/// to do next.
class EmptyStateView extends StatelessWidget {
  const EmptyStateView({this.activeFilters = const <String>[], this.onClearFilters, super.key});

  /// The filters in use, already worded for the user.
  final List<String> activeFilters;

  /// Clears the filters; the action is shown only when there are filters and a handler.
  final VoidCallback? onClearFilters;

  @override
  Widget build(BuildContext context) {
    final bool hasFilters = activeFilters.isNotEmpty;
    return StateCard(
      icon: Icons.inbox_outlined,
      title: context.t('mob.states.empty.title'),
      body: context.t('mob.states.empty.body'),
      announcement: <String>[
        context.t('mob.states.empty.title'),
        context.t('mob.states.empty.body'),
        if (hasFilters) '${context.t('mob.states.empty.filter.label')}: ${activeFilters.join(', ')}',
      ].join('. '),
      details: <Widget>[
        if (hasFilters)
          Wrap(
            alignment: WrapAlignment.center,
            spacing: MachvonSpace.space8,
            runSpacing: MachvonSpace.space8,
            children: <Widget>[for (final String filter in activeFilters) NoteChip(label: filter)],
          ),
      ],
      actions: <Widget>[
        if (hasFilters && onClearFilters != null)
          OutlinedButton(onPressed: onClearFilters, child: Text(context.t('mob.states.empty.clearFilters.action'))),
      ],
    );
  }
}
