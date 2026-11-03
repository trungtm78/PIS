import '../read_support/wire.dart';
import 'project_models.dart';

/// The most projects the map reads: each one is read for the area it pins, so a register of thousands is not asked for in
/// full on a phone. The screen says when there are more.
const int maxMapProjects = 100;

/// How the position of a project was fixed. The API holds no coordinates for a project yet, so every project is placed by
/// the area it pins; when coordinates arrive a position given by a person carries the label "entered by hand" (BR-MOB-06)
/// and one taken from the device the label "device".
enum LocationSource { area, device, manual }

/// The policy of the map tiles of this slice (TK-MOB-010-2). The domestic tile provider is not chosen yet, so the screen
/// downloads and stores no tile at all: it draws no basemap, offline or online, and the projects are listed by area.
/// Changing this is a decision of the product owner and of Security (what a cached tile reveals about where officers work).
abstract final class MapTilePolicy {
  static const bool downloadsTiles = false;
  static const bool storesTilesOffline = false;
}

/// A project placed on the map.
final class MapProject {
  const MapProject({
    required this.id,
    required this.code,
    required this.name,
    required this.stage,
    required this.areaKey,
    required this.areaLabel,
    this.sectorKey,
    this.sectorLabel,
    this.source = LocationSource.area,
  });

  final String id;
  final String code;
  final String name;
  final ProjectStage stage;

  /// The key of the area entry the project pins; empty when it pins none.
  final String areaKey;
  final String areaLabel;
  final String? sectorKey;
  final String? sectorLabel;
  final LocationSource source;
}

/// The projects of the register with the area and the sector each one pins, and the moment they describe.
final class MapData {
  const MapData({required this.projects, required this.truncated, this.asOf});

  final List<MapProject> projects;

  /// The register had more projects than the map reads.
  final bool truncated;
  final String? asOf;

  /// The sectors among the projects, once each, in order of name.
  List<({String key, String label})> get sectors {
    final Map<String, String> seen = <String, String>{};
    for (final MapProject project in projects) {
      final String? key = project.sectorKey;
      if (key != null) seen[key] = project.sectorLabel ?? key;
    }
    final List<({String key, String label})> list = <({String key, String label})>[for (final MapEntry<String, String> entry in seen.entries) (key: entry.key, label: entry.value)];
    list.sort((({String key, String label}) a, ({String key, String label}) b) => plainText(a.label).compareTo(plainText(b.label)));
    return list;
  }
}

/// The map from `{projects: [project view, ...], truncated, as_of}`, or null when it is not one.
MapData? parseMapData(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['projects'] is! List) return null;
  final List<MapProject> projects = <MapProject>[];
  for (final Object? item in listOf(body['projects'])) {
    final ProjectLine? line = parseProjectLine(item);
    if (line == null) continue;
    final Json? row = asRecord(item);
    final Json? area = asRecord(row?['area']);
    final Json? sector = asRecord(row?['sector']);
    projects.add(MapProject(
      id: line.id,
      code: line.code,
      name: line.name,
      stage: line.stage,
      areaKey: filled(area?['business_key']) ?? '',
      areaLabel: filled(area?['label']) ?? filled(area?['business_key']) ?? '',
      sectorKey: filled(sector?['business_key']),
      sectorLabel: filled(sector?['label']),
    ));
  }
  return MapData(projects: projects, truncated: body['truncated'] == true, asOf: filled(body['as_of']));
}

/// What the map is narrowed by.
final class MapFilter {
  const MapFilter({this.stage, this.sectorKey});

  final ProjectStage? stage;
  final String? sectorKey;

  bool get isEmpty => stage == null && sectorKey == null;
}

/// The projects a filter leaves.
List<MapProject> filterMap(List<MapProject> projects, MapFilter filter) => <MapProject>[
      for (final MapProject project in projects)
        if ((filter.stage == null || project.stage == filter.stage) && (filter.sectorKey == null || project.sectorKey == filter.sectorKey)) project,
    ];

/// The projects of one area.
final class AreaCluster {
  const AreaCluster({required this.key, required this.label, required this.projects});

  final String key;
  final String label;
  final List<MapProject> projects;

  /// The projects that pin no area, listed apart and never put in the middle of a province.
  bool get isUnplaced => key.isEmpty;
}

/// The projects under the areas they pin: areas in order of name, projects in order of code, the unplaced ones last.
List<AreaCluster> clustersOf(List<MapProject> projects) {
  final Map<String, List<MapProject>> byArea = <String, List<MapProject>>{};
  final Map<String, String> labels = <String, String>{};
  for (final MapProject project in projects) {
    byArea.putIfAbsent(project.areaKey, () => <MapProject>[]).add(project);
    labels[project.areaKey] = project.areaLabel;
  }
  final List<AreaCluster> clusters = <AreaCluster>[
    for (final MapEntry<String, List<MapProject>> entry in byArea.entries)
      AreaCluster(
        key: entry.key,
        label: labels[entry.key] ?? entry.key,
        projects: <MapProject>[...entry.value]..sort((MapProject a, MapProject b) => a.code.compareTo(b.code)),
      ),
  ];
  clusters.sort((AreaCluster a, AreaCluster b) {
    if (a.isUnplaced != b.isUnplaced) return a.isUnplaced ? 1 : -1;
    return plainText(a.label).compareTo(plainText(b.label));
  });
  return clusters;
}
