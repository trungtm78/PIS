import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/nav_row.dart';
import '../../../core/widgets/progress.dart';
import '../../../core/widgets/section_panel.dart';
import '../../../core/widgets/sheets.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/work_row.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../project_models.dart';

/// MOB-09: the projects in the scope of the reader, first on the screen. Search and stage filter work on the copy in memory, so they work
/// offline too; the moment the register describes and the note that it is a copy are the one line of context under the title (BR-MOB-01).
/// The shortcuts to the screens of the field and of the reports, which used to stand above the list, are one button in the top bar that
/// opens a sheet.
Widget buildProjectListScreen(BuildContext context, ScreenContext screen) => const ProjectListScreen();

/// What the list is narrowed by, kept for the session so that opening a project and coming back (or leaving the tab and returning to it) finds the search and the
/// stage chip where they were left. A new person or organisation starts with no filter.
class ProjectFilterNotifier extends Notifier<ProjectFilter> {
  @override
  ProjectFilter build() {
    ref.watch(sessionProvider.select((SessionSnapshot session) => (session.tenantId, session.userId)));
    return const ProjectFilter();
  }

  void change(ProjectFilter next) => state = next;
}

final NotifierProvider<ProjectFilterNotifier, ProjectFilter> projectFilterProvider = NotifierProvider<ProjectFilterNotifier, ProjectFilter>(ProjectFilterNotifier.new);

class ProjectListScreen extends ConsumerStatefulWidget {
  const ProjectListScreen({super.key});

  @override
  ConsumerState<ProjectListScreen> createState() => _ProjectListScreenState();
}

class _ProjectListScreenState extends ConsumerState<ProjectListScreen> {
  late final TextEditingController _query;

  @override
  void initState() {
    super.initState();
    _query = TextEditingController(text: ref.read(projectFilterProvider).query);
  }

  ProjectFilter get _filter => ref.watch(projectFilterProvider);

  void _change(ProjectFilter next) => ref.read(projectFilterProvider.notifier).change(next);

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  void _clear() {
    _query.clear();
    _change(const ProjectFilter());
  }

  void _openShortcuts() {
    showActionSheet<void>(
      context,
      title: context.t('mob.prj.list.shortcuts.title'),
      builder: (BuildContext sheet) => _Shortcuts(
        onOpen: (String screenId) {
          Navigator.of(sheet).pop();
          openScreen(context, screenId);
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      root: true,
      title: context.t('mob.prj.list.title'),
      actions: <Widget>[AppBarAction(icon: Icons.grid_view_outlined, label: context.t('mob.prj.list.shortcuts.title'), onPressed: _openShortcuts)],
      body: DataView<ProjectRegister>(
        cacheKey: 'projects.register',
        read: (MachvonApiClient client) => readMerged(client, 'get_resources_project', query: <String, Object?>{'limit': 200}),
        parse: parseProjectRegister,
        asOf: (ProjectRegister register) => register.asOf,
        isEmpty: (ProjectRegister register) => register.projects.isEmpty,
        contextParts: (Loaded<ProjectRegister> loaded) {
          final int total = loaded.value.projects.length;
          final int shown = filterProjects(loaded.value.projects, _filter).length;
          return <String>[
            _filter.isEmpty ? context.t('mob.prj.list.total', <String, Object>{'total': total}) : context.t('mob.prj.list.count', <String, Object>{'shown': shown, 'total': total}),
            if (loaded.value.truncated) context.t('mob.prj.list.truncated'),
          ];
        },
        builder: (BuildContext context, Loaded<ProjectRegister> loaded) {
          final List<ProjectLine> shown = filterProjects(loaded.value.projects, _filter);
          return _ProjectList(
            register: loaded.value,
            shown: shown,
            filter: _filter,
            query: _query,
            onQuery: (String value) => _change(_filter.copyWith(query: value)),
            onStage: (ProjectStage? stage) => _change(_filter.copyWith(stage: stage, clearStage: stage == null)),
            onClear: _clear,
          );
        },
      ),
    );
  }
}

class _ProjectList extends StatelessWidget {
  const _ProjectList({required this.register, required this.shown, required this.filter, required this.query, required this.onQuery, required this.onStage, required this.onClear});

  final ProjectRegister register;
  final List<ProjectLine> shown;
  final ProjectFilter filter;
  final TextEditingController query;
  final ValueChanged<String> onQuery;
  final ValueChanged<ProjectStage?> onStage;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final Map<ProjectStage, int> counts = <ProjectStage, int>{};
    for (final ProjectLine project in register.projects) {
      counts[project.stage] = (counts[project.stage] ?? 0) + 1;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(left: MachvonV2Space.s16, top: MachvonV2Space.s8, right: MachvonV2Space.s16),
          child: TextField(
            controller: query,
            onChanged: onQuery,
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(labelText: context.t('mob.prj.list.search.label'), prefixIcon: const Icon(Icons.search)),
          ),
        ),
        FilterChips<ProjectStage?>(
          selected: filter.stage,
          onChanged: onStage,
          options: <ChipOption<ProjectStage?>>[
            ChipOption<ProjectStage?>(value: null, label: context.t('mob.prj.list.stage.all'), count: register.projects.length),
            for (final ProjectStage stage in ProjectStage.values)
              if (counts.containsKey(stage)) ChipOption<ProjectStage?>(value: stage, label: stageLabel(context, stage), count: counts[stage]),
          ],
        ),
        Expanded(
          child: shown.isEmpty
              ? StateView(
                  kind: StateKind.empty,
                  title: context.t('mob.prj.list.emptyFiltered.title'),
                  body: context.t('mob.prj.list.emptyFiltered.body'),
                  details: <Widget>[
                    Wrap(
                      alignment: WrapAlignment.center,
                      spacing: MachvonV2Space.s8,
                      runSpacing: MachvonV2Space.s8,
                      children: <Widget>[
                        if (filter.query.trim().isNotEmpty) NoteChip(label: filter.query.trim()),
                        if (filter.stage != null) NoteChip(label: stageLabel(context, filter.stage!)),
                      ],
                    ),
                  ],
                  actionLabel: context.t('mob.states.empty.clearFilters.action'),
                  onAction: onClear,
                )
              : ListView.builder(
                  itemCount: shown.length,
                  itemBuilder: (BuildContext context, int index) => _ProjectRow(project: shown[index], dividerAbove: index > 0),
                ),
        ),
      ],
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

/// The content of the shortcut sheet: the four views over all the projects (the map, the capital plan, the projects that have not reported,
/// the issues of the week) and, under their own heading, the screens of the work of the field and of the reports, which have no other
/// entrance. Each row opens one screen of the Projects tab.
class _Shortcuts extends StatelessWidget {
  const _Shortcuts({required this.onOpen});

  final ValueChanged<String> onOpen;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        NavRow(label: context.t('mob.prj.list.link.map'), icon: Icons.map_outlined, onTap: () => onOpen('MOB-11')),
        NavRow(label: context.t('mob.prj.list.link.capital'), icon: Icons.account_balance_outlined, onTap: () => onOpen('MOB-12'), dividerAbove: true),
        NavRow(label: context.t('mob.prj.list.link.unreported'), icon: Icons.assignment_late_outlined, onTap: () => onOpen('MOB-57'), dividerAbove: true),
        NavRow(label: context.t('mob.prj.list.link.issues'), icon: Icons.report_problem_outlined, onTap: () => onOpen('MOB-59'), dividerAbove: true),
        const SizedBox(height: MachvonV2Space.s12),
        GroupHeader(title: context.t('mob.prj.list.work.title'), count: kProjectWorkLinks.length),
        for (int index = 0; index < kProjectWorkLinks.length; index += 1)
          NavRow(label: kProjectWorkLinks[index].key(context), onTap: () => onOpen(kProjectWorkLinks[index].value), dividerAbove: index > 0),
      ],
    );
  }
}

class _ProjectRow extends StatelessWidget {
  const _ProjectRow({required this.project, required this.dividerAbove});

  final ProjectLine project;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final String stage = stageLabel(context, project.stage);
    final MachvonV2Text text = context.v2text;
    final double? progress = project.progress;
    final Widget row = WorkRow(
      title: '${project.code} · ${project.name}',
      subtitle: <String>[project.unitName, if (project.leaderName != null) context.t('mob.prj.list.row.leader', <String, Object>{'name': project.leaderName!})].join(' · '),
      trailing: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          StatusPill(label: stage),
          if (project.projectGroup != null)
            Padding(
              padding: const EdgeInsets.only(top: MachvonV2Space.s4),
              child: Text(context.t('mob.prj.list.row.group', <String, Object>{'group': project.projectGroup!}), style: text.caption),
            ),
        ],
      ),
      semanticLabel: context.t('mob.prj.list.row.aria', <String, Object>{'code': project.code, 'name': project.name, 'stage': stage}),
      onTap: () => openScreen(context, 'MOB-10', pathSuffix: '/${Uri.encodeComponent(project.id)}'),
      dividerAbove: dividerAbove,
    );
    // The bar of a project that has a progress to show (the register gives none yet): under the row, aligned with its text.
    if (progress == null) return row;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        row,
        Padding(
          padding: const EdgeInsets.only(left: MachvonV2Space.s16, right: MachvonV2Space.s16, bottom: MachvonV2Space.s12),
          child: ProgressMeter(value: progress),
        ),
      ],
    );
  }
}
