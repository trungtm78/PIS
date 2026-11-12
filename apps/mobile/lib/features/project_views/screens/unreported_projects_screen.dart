import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/clock.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../../read_support/wire.dart';
import '../report_models.dart';

/// MOB-57: the projects that have not handed a report in for a reporting period, each with the period, its deadline and the
/// leader in charge. The deadline is the one the calendar of the tenant gives, shown in Vietnam time, and whether it passed is
/// the server's word: the clock of the phone never judges it. Only the projects in the scope of the reader are listed.
Widget buildUnreportedProjectsScreen(BuildContext context, ScreenContext screen) => UnreportedProjectsScreen(requestedPeriod: screen.queryParameters['period']);

class UnreportedProjectsScreen extends ConsumerStatefulWidget {
  const UnreportedProjectsScreen({this.requestedPeriod, super.key});

  final String? requestedPeriod;

  @override
  ConsumerState<UnreportedProjectsScreen> createState() => _UnreportedProjectsScreenState();
}

class _UnreportedProjectsScreenState extends ConsumerState<UnreportedProjectsScreen> {
  String? _chosen;

  @override
  Widget build(BuildContext context) {
    final String? periodId = _chosen ?? widget.requestedPeriod;
    final DateTime Function() now = ref.read(clockProvider);
    return ScreenFrame(
      title: context.t('mob.prj.unreported.title'),
      body: DataView<UnreportedProjects>(
        cacheKey: 'projects.unreported.${periodId ?? 'default'}',
        read: (MachvonApiClient client) => _read(client, periodId, now()),
        parse: parseUnreported,
        asOf: (UnreportedProjects list) => list.asOf,
        isEmpty: (UnreportedProjects list) => list.period == null || list.projects.isEmpty,
        builder: (BuildContext context, Loaded<UnreportedProjects> loaded) => _Body(list: loaded.value, period: loaded.value.period!, onPeriod: (String id) => setState(() => _chosen = id)),
      ),
    );
  }

  /// The periods of the calendar, then the board of the one asked for (or the newest that has started) with every project
  /// that must report, a page at a time. The leaders come from the register; a register that cannot be read leaves the leader
  /// out and does not fail the screen, but a lost connection does.
  static Future<Object?> _read(MachvonApiClient client, String? requested, DateTime now) async {
    final Json periods = await readMerged(client, 'get_resources_reporting_period', query: <String, Object?>{'limit': 200});
    final List<ReportingPeriod> choices = <ReportingPeriod>[for (final Object? row in listOf(periods['items'])) ?parseReportingPeriod(row)];
    final String? id = requested ?? defaultPeriod(choices, now)?.id;
    final Json? progress = id == null ? null : await readMerged(client, 'getSubmissionProgress', path: <String, Object?>{'id': id}, query: <String, Object?>{'state': 'MUST_REPORT', 'limit': 200});
    Json? leaders;
    try {
      leaders = await readMerged(client, 'get_resources_project', query: <String, Object?>{'limit': 200});
    } on ApiError catch (error) {
      if (error.code == networkErrorCode) rethrow;
    }
    return <String, Object?>{'periods': periods['items'], 'progress': progress, 'leaders': leaders};
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.list, required this.period, required this.onPeriod});

  final UnreportedProjects list;
  final ReportingPeriod period;
  final ValueChanged<String> onPeriod;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String deadline = formatMoment(period.deadlineAt);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        if (list.periods.length > 1)
          Padding(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: DropdownButtonFormField<String>(
              initialValue: period.id,
              isExpanded: true,
              decoration: InputDecoration(labelText: context.t('mob.prj.unreported.period.label')),
              items: <DropdownMenuItem<String>>[
                for (final ReportingPeriod period in list.periods)
                  DropdownMenuItem<String>(
                    value: period.id,
                    child: Text(context.t('mob.prj.unreported.period.option', <String, Object>{'code': period.code, 'start': asOfLabel(period.startDate), 'end': asOfLabel(period.endDate)})),
                  ),
              ],
              onChanged: (String? id) {
                if (id != null) onPeriod(id);
              },
            ),
          ),
        SectionCard(
          title: period.code,
          children: <Widget>[
            Semantics(
              liveRegion: list.deadlinePassed,
              child: Text(
                list.deadlinePassed ? context.t('mob.prj.unreported.deadline.passed', <String, Object>{'time': deadline}) : context.t('mob.prj.unreported.deadline.open', <String, Object>{'time': deadline}),
                style: theme.textTheme.bodyLarge,
              ),
            ),
            Text(context.t('mob.prj.unreported.summary', <String, Object>{'count': list.projects.length, 'total': list.mustReport}), style: theme.textTheme.bodyMedium),
          ],
        ),
        for (final ProgressProject project in list.projects) _ProjectRow(project: project, period: period),
      ],
    );
  }
}

class _ProjectRow extends StatelessWidget {
  const _ProjectRow({required this.project, required this.period});

  final ProgressProject project;
  final ReportingPeriod period;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String state = project.state == ReportState.draft ? context.t('mob.prj.unreported.state.draft') : context.t('mob.prj.unreported.state.notStarted');
    final String leader = project.leaderName == null ? context.t('mob.prj.list.row.leaderNone') : context.t('mob.prj.unreported.row.leader', <String, Object>{'name': project.leaderName!});
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      child: MergeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text('${project.code} · ${project.name}', style: theme.textTheme.bodyLarge),
            Wrap(spacing: MachvonSpace.space8, children: <Widget>[StatusPill(label: state), if (project.overdue) StatusPill(label: context.t('mob.prj.unreported.overdue'), warn: true)]),
            Text(context.t('mob.prj.unreported.row.unit', <String, Object>{'unit': project.unitName}), style: theme.textTheme.bodySmall),
            Text(leader, style: theme.textTheme.bodySmall),
            Text(context.t('mob.prj.unreported.row.due', <String, Object>{'period': period.code, 'time': formatMoment(period.deadlineAt)}), style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}
