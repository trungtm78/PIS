import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../project_views/project_models.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
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

class _ProjectsScreen extends StatelessWidget {
  const _ProjectsScreen();

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.clearance.projects.title'),
      body: DataView<ProjectRegister>(
        cacheKey: 'clearance.projects',
        read: (MachvonApiClient client) => readMerged(client, 'get_resources_project', query: <String, Object?>{'limit': 200}),
        parse: parseProjectRegister,
        asOf: (ProjectRegister register) => register.asOf,
        isEmpty: (ProjectRegister register) => register.projects.isEmpty,
        builder: (BuildContext context, Loaded<ProjectRegister> loaded) => ListView(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.all(MachvonSpace.space16),
              child: Text(context.t('mob.clearance.projects.intro'), style: Theme.of(context).textTheme.bodyMedium),
            ),
            for (final ProjectLine project in loaded.value.projects)
              TappableRow(
                semanticLabel: context.t('mob.clearance.projects.row.aria', <String, Object>{'code': project.code, 'name': project.name}),
                onTap: () => openScreen(context, 'MOB-68', query: <String, String>{'project': project.id}, stacked: true),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(project.code, style: Theme.of(context).textTheme.bodyLarge),
                          Text(project.name, style: Theme.of(context).textTheme.bodyMedium),
                        ],
                      ),
                    ),
                    const ExcludeSemantics(child: Icon(Icons.chevron_right)),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _HouseholdsScreen extends StatelessWidget {
  const _HouseholdsScreen({required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.clearance.households.title'),
      body: DataView<HouseholdRegister>(
        cacheKey: 'clearance.households.$projectId',
        read: (MachvonApiClient client) => readHouseholdRegister(client, projectId),
        parse: parseHouseholdRegister,
        asOf: (HouseholdRegister register) => register.asOf,
        isEmpty: (HouseholdRegister register) => register.households.isEmpty,
        builder: (BuildContext context, Loaded<HouseholdRegister> loaded) => ListView(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.all(MachvonSpace.space16),
              child: Text(context.t('mob.clearance.households.privacy'), style: Theme.of(context).textTheme.bodyMedium),
            ),
            for (final Household household in loaded.value.households) _HouseholdRow(projectId: projectId, household: household),
            if (loaded.value.more)
              Padding(
                padding: const EdgeInsets.all(MachvonSpace.space16),
                child: Text(context.t('mob.clearance.households.more'), style: Theme.of(context).textTheme.bodySmall),
              ),
          ],
        ),
      ),
    );
  }
}

class _HouseholdRow extends StatelessWidget {
  const _HouseholdRow({required this.projectId, required this.household});

  final String projectId;
  final Household household;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String status = householdStatusLabel(context, household.status);
    final String parcels = household.parcels.isEmpty
        ? context.t('mob.clearance.households.row.noParcel')
        : context.t('mob.clearance.households.row.parcels', <String, Object>{'codes': household.parcels.map((HouseholdParcel p) => p.parcelCode).join(', ')});
    return TappableRow(
      semanticLabel: context.t('mob.clearance.households.row.aria', <String, Object>{'code': household.code, 'status': status, 'parcels': parcels}),
      onTap: () => openScreen(context, 'MOB-68', query: <String, String>{'project': projectId, 'household': household.id}, stacked: true),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(context.t('mob.clearance.households.row.code', <String, Object>{'code': household.code}), style: theme.textTheme.bodyLarge),
                Text(parcels, style: theme.textTheme.bodyMedium),
                Wrap(
                  spacing: MachvonSpace.space8,
                  children: <Widget>[
                    StatusPill(label: status),
                    if (!household.workable) StatusPill(label: context.t('mob.clearance.households.row.restricted'), warn: true),
                  ],
                ),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
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
    return ScreenFrame(
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
