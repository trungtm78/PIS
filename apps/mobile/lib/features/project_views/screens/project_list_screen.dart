import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/state/empty_state_view.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../project_models.dart';

/// MOB-09: the projects in the scope of the reader. Search and stage filter work on the copy in memory, so they work offline
/// too; every row says the moment the register describes (BR-MOB-01), and a register read from the copy says so above the list.
Widget buildProjectListScreen(BuildContext context, ScreenContext screen) => const ProjectListScreen();

class ProjectListScreen extends StatefulWidget {
  const ProjectListScreen({super.key});

  @override
  State<ProjectListScreen> createState() => _ProjectListScreenState();
}

class _ProjectListScreenState extends State<ProjectListScreen> {
  ProjectFilter _filter = const ProjectFilter();
  final TextEditingController _query = TextEditingController();

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  void _clear() {
    _query.clear();
    setState(() => _filter = const ProjectFilter());
  }

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.prj.list.title'),
      body: DataView<ProjectRegister>(
        cacheKey: 'projects.register',
        read: (MachvonApiClient client) => readMerged(client, 'get_resources_project', query: <String, Object?>{'limit': 200}),
        parse: parseProjectRegister,
        asOf: (ProjectRegister register) => register.asOf,
        isEmpty: (ProjectRegister register) => register.projects.isEmpty,
        builder: (BuildContext context, Loaded<ProjectRegister> loaded) {
          final List<ProjectLine> shown = filterProjects(loaded.value.projects, _filter);
          return _ProjectList(
            loaded: loaded,
            shown: shown,
            filter: _filter,
            query: _query,
            onQuery: (String value) => setState(() => _filter = _filter.copyWith(query: value)),
            onStage: (ProjectStage? stage) => setState(() => _filter = _filter.copyWith(stage: stage, clearStage: stage == null)),
            onClear: _clear,
          );
        },
      ),
    );
  }
}

class _ProjectList extends StatelessWidget {
  const _ProjectList({required this.loaded, required this.shown, required this.filter, required this.query, required this.onQuery, required this.onStage, required this.onClear});

  final Loaded<ProjectRegister> loaded;
  final List<ProjectLine> shown;
  final ProjectFilter filter;
  final TextEditingController query;
  final ValueChanged<String> onQuery;
  final ValueChanged<ProjectStage?> onStage;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final ProjectRegister register = loaded.value;
    final List<Widget> header = <Widget>[
      Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            TextField(
              controller: query,
              onChanged: onQuery,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(labelText: context.t('mob.prj.list.search.label'), prefixIcon: const Icon(Icons.search)),
            ),
            const SizedBox(height: MachvonSpace.space12),
            DropdownButtonFormField<ProjectStage?>(
              initialValue: filter.stage,
              isExpanded: true,
              decoration: InputDecoration(labelText: context.t('mob.prj.list.stage.label')),
              items: <DropdownMenuItem<ProjectStage?>>[
                DropdownMenuItem<ProjectStage?>(child: Text(context.t('mob.prj.list.stage.all'))),
                for (final ProjectStage stage in ProjectStage.values) DropdownMenuItem<ProjectStage?>(value: stage, child: Text(stageLabel(context, stage))),
              ],
              onChanged: onStage,
            ),
            const SizedBox(height: MachvonSpace.space8),
            Text(context.t('mob.prj.list.count', <String, Object>{'shown': shown.length, 'total': register.projects.length}), style: Theme.of(context).textTheme.bodySmall),
            if (register.truncated) Text(context.t('mob.prj.list.truncated'), style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
      _LinkRow(label: context.t('mob.prj.list.link.map'), screenId: 'MOB-11'),
      _LinkRow(label: context.t('mob.prj.list.link.capital'), screenId: 'MOB-12'),
      _LinkRow(label: context.t('mob.prj.list.link.unreported'), screenId: 'MOB-57'),
      _LinkRow(label: context.t('mob.prj.list.link.issues'), screenId: 'MOB-59'),
      const _WorkLinks(),
    ];
    if (shown.isEmpty) {
      // The group of work links can be open, so the page scrolls; the empty state keeps a fixed height under it.
      return ListView(
        children: <Widget>[
          ...header,
          SizedBox(
            height: 360,
            child: EmptyStateView(
              activeFilters: <String>[
                if (filter.query.trim().isNotEmpty) filter.query.trim(),
                if (filter.stage != null) stageLabel(context, filter.stage!),
              ],
              onClearFilters: onClear,
            ),
          ),
        ],
      );
    }
    return ListView.builder(
      itemCount: header.length + shown.length,
      itemBuilder: (BuildContext context, int index) {
        if (index < header.length) return header[index];
        return _ProjectRow(project: shown[index - header.length], asOf: loaded.asOf);
      },
    );
  }
}

class _LinkRow extends StatelessWidget {
  const _LinkRow({required this.label, required this.screenId});

  final String label;
  final String screenId;

  @override
  Widget build(BuildContext context) {
    return TappableRow(
      semanticLabel: label,
      onTap: () => openScreen(context, screenId),
      child: Row(children: <Widget>[Expanded(child: Text(label)), const ExcludeSemantics(child: Icon(Icons.chevron_right))]),
    );
  }
}

/// The words of the row (each a literal key, so the string registry can see it) and the screen it opens, in the order of the work: reports, money, the site, the paperwork of the end, the analysis, the directives, the packages by step (the way in to the progress of each package and to the progress tree).
final List<MapEntry<String Function(BuildContext), String>> kProjectWorkLinks = <MapEntry<String Function(BuildContext), String>>[
  MapEntry<String Function(BuildContext), String>((BuildContext context) => context.t('mob.prj.list.work.report'), 'MOB-13'),
  MapEntry<String Function(BuildContext), String>((BuildContext context) => context.t('mob.prj.list.work.payment'), 'MOB-27'),
  MapEntry<String Function(BuildContext), String>((BuildContext context) => context.t('mob.prj.list.work.treasury'), 'MOB-60'),
  MapEntry<String Function(BuildContext), String>((BuildContext context) => context.t('mob.prj.list.work.contracts'), 'MOB-61'),
  MapEntry<String Function(BuildContext), String>((BuildContext context) => context.t('mob.prj.list.work.issue'), 'MOB-28'),
  MapEntry<String Function(BuildContext), String>((BuildContext context) => context.t('mob.prj.list.work.clearance'), 'MOB-68'),
  MapEntry<String Function(BuildContext), String>((BuildContext context) => context.t('mob.prj.list.work.handover'), 'MOB-66'),
  MapEntry<String Function(BuildContext), String>((BuildContext context) => context.t('mob.prj.list.work.qa'), 'MOB-37'),
  MapEntry<String Function(BuildContext), String>((BuildContext context) => context.t('mob.prj.list.work.findings'), 'MOB-38'),
  MapEntry<String Function(BuildContext), String>((BuildContext context) => context.t('mob.prj.list.work.directives'), 'DIR-06'),
  MapEntry<String Function(BuildContext), String>((BuildContext context) => context.t('mob.prj.list.work.packages'), 'MOB-69'),
  MapEntry<String Function(BuildContext), String>((BuildContext context) => context.t('mob.prj.list.work.vendors'), 'MOB-73'),
];

/// The way in to the screens of the work of the field and of the reports, which have no other entrance: one group, closed until the
/// person opens it, so the list of projects stays the first thing on the page. Each row opens one screen of the Projects tab.
class _WorkLinks extends StatelessWidget {
  const _WorkLinks();

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
        childrenPadding: EdgeInsets.zero,
        title: Text(context.t('mob.prj.list.work.title')),
        children: <Widget>[for (final MapEntry<String Function(BuildContext), String> link in kProjectWorkLinks) _LinkRow(label: link.key(context), screenId: link.value)],
      ),
    );
  }
}

class _ProjectRow extends StatelessWidget {
  const _ProjectRow({required this.project, required this.asOf});

  final ProjectLine project;
  final String? asOf;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String stage = stageLabel(context, project.stage);
    return TappableRow(
      semanticLabel: context.t('mob.prj.list.row.aria', <String, Object>{'code': project.code, 'name': project.name, 'stage': stage}),
      onTap: () => openScreen(context, 'MOB-10', pathSuffix: '/${Uri.encodeComponent(project.id)}'),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('${project.code} · ${project.name}', style: theme.textTheme.bodyLarge),
                Wrap(spacing: MachvonSpace.space8, children: <Widget>[StatusPill(label: stage), if (project.projectGroup != null) StatusPill(label: context.t('mob.prj.list.row.group', <String, Object>{'group': project.projectGroup!}))]),
                Text(context.t('mob.prj.list.row.unit', <String, Object>{'unit': project.unitName}), style: theme.textTheme.bodySmall),
                Text(
                  project.leaderName == null ? context.t('mob.prj.list.row.leaderNone') : context.t('mob.prj.list.row.leader', <String, Object>{'name': project.leaderName!}),
                  style: theme.textTheme.bodySmall,
                ),
                if (project.nationalCode != null) Text(context.t('mob.prj.list.row.national', <String, Object>{'code': project.nationalCode!}), style: theme.textTheme.bodySmall),
                if (asOf != null) Text(context.t('mob.read.asOf.line', <String, Object>{'time': asOfLabel(asOf!)}), style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}
