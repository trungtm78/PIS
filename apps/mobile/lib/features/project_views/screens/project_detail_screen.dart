import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/deadline.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/nav_row.dart';
import '../../../core/widgets/section_panel.dart';
import '../../../core/widgets/stage_strip.dart';
import '../../../core/widgets/stat_strip.dart';
import '../../../core/widgets/underline_tabs.dart';
import '../../../core/widgets/work_row.dart';
import '../../project_workflow/pwf_progress_section.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../project_models.dart';

/// MOB-10: one project, in four tabs. Overview (the facts that are known, the capital as one figure, the risks), Progress (the stage strip
/// is above the tabs; the milestones grouped by what needs attention, what is coming and what is over, and the tasks of the workflow once
/// there is a source of them), Capital and Files. A field that is not known is left out, not shown as "None yet"; a part the reader may not
/// read says so and is not shown as empty or zero; a network that fails shows the copy.
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

class _DetailBody extends StatefulWidget {
  const _DetailBody({required this.detail});

  final ProjectDetail detail;

  @override
  State<_DetailBody> createState() => _DetailBodyState();
}

class _DetailBodyState extends State<_DetailBody> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final ProjectDetail detail = widget.detail;
    // One scroll for the header, the tabs and the content: at a large text scale the header alone is most of a screen, and it must not push the content out of reach.
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        _Header(detail: detail),
        UnderlineTabs(
          index: _tab,
          onChanged: (int index) => setState(() => _tab = index),
          tabs: <TabOption>[
            TabOption(label: context.t('mob.prj.detail.tab.overview')),
            TabOption(label: context.t('mob.prj.detail.schedule.title')),
            TabOption(label: context.t('mob.prj.detail.capital.title')),
            TabOption(label: context.t('mob.prj.detail.tab.documents')),
          ],
        ),
        ...switch (_tab) {
          0 => _overview(context, detail),
          1 => _progress(context, detail),
          2 => _capital(context, detail),
          _ => _documents(context),
        },
      ],
    );
  }
}

/// The name of the project, its stage and, when the stage is on the strip of six, where it stands on it.
class _Header extends StatelessWidget {
  const _Header({required this.detail});

  final ProjectDetail detail;

  @override
  Widget build(BuildContext context) {
    final ProjectLine line = detail.line;
    final MachvonV2Text text = context.v2text;
    final StripPosition? position = stripPositionOf(line.stage);
    final List<Milestone>? milestones = detail.milestones;
    final List<Milestone> counted = <Milestone>[if (milestones != null) for (final Milestone milestone in milestones) if (!milestone.isCancelled) milestone];
    final int done = counted.where((Milestone milestone) => milestone.isDone).length;
    final String stage = stageLabel(context, line.stage);
    return Padding(
      padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s4, MachvonV2Space.s16, MachvonV2Space.s12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Semantics(container: true, header: true, child: Text('${line.code} · ${line.name}', style: text.title, textScaler: cappedScaler(context, MachvonV2Type.titleScaleCap))),
          const SizedBox(height: MachvonV2Space.s8),
          Wrap(
            spacing: MachvonV2Space.s8,
            runSpacing: MachvonV2Space.s4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              StatusPill(label: stage),
              if (line.unitName.isNotEmpty) Text(line.unitName, style: text.caption),
            ],
          ),
          if (position != null) ...<Widget>[
            const SizedBox(height: MachvonV2Space.s12),
            StageStrip(
              total: kStageStripSegments,
              current: position.current,
              currentFraction: position.finished ? 1 : (milestoneFraction(milestones) ?? 0),
              label: context.t('mob.prj.detail.strip.label', <String, Object>{'n': position.current, 'total': kStageStripSegments, 'stage': stage}),
              trailing: counted.isEmpty ? null : context.t('mob.prj.detail.strip.milestones', <String, Object>{'done': done, 'total': counted.length}),
            ),
          ],
        ],
      ),
    );
  }
}

// ---- Overview --------------------------------------------------------------------------------------------------------------------

List<Widget> _overview(BuildContext context, ProjectDetail detail) {
  final ProjectLine line = detail.line;
  final List<(String, String?)> facts = <(String, String?)>[
    (context.t('mob.prj.detail.overview.unit'), line.unitName),
    (context.t('mob.prj.detail.overview.group'), line.projectGroup),
    (context.t('mob.prj.detail.overview.national'), line.nationalCode),
    (context.t('mob.prj.detail.overview.leader'), line.leaderName),
    (context.t('mob.prj.detail.overview.area'), detail.areaLabel),
    (context.t('mob.prj.detail.overview.sector'), detail.sectorLabel),
    (
      context.t('mob.prj.detail.schedule.years'),
      detail.startYear != null && detail.endYear != null ? context.t('mob.prj.detail.schedule.yearsValue', <String, Object>{'from': detail.startYear!, 'to': detail.endYear!}) : null,
    ),
    (context.t('mob.prj.detail.capital.total'), moneyLabel(context, detail.totalInvestmentVnd)),
  ];
  final List<(String, String?)> known = <(String, String?)>[for (final (String, String?) fact in facts) if (fact.$2 != null && fact.$2!.isNotEmpty) fact];
  final RiskSummary? risks = detail.risks;
  return <Widget>[
    for (int index = 0; index < known.length; index += 1) InfoRow(label: known[index].$1, value: known[index].$2, divider: index > 0),
    const SizedBox(height: MachvonV2Space.s12),
    SectionPanel(
      title: context.t('mob.prj.detail.risk.title'),
      padded: false,
      children: <Widget>[
        if (risks == null)
          const _Unreadable()
        else ...<Widget>[
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
            child: Text(context.t('mob.prj.detail.risk.counts', <String, Object>{'live': risks.live, 'critical': risks.critical, 'overdue': risks.overdue}), style: context.v2text.body),
          ),
          if (risks.top.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
              child: Text(context.t('mob.prj.detail.risk.none'), style: context.v2text.caption),
            ),
          for (int index = 0; index < risks.top.length; index += 1) _RiskRow(risk: risks.top[index], dividerAbove: index > 0),
        ],
      ],
    ),
  ];
}

class _RiskRow extends StatelessWidget {
  const _RiskRow({required this.risk, required this.dividerAbove});

  final ProjectRisk risk;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final (String level, MachvonTone tone) = switch (risk.level) {
      'CRITICAL' => (context.t('mob.prj.detail.riskLevel.critical'), MachvonTone.danger),
      'MEDIUM' => (context.t('mob.prj.detail.riskLevel.medium'), MachvonTone.warning),
      _ => (context.t('mob.prj.detail.riskLevel.low'), MachvonTone.neutral),
    };
    return WorkRow(
      title: '${risk.code} ${risk.title}',
      subtitle: context.t('mob.prj.detail.risk.score', <String, Object>{'score': risk.score}),
      trailing: StatusPill(label: level, tone: tone),
      dividerAbove: dividerAbove,
    );
  }
}

/// The note of a part the reader has no right to read: said in words, never drawn as empty or as a zero.
class _Unreadable extends StatelessWidget {
  const _Unreadable();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s4),
      child: Semantics(
        liveRegion: true,
        container: true,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            ExcludeSemantics(child: Icon(Icons.lock_outline, size: 16, color: context.v2.palette.ink2)),
            const SizedBox(width: MachvonV2Space.s8),
            Expanded(child: Text(context.t('mob.prj.detail.unreadable'), style: context.v2text.body)),
          ],
        ),
      ),
    );
  }
}

// ---- Progress --------------------------------------------------------------------------------------------------------------------

List<Widget> _progress(BuildContext context, ProjectDetail detail) {
  final List<Milestone>? milestones = detail.milestones;
  final Map<MilestoneGroup, String> titles = <MilestoneGroup, String>{
    MilestoneGroup.attention: context.t('mob.prj.detail.group.attention'),
    MilestoneGroup.upcoming: context.t('mob.prj.detail.group.upcoming'),
    MilestoneGroup.over: context.t('mob.prj.detail.group.over'),
  };
  return <Widget>[
    if (milestones == null)
      const Padding(padding: EdgeInsets.symmetric(vertical: MachvonV2Space.s12), child: _Unreadable())
    else if (milestones.isEmpty)
      Padding(
        padding: const EdgeInsets.all(MachvonV2Space.s16),
        child: Text(context.t('mob.prj.detail.schedule.none'), style: context.v2text.body),
      )
    else
      for (final MilestoneGroup group in MilestoneGroup.values)
        ...(() {
          final List<Milestone> members = <Milestone>[for (final Milestone milestone in milestones) if (milestoneGroupOf(milestone) == group) milestone];
          if (members.isEmpty) return const <Widget>[];
          return <Widget>[
            GroupHeader(title: titles[group]!, count: members.length),
            for (int index = 0; index < members.length; index += 1) _MilestoneRow(milestone: members[index], dividerAbove: index > 0),
          ];
        })(),
    // The workflow of the project (PWF): its stages and its tasks by official colour. A project with no workflow, or a reader who may not read it, draws nothing here.
    PwfProgressSection(projectId: detail.line.id, showMilestones: false),
  ];
}

class _MilestoneRow extends StatelessWidget {
  const _MilestoneRow({required this.milestone, required this.dividerAbove});

  final Milestone milestone;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final String planned = context.t('mob.prj.detail.schedule.planned', <String, Object>{'date': asOfLabel(milestone.plannedDate)});
    final String actual = milestone.actualDate == null ? '' : ', ${context.t('mob.prj.detail.schedule.actual', <String, Object>{'date': asOfLabel(milestone.actualDate!)})}';
    final String delay = milestone.delayed ? ', ${context.t('mob.prj.detail.schedule.delay', <String, Object>{'days': milestone.delayDays})}' : '';
    final DeadlineBand? band = milestone.isCancelled ? null : (milestone.isDone ? DeadlineBand.done : (milestone.needsAttention ? DeadlineBand.late : DeadlineBand.ok));
    // The delay is told by the late band; the status by its own word. A milestone that was done late is done: its delay is in the line under the name.
    final Widget status = milestone.isCancelled
        ? StatusPill(label: context.t('mob.prj.detail.milestone.cancelled'))
        : milestone.isDone
            ? DeadlineLabel(band: DeadlineBand.done, text: context.t('mob.prj.detail.milestone.done'))
            : milestone.needsAttention
                ? DeadlineLabel(band: DeadlineBand.late, text: milestone.delayDays > 0 ? formatDeadline(context, -milestone.delayDays) : context.t('mob.prj.detail.milestone.delayed'))
                : DeadlineLabel(band: DeadlineBand.ok, text: context.t('mob.prj.detail.milestone.planned'));
    return WorkRow(
      title: milestone.name,
      subtitle: '$planned$actual$delay',
      leading: band == null ? null : DeadlineGlyph(band: band),
      trailing: status,
      dividerAbove: dividerAbove,
    );
  }
}

// ---- Capital ---------------------------------------------------------------------------------------------------------------------

List<Widget> _capital(BuildContext context, ProjectDetail detail) {
  return <Widget>[
    StatStrip(cells: <StatCell>[StatCell(value: moneyLabel(context, detail.totalInvestmentVnd), label: context.t('mob.prj.detail.capital.total'))]),
    InfoRow(label: context.t('mob.prj.detail.capital.exact'), value: moneyExactLabel(context, detail.totalInvestmentVnd), divider: false),
    const SizedBox(height: MachvonV2Space.s12),
    GroupHeader(title: context.t('mob.prj.detail.capital.more')),
    NavRow(label: context.t('mob.prj.list.link.capital'), icon: Icons.account_balance_outlined, onTap: () => openScreen(context, 'MOB-12')),
    NavRow(label: context.t('mob.prj.list.work.payment'), icon: Icons.payments_outlined, onTap: () => openScreen(context, 'MOB-27'), dividerAbove: true),
    NavRow(label: context.t('mob.prj.list.work.treasury'), icon: Icons.account_balance_wallet_outlined, onTap: () => openScreen(context, 'MOB-60'), dividerAbove: true),
  ];
}

// ---- Files -----------------------------------------------------------------------------------------------------------------------

List<Widget> _documents(BuildContext context) {
  return <Widget>[
    SectionPanel(
      title: context.t('mob.prj.detail.documents.title'),
      padded: false,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
          child: Text(context.t('mob.prj.detail.documents.body'), style: context.v2text.body),
        ),
        const SizedBox(height: MachvonV2Space.s8),
        NavRow(label: context.t('mob.prj.list.work.qa'), icon: Icons.question_answer_outlined, onTap: () => openScreen(context, 'MOB-37')),
        NavRow(label: context.t('mob.prj.list.work.handover'), icon: Icons.assignment_turned_in_outlined, onTap: () => openScreen(context, 'MOB-66'), dividerAbove: true),
      ],
    ),
  ];
}
