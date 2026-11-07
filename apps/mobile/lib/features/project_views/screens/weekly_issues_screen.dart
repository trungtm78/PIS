import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/amounts.dart';
import '../../read_support/clock.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/widgets.dart';
import '../issue_models.dart';

/// MOB-59: the issues of a week by unit and by group: what was open at the start of the week, what was raised, what was
/// resolved and what is still open at its end (the backlog), with the total of the whole scope. The week is an ISO week; the
/// reader moves to the week before and after, and the screen opens on the week of today in Vietnam time (a choice of the
/// first view only: the matrix itself is the server's).
Widget buildWeeklyIssuesScreen(BuildContext context, ScreenContext screen) => WeeklyIssuesScreen(requestedWeek: screen.queryParameters['week']);

class WeeklyIssuesScreen extends ConsumerStatefulWidget {
  const WeeklyIssuesScreen({this.requestedWeek, super.key});

  final String? requestedWeek;

  @override
  ConsumerState<WeeklyIssuesScreen> createState() => _WeeklyIssuesScreenState();
}

class _WeeklyIssuesScreenState extends ConsumerState<WeeklyIssuesScreen> {
  String? _week;

  String _currentWeek() {
    final String? asked = _week ?? widget.requestedWeek;
    if (asked != null && mondayOf(asked) != null) return asked;
    return currentWeek(ref.read(clockProvider)());
  }

  @override
  Widget build(BuildContext context) {
    final String week = _currentWeek();
    return ScreenFrame(
      title: context.t('mob.prj.issues.title'),
      body: DataView<IssueMatrix>(
        cacheKey: 'projects.issues.$week',
        read: (MachvonApiClient client) => client.getIssueWeeklyMatrix(query: <String, Object?>{'week': week}),
        parse: parseIssueMatrix,
        asOf: (IssueMatrix matrix) => matrix.asOf,
        builder: (BuildContext context, Loaded<IssueMatrix> loaded) => _Body(matrix: loaded.value, onWeek: (String next) => setState(() => _week = next)),
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.matrix, required this.onWeek});

  final IssueMatrix matrix;
  final ValueChanged<String> onWeek;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space8, vertical: MachvonSpace.space8),
          child: Row(
            children: <Widget>[
              IconButton(
                onPressed: () => onWeek(shiftWeek(matrix.week, -1)),
                tooltip: context.t('mob.prj.issues.week.previous'),
                icon: const Icon(Icons.chevron_left),
              ),
              Expanded(
                child: Column(
                  children: <Widget>[
                    Semantics(header: true, child: Text(context.t('mob.prj.issues.week.label', <String, Object>{'week': matrix.week}), style: theme.textTheme.titleMedium)),
                    if (matrix.from.isNotEmpty) Text(context.t('mob.prj.issues.week.range', <String, Object>{'from': asOfLabel(matrix.from), 'to': asOfLabel(matrix.to)}), style: theme.textTheme.bodySmall),
                  ],
                ),
              ),
              IconButton(
                onPressed: () => onWeek(shiftWeek(matrix.week, 1)),
                tooltip: context.t('mob.prj.issues.week.next'),
                icon: const Icon(Icons.chevron_right),
              ),
            ],
          ),
        ),
        SectionCard(title: context.t('mob.prj.issues.totals.title'), children: <Widget>[_Headline(totals: matrix.totals)]),
        for (final IssueRow row in matrix.rows)
          SectionCard(
            title: context.t('mob.prj.issues.group.title', <String, Object>{'unit': row.unitName, 'group': row.categoryLabel.isEmpty ? context.t('mob.prj.issues.group.none') : row.categoryLabel}),
            children: <Widget>[_Counts(totals: row.totals)],
          ),
      ],
    );
  }
}

/// The totals of the whole matrix as figures (two to a line); the groups below keep the compact lines.
class _Headline extends StatelessWidget {
  const _Headline({required this.totals});

  final IssueTotals totals;

  @override
  Widget build(BuildContext context) {
    return KpiGroup(
      tiles: <Widget>[
        KpiTile(label: context.t('mob.prj.issues.opening'), value: '${totals.opening}'),
        KpiTile(label: context.t('mob.prj.issues.opened'), value: '${totals.opened}'),
        KpiTile(label: context.t('mob.prj.issues.resolved'), value: '${totals.resolved}'),
        KpiTile(label: context.t('mob.prj.issues.closing'), value: '${totals.closing}'),
        KpiTile(label: context.t('mob.prj.issues.overdue'), value: '${totals.overdue}'),
      ],
    );
  }
}

class _Counts extends StatelessWidget {
  const _Counts({required this.totals});

  final IssueTotals totals;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        FactLine(label: context.t('mob.prj.issues.opening'), value: '${totals.opening}'),
        FactLine(label: context.t('mob.prj.issues.opened'), value: '${totals.opened}'),
        FactLine(label: context.t('mob.prj.issues.resolved'), value: '${totals.resolved}'),
        FactLine(label: context.t('mob.prj.issues.closing'), value: '${totals.closing}'),
        FactLine(label: context.t('mob.prj.issues.overdue'), value: '${totals.overdue}'),
      ],
    );
  }
}
