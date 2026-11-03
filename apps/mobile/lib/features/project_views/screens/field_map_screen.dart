import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/state/empty_state_view.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../map_models.dart';
import '../project_models.dart';

/// How many project views are read at a time.
const int mapReadConcurrency = 8;

/// MOB-11: the projects of the reader on the field map. The API holds no coordinates for a project yet and the map tile
/// provider is not chosen, so the screen draws no basemap and downloads no tile ([MapTilePolicy]): it places each project
/// under the area it pins, says how every position was fixed, and lists the projects that pin no area apart.
Widget buildFieldMapScreen(BuildContext context, ScreenContext screen) => const FieldMapScreen();

class FieldMapScreen extends StatefulWidget {
  const FieldMapScreen({super.key});

  @override
  State<FieldMapScreen> createState() => _FieldMapScreenState();
}

class _FieldMapScreenState extends State<FieldMapScreen> {
  MapFilter _filter = const MapFilter();

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.prj.map.title'),
      body: DataView<MapData>(
        cacheKey: 'projects.map',
        read: _read,
        parse: parseMapData,
        asOf: (MapData map) => map.asOf,
        isEmpty: (MapData map) => map.projects.isEmpty,
        builder: (BuildContext context, Loaded<MapData> loaded) {
          final List<MapProject> shown = filterMap(loaded.value.projects, _filter);
          return ListView(
            padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.all(MachvonSpace.space16),
                child: Text(context.t('mob.prj.map.tiles.note'), style: Theme.of(context).textTheme.bodySmall),
              ),
              _Filters(
                map: loaded.value,
                filter: _filter,
                onStage: (ProjectStage? stage) => setState(() => _filter = MapFilter(stage: stage, sectorKey: _filter.sectorKey)),
                onSector: (String? key) => setState(() => _filter = MapFilter(stage: _filter.stage, sectorKey: key)),
              ),
              if (loaded.value.truncated)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
                  child: Text(context.t('mob.prj.map.truncated', <String, Object>{'count': maxMapProjects}), style: Theme.of(context).textTheme.bodySmall),
                ),
              if (shown.isEmpty)
                SizedBox(
                  height: 320,
                  child: EmptyStateView(onClearFilters: () => setState(() => _filter = const MapFilter()), activeFilters: <String>[
                    if (_filter.stage != null) stageLabel(context, _filter.stage!),
                    if (_filter.sectorKey != null) _filter.sectorKey!,
                  ]),
                )
              else
                for (final AreaCluster cluster in clustersOf(shown)) _ClusterCard(cluster: cluster),
            ],
          );
        },
      ),
    );
  }

  /// The register, then each project (up to [maxMapProjects]) for the area and the sector it pins, a few at a time. A read
  /// that fails fails the whole placing: a project is never put in a wrong area.
  static Future<Object?> _read(MachvonApiClient client) async {
    final Map<String, Object?> register = await readMerged(client, 'get_resources_project', query: <String, Object?>{'limit': 200});
    final List<Object?> lines = (register['items'] as List<Object?>?) ?? const <Object?>[];
    final List<Object?> shown = lines.take(maxMapProjects).toList();
    final List<Object?> views = <Object?>[];
    for (int from = 0; from < shown.length; from += mapReadConcurrency) {
      final Iterable<Object?> group = shown.skip(from).take(mapReadConcurrency);
      views.addAll(await Future.wait(<Future<Object?>>[
        for (final Object? line in group) client.execute('get_resources_project_id', path: <String, Object?>{'id': (line as Map<String, Object?>)['id']}),
      ]));
    }
    return <String, Object?>{'projects': views, 'truncated': lines.length > maxMapProjects || register['next_cursor'] != null, 'as_of': register['as_of']};
  }
}

class _Filters extends StatelessWidget {
  const _Filters({required this.map, required this.filter, required this.onStage, required this.onSector});

  final MapData map;
  final MapFilter filter;
  final ValueChanged<ProjectStage?> onStage;
  final ValueChanged<String?> onSector;

  @override
  Widget build(BuildContext context) {
    final List<({String key, String label})> sectors = map.sectors;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          DropdownButtonFormField<ProjectStage?>(
            initialValue: filter.stage,
            isExpanded: true,
            decoration: InputDecoration(labelText: context.t('mob.prj.list.stage.label')),
            items: <DropdownMenuItem<ProjectStage?>>[
              DropdownMenuItem<ProjectStage?>(child: Text(context.t('mob.prj.map.filter.all'))),
              for (final ProjectStage stage in ProjectStage.values) DropdownMenuItem<ProjectStage?>(value: stage, child: Text(stageLabel(context, stage))),
            ],
            onChanged: onStage,
          ),
          if (sectors.isNotEmpty) ...<Widget>[
            const SizedBox(height: MachvonSpace.space12),
            DropdownButtonFormField<String?>(
              initialValue: filter.sectorKey,
              isExpanded: true,
              decoration: InputDecoration(labelText: context.t('mob.prj.map.filter.sector')),
              items: <DropdownMenuItem<String?>>[
                DropdownMenuItem<String?>(child: Text(context.t('mob.prj.map.filter.all'))),
                for (final ({String key, String label}) sector in sectors) DropdownMenuItem<String?>(value: sector.key, child: Text(sector.label)),
              ],
              onChanged: onSector,
            ),
          ],
        ],
      ),
    );
  }
}

class _ClusterCard extends StatelessWidget {
  const _ClusterCard({required this.cluster});

  final AreaCluster cluster;

  @override
  Widget build(BuildContext context) {
    final String title = cluster.isUnplaced
        ? context.t('mob.prj.map.cluster.unplaced', <String, Object>{'count': cluster.projects.length})
        : context.t('mob.prj.map.cluster.title', <String, Object>{'area': cluster.label, 'count': cluster.projects.length});
    return SectionCard(
      title: title,
      children: <Widget>[for (final MapProject project in cluster.projects) _ProjectRow(project: project)],
    );
  }
}

class _ProjectRow extends StatelessWidget {
  const _ProjectRow({required this.project});

  final MapProject project;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return TappableRow(
      semanticLabel: '${project.code} ${project.name}, ${locationLabel(context, project.source)}',
      onTap: () => openScreen(context, 'MOB-10', pathSuffix: '/${Uri.encodeComponent(project.id)}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text('${project.code} · ${project.name}', style: theme.textTheme.bodyLarge),
          Text('${stageLabel(context, project.stage)} · ${locationLabel(context, project.source)}', style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }
}
