import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/status_pill.dart';
import '../../../core/widgets/work_row.dart';
import '../../project_views/project_models.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/wire.dart';
import '../clearance_models.dart';
import '../clearance_support.dart';
import 'household_task.dart';

/// MOB-68: the field work of the land-clearance officer. Three views of one screen, by what the location names:
///
///  * `/projects/mob-68`: the projects, to choose the one to work in;
///  * `?project=<id>`: the households of the project in the scope of the officer, by code;
///  * `?project=<id>&household=<id>`: one household's task: its parcels, the inventory counted, the answer of the household, a new
///    count (kept on the phone when there is no network and sent when there is one) and the photos of the site.
///
/// The phone keeps the household by its code and its parcels and nothing that identifies a person: the reader cuts every answer down
/// before it is copied (see `minimiseHousehold`), and the identity of a household is only opened on the web by whoever holds the right.
Widget buildClearanceScreen(BuildContext context, ScreenContext screen) {
  final String? project = screen.queryParameters['project'];
  final String? household = screen.queryParameters['household'];
  if (project == null || project.isEmpty) return const _ProjectsScreen();
  if (household == null || household.isEmpty) return _HouseholdsScreen(projectId: project);
  return _TaskScreen(projectId: project, householdId: household);
}

/// The households of a project, reduced at once: the answer is cut down before it is returned, so before it is copied for the offline view.
Future<Json> readHouseholdRegister(MachvonApiClient client, String projectId) async =>
    minimiseRegister(await readMerged(client, 'listAffectedHouseholds', query: <String, Object?>{'project_id': projectId, 'limit': 200}, maxPages: 5));

/// The task of one household. The inventory is read first: for a household outside the scope of the officer the server answers 404
/// `RESOURCE_NOT_FOUND`, and nothing of it is described (UAT-PLAN-39).
Future<Object?> readHouseholdTask(MachvonApiClient client, String projectId, String householdId) async {
  final Json records = await readMerged(client, 'listInventoryRecords', query: <String, Object?>{'household_id': householdId, 'limit': 200});
  final Json register = await readHouseholdRegister(client, projectId);
  Json? household;
  for (final Object? item in listOf(register['items'])) {
    if (asRecord(item)?['id'] == householdId) household = asRecord(item);
  }
  return <String, Object?>{
    'household': household,
    'records': <String, Object?>{'items': <Object?>[for (final Object? item in listOf(records['items'])) ?minimiseRecord(item)], 'next_cursor': records['next_cursor']},
    'as_of': filled(records['as_of']) ?? filled(register['as_of']),
  };
}

/// An empty list is drawn here and not by the read, so the state carries the action that may fix it (read again).
Widget _empty(BuildContext context, VoidCallback reload) => StateView(kind: StateKind.empty, actionLabel: context.t('mob.states.retry.action'), onAction: reload);

class _ProjectsScreen extends StatefulWidget {
  const _ProjectsScreen();

  @override
  State<_ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends State<_ProjectsScreen> {
  int _reload = 0;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.clearance.projects.title'),
      body: DataView<ProjectRegister>(
        cacheKey: 'clearance.projects',
        reloadKey: _reload,
        read: (MachvonApiClient client) => readMerged(client, 'get_resources_project', query: <String, Object?>{'limit': 200}),
        parse: parseProjectRegister,
        asOf: (ProjectRegister register) => register.asOf,
        builder: (BuildContext context, Loaded<ProjectRegister> loaded) {
          final List<ProjectLine> projects = loaded.value.projects;
          if (projects.isEmpty) return _empty(context, () => setState(() => _reload += 1));
          return ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.all(MachvonV2Space.s16),
                child: Text(context.t('mob.clearance.projects.intro'), style: context.v2text.body.copyWith(color: context.v2.palette.ink2)),
              ),
              for (int index = 0; index < projects.length; index += 1)
                WorkRow(
                  title: projects[index].code,
                  subtitle: projects[index].name,
                  trailing: const Align(alignment: Alignment.centerRight, child: ExcludeSemantics(child: Icon(Icons.chevron_right))),
                  dividerAbove: index > 0,
                  semanticLabel: context.t('mob.clearance.projects.row.aria', <String, Object>{'code': projects[index].code, 'name': projects[index].name}),
                  onTap: () => openScreen(context, 'MOB-68', query: <String, String>{'project': projects[index].id}, stacked: true),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _HouseholdsScreen extends StatefulWidget {
  const _HouseholdsScreen({required this.projectId});

  final String projectId;

  @override
  State<_HouseholdsScreen> createState() => _HouseholdsScreenState();
}

class _HouseholdsScreenState extends State<_HouseholdsScreen> {
  int _reload = 0;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.clearance.households.title'),
      body: DataView<HouseholdRegister>(
        cacheKey: 'clearance.households.${widget.projectId}',
        reloadKey: _reload,
        read: (MachvonApiClient client) => readHouseholdRegister(client, widget.projectId),
        parse: parseHouseholdRegister,
        asOf: (HouseholdRegister register) => register.asOf,
        builder: (BuildContext context, Loaded<HouseholdRegister> loaded) {
          if (loaded.value.households.isEmpty) return _empty(context, () => setState(() => _reload += 1));
          // The households are grouped by where their work stands, in the order of the life of a household, so the officer finds those still to count first.
          final List<Widget> rows = <Widget>[];
          for (final String status in householdStatuses) {
            final List<Household> group = <Household>[for (final Household household in loaded.value.households) if (household.status == status) household];
            if (group.isEmpty) continue;
            rows.add(GroupHeader(title: householdStatusLabel(context, status), count: group.length));
            for (int index = 0; index < group.length; index += 1) {
              rows.add(_HouseholdRow(projectId: widget.projectId, household: group[index], dividerAbove: index > 0));
            }
          }
          return ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.all(MachvonV2Space.s16),
                child: Text(context.t('mob.clearance.households.privacy'), style: context.v2text.body.copyWith(color: context.v2.palette.ink2)),
              ),
              ...rows,
              if (loaded.value.more)
                Padding(
                  padding: const EdgeInsets.all(MachvonV2Space.s16),
                  child: Text(context.t('mob.clearance.households.more'), style: context.v2text.caption),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _HouseholdRow extends StatelessWidget {
  const _HouseholdRow({required this.projectId, required this.household, required this.dividerAbove});

  final String projectId;
  final Household household;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final String status = householdStatusLabel(context, household.status);
    final String parcels = household.parcels.isEmpty
        ? context.t('mob.clearance.households.row.noParcel')
        : context.t('mob.clearance.households.row.parcels', <String, Object>{'codes': household.parcels.map((HouseholdParcel p) => p.parcelCode).join(', ')});
    return WorkRow(
      title: context.t('mob.clearance.households.row.code', <String, Object>{'code': household.code}),
      subtitle: parcels,
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.end,
        children: <Widget>[
          if (!household.workable) Flexible(child: StatusPill(label: context.t('mob.clearance.households.row.restricted'), tone: MachvonTone.warning)),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
      dividerAbove: dividerAbove,
      semanticLabel: context.t('mob.clearance.households.row.aria', <String, Object>{'code': household.code, 'status': status, 'parcels': parcels}),
      onTap: () => openScreen(context, 'MOB-68', query: <String, String>{'project': projectId, 'household': household.id}, stacked: true),
    );
  }
}

class _TaskScreen extends StatefulWidget {
  const _TaskScreen({required this.projectId, required this.householdId});

  final String projectId;
  final String householdId;

  @override
  State<_TaskScreen> createState() => _TaskScreenState();
}

class _TaskScreenState extends State<_TaskScreen> {
  int _changed = 0;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.clearance.task.title'),
      body: DataView<HouseholdTask>(
        cacheKey: 'clearance.task.${widget.householdId}',
        reloadKey: _changed,
        read: (MachvonApiClient client) => readHouseholdTask(client, widget.projectId, widget.householdId),
        parse: parseHouseholdTask,
        asOf: (HouseholdTask task) => task.asOf,
        builder: (BuildContext context, Loaded<HouseholdTask> loaded) => HouseholdTaskBody(task: loaded.value, fromCopy: loaded.fromCache, onChanged: () => setState(() => _changed += 1)),
      ),
    );
  }
}
