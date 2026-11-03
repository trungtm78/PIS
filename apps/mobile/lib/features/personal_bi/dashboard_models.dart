import '../read_support/wire.dart';

/// The kinds of tile a dashboard version lays out.
enum WidgetKind { kpi, bar, line, area, pie, table }

const Map<String, WidgetKind> _kindByWire = <String, WidgetKind>{
  'KPI': WidgetKind.kpi,
  'BAR': WidgetKind.bar,
  'LINE': WidgetKind.line,
  'AREA': WidgetKind.area,
  'PIE': WidgetKind.pie,
  'TABLE': WidgetKind.table,
};

/// How the version of the data a dashboard reads is chosen: the newest frozen one, or the ones the author pinned.
enum SnapshotPolicy { latestFrozen, pinned }

enum VersionState { draft, published, superseded }

const Map<String, VersionState> _stateByWire = <String, VersionState>{'DRAFT': VersionState.draft, 'PUBLISHED': VersionState.published, 'SUPERSEDED': VersionState.superseded};

enum Permission { owner, edit, view }

/// One tile of a dashboard version: the metric it shows, the dimension it is cut by (none for a single figure), and where it sits.
final class DashboardWidget {
  const DashboardWidget({required this.id, required this.kind, required this.metricVersionId, required this.row, required this.column, this.title, this.dimension});

  final String id;
  final WidgetKind kind;
  final String metricVersionId;
  final String? title;
  final String? dimension;
  final int row;
  final int column;
}

/// One version of a dashboard, saved whole and never changed.
final class DashboardVersion {
  const DashboardVersion({required this.id, required this.revision, required this.state, required this.widgets, required this.policy, required this.pinnedDatasetVersionIds});

  final String id;
  final int revision;
  final VersionState state;
  final List<DashboardWidget> widgets;
  final SnapshotPolicy policy;
  final List<String> pinnedDatasetVersionIds;
}

/// A dashboard of the library of the reader: theirs, shared with them, or published to the tenant.
final class DashboardSummary {
  const DashboardSummary({required this.id, required this.code, required this.title, required this.mine, this.ownerName, this.currentVersionId, this.metricCount = 0, this.metricsCertified = true, this.permission});

  final String id;
  final String code;
  final String title;
  final bool mine;
  final String? ownerName;
  final String? currentVersionId;
  final int metricCount;

  /// Every metric of the current version is still certified; one that is not shows no figure until it is certified again.
  final bool metricsCertified;
  final Permission? permission;

  bool get hasVersion => currentVersionId != null;
}

const Map<String, Permission> _permissionByWire = <String, Permission>{'OWNER': Permission.owner, 'EDIT': Permission.edit, 'VIEW': Permission.view};

DashboardSummary? parseDashboardSummary(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = filled(row?['code']);
  if (row == null || id == null || code == null) return null;
  final Json? current = asRecord(row['current_version']);
  return DashboardSummary(
    id: id,
    code: code,
    title: text(row['title']) ?? code,
    mine: row['mine'] == true,
    ownerName: filled(asRecord(row['owner'])?['name']),
    currentVersionId: filled(current?['id']),
    metricCount: count(current?['metric_count']),
    metricsCertified: current?['metrics_certified'] != false,
    permission: _permissionByWire[text(row['permission'])],
  );
}

/// The library: the dashboards of the reader, their own first.
final class DashboardLibrary {
  const DashboardLibrary({required this.items, required this.more});

  final List<DashboardSummary> items;
  final bool more;
}

DashboardLibrary? parseDashboardLibrary(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null || row['items'] is! List) return null;
  final List<DashboardSummary> items = <DashboardSummary>[for (final Object? item in listOf(row['items'])) ?parseDashboardSummary(item)];
  // Their own first, then the others, each group in the order the server gave.
  return DashboardLibrary(
    items: <DashboardSummary>[...items.where((DashboardSummary d) => d.mine), ...items.where((DashboardSummary d) => !d.mine)],
    more: filled(row['next_cursor']) != null,
  );
}

DashboardWidget? _parseWidget(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final WidgetKind? kind = _kindByWire[text(row?['kind'])];
  final String? metric = filled(row?['metric_version_id']);
  if (row == null || id == null || kind == null || metric == null) return null;
  final Json? grid = asRecord(row['grid']);
  return DashboardWidget(id: id, kind: kind, metricVersionId: metric, title: filled(row['title']), dimension: filled(row['dimension_code']), row: count(grid?['y']), column: count(grid?['x']));
}

DashboardVersion? _parseVersion(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  if (row == null || id == null) return null;
  final Json? layout = asRecord(row['layout_json']);
  final List<DashboardWidget> widgets = <DashboardWidget>[for (final Object? widget in listOf(layout?['widgets'])) ?_parseWidget(widget)]
    ..sort((DashboardWidget a, DashboardWidget b) => a.row != b.row ? a.row.compareTo(b.row) : a.column.compareTo(b.column));
  return DashboardVersion(
    id: id,
    revision: count(row['revision']),
    state: _stateByWire[text(row['status'])] ?? VersionState.draft,
    widgets: widgets,
    policy: row['dataset_version_policy'] == 'PINNED' ? SnapshotPolicy.pinned : SnapshotPolicy.latestFrozen,
    pinnedDatasetVersionIds: <String>[for (final Object? item in listOf(row['pinned_dataset_version_ids'])) ?filled(item)],
  );
}

/// A dashboard with the version it points to (the "current" one), or none when it has no version yet.
final class DashboardDefinition {
  const DashboardDefinition({required this.summary, this.version});

  final DashboardSummary summary;
  final DashboardVersion? version;
}

DashboardDefinition? parseDashboardDefinition(Object? raw) {
  final DashboardSummary? summary = parseDashboardSummary(raw);
  if (summary == null) return null;
  final Json row = asRecord(raw)!;
  final List<DashboardVersion> versions = <DashboardVersion>[for (final Object? item in listOf(row['versions'])) ?_parseVersion(item)];
  DashboardVersion? current;
  for (final DashboardVersion version in versions) {
    if (version.id == summary.currentVersionId) current = version;
  }
  return DashboardDefinition(summary: summary, version: current);
}

/// The frozen version of a dataset of a period: the snapshot a figure is read from.
final class DatasetVersion {
  const DatasetVersion({required this.id, required this.period});

  final String id;
  final String period;
}

/// The id of the dataset the disbursement figures are built on (the one built from the period snapshots), or null.
String? periodSnapshotDatasetId(Object? raw) {
  for (final Object? item in listOf(asRecord(raw)?['items'])) {
    final Json? dataset = asRecord(item);
    if (dataset != null && dataset['source_kind'] == 'PERIOD_SNAPSHOT') return filled(dataset['id']);
  }
  return null;
}

/// The frozen versions of a dataset, in the order the server gave them (newest first).
List<DatasetVersion> frozenVersions(Object? raw) => <DatasetVersion>[
      for (final Object? item in listOf(asRecord(raw)?['items']))
        if (asRecord(item) case final Json version when version['status'] == 'FROZEN' && filled(version['id']) != null)
          DatasetVersion(id: filled(version['id'])!, period: text(version['as_of_period']) ?? ''),
    ];

/// The snapshot a dashboard version is read from when the person did not name one: the first pinned version, or the newest frozen
/// one. Null when there is none (no period has a frozen version yet).
String? snapshotFor(DashboardVersion version, List<DatasetVersion> frozen) {
  if (version.policy == SnapshotPolicy.pinned) return version.pinnedDatasetVersionIds.isEmpty ? null : version.pinnedDatasetVersionIds.first;
  return frozen.isEmpty ? null : frozen.first.id;
}
