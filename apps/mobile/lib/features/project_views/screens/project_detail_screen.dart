import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/amounts.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../project_models.dart';

/// MOB-10: one project. Its general data, its capital (the total investment, read-only), its schedule (the milestones) and
/// its risks. A part the reader may not read says so and is not shown as empty or zero; a network that fails shows the copy.
Widget buildProjectDetailScreen(BuildContext context, ScreenContext screen) => ProjectDetailScreen(projectId: screen.pathParameters['projectId'] ?? '');

class ProjectDetailScreen extends StatelessWidget {
  const ProjectDetailScreen({required this.projectId, super.key});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.prj.detail.title'),
      body: DataView<ProjectDetail>(
        cacheKey: 'projects.detail.$projectId',
        read: _read,
        parse: parseProjectDetail,
        asOf: (ProjectDetail detail) => detail.asOf,
        builder: (BuildContext context, Loaded<ProjectDetail> loaded) => _DetailBody(detail: loaded.value),
      ),
    );
  }

  /// The project, then its plan and its risks. Those two are separate rights: a refusal (not a lost connection) leaves the
  /// part out and says so, while a lost connection fails the read so that the copy is shown.
  Future<Object?> _read(MachvonApiClient client) async {
    final Object? project = await client.execute('get_resources_project_id', path: <String, Object?>{'id': projectId});
    return <String, Object?>{
      'project': project,
      'milestones': await _optional(() => client.execute('listProjectMilestones', path: <String, Object?>{'id': projectId})),
      'risks': await _optional(() => client.execute('listProjectRisks', path: <String, Object?>{'id': projectId}, query: <String, Object?>{'limit': 5})),
    };
  }

  static Future<Object?> _optional(Future<Object?> Function() read) async {
    try {
      return await read();
    } on ApiError catch (error) {
      if (error.code == networkErrorCode) rethrow;
      return null;
    }
  }
}

class _DetailBody extends StatelessWidget {
  const _DetailBody({required this.detail});

  final ProjectDetail detail;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ProjectLine line = detail.line;
    final String none = context.t('mob.prj.detail.overview.none');
    final List<Milestone>? milestones = detail.milestones;
    final RiskSummary? risks = detail.risks;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: '${line.code} · ${line.name}',
          children: <Widget>[
            FactLine(label: context.t('mob.prj.detail.overview.stage'), value: stageLabel(context, line.stage)),
            FactLine(label: context.t('mob.prj.detail.overview.unit'), value: line.unitName),
            FactLine(label: context.t('mob.prj.detail.overview.group'), value: line.projectGroup ?? none),
            FactLine(label: context.t('mob.prj.detail.overview.national'), value: line.nationalCode ?? none),
            FactLine(label: context.t('mob.prj.detail.overview.leader'), value: line.leaderName ?? none),
            FactLine(label: context.t('mob.prj.detail.overview.area'), value: detail.areaLabel ?? none),
            FactLine(label: context.t('mob.prj.detail.overview.sector'), value: detail.sectorLabel ?? none),
          ],
        ),
        SectionCard(
          title: context.t('mob.prj.detail.capital.title'),
          children: <Widget>[
            FactLine(label: context.t('mob.prj.detail.capital.total'), value: millionsLabel(context, detail.totalInvestmentVnd)),
            Text(dongLabel(context, detail.totalInvestmentVnd), style: theme.textTheme.bodySmall),
          ],
        ),
        SectionCard(
          title: context.t('mob.prj.detail.schedule.title'),
          children: <Widget>[
            if (detail.startYear != null && detail.endYear != null)
              FactLine(
                label: context.t('mob.prj.detail.schedule.years'),
                value: context.t('mob.prj.detail.schedule.yearsValue', <String, Object>{'from': detail.startYear!, 'to': detail.endYear!}),
              ),
            if (milestones == null)
              Text(context.t('mob.prj.detail.unreadable'), style: theme.textTheme.bodyMedium)
            else if (milestones.isEmpty)
              Text(context.t('mob.prj.detail.schedule.none'), style: theme.textTheme.bodyMedium)
            else
              for (final Milestone milestone in milestones) _MilestoneLine(milestone: milestone),
          ],
        ),
        SectionCard(
          title: context.t('mob.prj.detail.risk.title'),
          children: <Widget>[
            if (risks == null)
              Text(context.t('mob.prj.detail.unreadable'), style: theme.textTheme.bodyMedium)
            else ...<Widget>[
              Text(context.t('mob.prj.detail.risk.counts', <String, Object>{'live': risks.live, 'critical': risks.critical, 'overdue': risks.overdue}), style: theme.textTheme.bodyMedium),
              if (risks.top.isEmpty) Text(context.t('mob.prj.detail.risk.none'), style: theme.textTheme.bodySmall),
              for (final ProjectRisk risk in risks.top) _RiskLine(risk: risk),
            ],
          ],
        ),
      ],
    );
  }
}

class _MilestoneLine extends StatelessWidget {
  const _MilestoneLine({required this.milestone});

  final Milestone milestone;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String planned = context.t('mob.prj.detail.schedule.planned', <String, Object>{'date': asOfLabel(milestone.plannedDate)});
    final String actual = milestone.actualDate == null ? '' : ', ${context.t('mob.prj.detail.schedule.actual', <String, Object>{'date': asOfLabel(milestone.actualDate!)})}';
    final String delay = milestone.delayed ? ', ${context.t('mob.prj.detail.schedule.delay', <String, Object>{'days': milestone.delayDays})}' : '';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
      child: MergeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Wrap(spacing: MachvonSpace.space8, children: <Widget>[Text(milestone.name, style: theme.textTheme.bodyLarge), StatusPill(label: _status(context, milestone.status), warn: milestone.delayed)]),
            Text('$planned$actual$delay', style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }

  String _status(BuildContext context, String status) {
    switch (status) {
      case 'DONE':
        return context.t('mob.prj.detail.milestone.done');
      case 'DELAYED':
        return context.t('mob.prj.detail.milestone.delayed');
      case 'CANCELLED':
        return context.t('mob.prj.detail.milestone.cancelled');
      default:
        return context.t('mob.prj.detail.milestone.planned');
    }
  }
}

class _RiskLine extends StatelessWidget {
  const _RiskLine({required this.risk});

  final ProjectRisk risk;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
      child: Text(
        context.t('mob.prj.detail.risk.item', <String, Object>{'code': risk.code, 'title': risk.title, 'score': risk.score, 'level': _level(context, risk.level)}),
        style: Theme.of(context).textTheme.bodyMedium,
      ),
    );
  }

  String _level(BuildContext context, String level) {
    switch (level) {
      case 'CRITICAL':
        return context.t('mob.prj.detail.riskLevel.critical');
      case 'MEDIUM':
        return context.t('mob.prj.detail.riskLevel.medium');
      default:
        return context.t('mob.prj.detail.riskLevel.low');
    }
  }
}
