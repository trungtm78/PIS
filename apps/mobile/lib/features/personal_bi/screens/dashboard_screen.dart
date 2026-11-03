import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../command_support/command_flow.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../../read_support/wire.dart';
import '../bi_query_service.dart';
import '../dashboard_models.dart';
import '../personal_bi_labels.dart';
import '../query_models.dart';
import '../tile_card.dart';

/// MOB-40: the personal BI dashboard. Without a parameter it lists the dashboards of the reader (theirs first, then those shared
/// with them or published to the tenant); with `?dashboard=<id>` it opens one, and `&snapshot=<id>` opens it over the snapshot that
/// was named (a link from a figure keeps the snapshot it came from).
///
/// Every tile of a dashboard is read over one snapshot, so the figures of the screen are all of one moment. When a newer snapshot of
/// the period was frozen since, the screen keeps showing the one that is open and says so, with the id of it; the person chooses to
/// renew, and only then are the tiles read again over the newer one. The figures are the same as the web: the same operations, the
/// same scope, decided by the server.
Widget buildDashboardScreen(BuildContext context, ScreenContext screen) {
  final String? id = screen.queryParameters['dashboard'];
  return id == null || id.isEmpty ? const _Library() : _DashboardPage(dashboardId: id, snapshotId: screen.queryParameters['snapshot']);
}

class _Library extends StatelessWidget {
  const _Library();

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.pbi.library.title'),
      body: DataView<DashboardLibrary>(
        cacheKey: 'pbi.library',
        read: (MachvonApiClient client) => readMerged(client, 'listDashboards', query: <String, Object?>{'limit': 50}, maxPages: 4),
        parse: parseDashboardLibrary,
        isEmpty: (DashboardLibrary library) => library.items.isEmpty,
        builder: (BuildContext context, Loaded<DashboardLibrary> loaded) => _LibraryList(library: loaded.value),
      ),
    );
  }
}

class _LibraryList extends StatelessWidget {
  const _LibraryList({required this.library});

  final DashboardLibrary library;

  @override
  Widget build(BuildContext context) {
    return ListView(
      children: <Widget>[
        Padding(padding: const EdgeInsets.all(MachvonSpace.space16), child: Text(context.t('mob.pbi.library.intro'), style: Theme.of(context).textTheme.bodyMedium)),
        for (final DashboardSummary dashboard in library.items) _LibraryRow(dashboard: dashboard),
        if (library.more) Padding(padding: const EdgeInsets.all(MachvonSpace.space16), child: Text(context.t('mob.pbi.library.more'), style: Theme.of(context).textTheme.bodySmall)),
      ],
    );
  }
}

class _LibraryRow extends StatelessWidget {
  const _LibraryRow({required this.dashboard});

  final DashboardSummary dashboard;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String owner = dashboard.mine ? context.t('mob.pbi.library.mine') : context.t('mob.pbi.library.owner', <String, Object>{'name': dashboard.ownerName ?? ''});
    final String version = dashboard.hasVersion ? context.t('mob.pbi.library.version', <String, Object>{'count': dashboard.metricCount}) : context.t('mob.pbi.library.noVersion');
    return TappableRow(
      semanticLabel: context.t('mob.pbi.library.row.aria', <String, Object>{'title': dashboard.title, 'owner': owner, 'version': version}),
      onTap: dashboard.hasVersion ? () => openScreen(context, 'MOB-40', query: <String, String>{'dashboard': dashboard.id}, stacked: true) : null,
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(dashboard.title, style: theme.textTheme.bodyLarge),
                Text(owner, style: theme.textTheme.bodySmall),
                Wrap(
                  spacing: MachvonSpace.space8,
                  children: <Widget>[
                    StatusPill(label: version),
                    if (dashboard.hasVersion) StatusPill(label: dashboard.metricsCertified ? context.t('mob.pbi.library.certified') : context.t('mob.pbi.library.notCertified'), warn: !dashboard.metricsCertified),
                  ],
                ),
              ],
            ),
          ),
          if (dashboard.hasVersion) const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}

/// The dashboard, the version it points to, and the frozen versions of the data when the policy asks for the newest.
final class DashboardPageData {
  const DashboardPageData({required this.definition, required this.frozen});

  final DashboardDefinition definition;
  final List<DatasetVersion> frozen;
}

DashboardPageData? parseDashboardPage(Object? raw) {
  final Json? row = asRecord(raw);
  final DashboardDefinition? definition = parseDashboardDefinition(row?['dashboard']);
  if (definition == null) return null;
  return DashboardPageData(definition: definition, frozen: frozenVersions(row?['versions']));
}

/// The reads of a dashboard. The versions of the data are read next to the dashboard (not after it) when the person did not name a
/// snapshot, so the tiles can start after one round of requests; a pinned dashboard ignores them.
Future<Object?> readDashboardPage(MachvonApiClient client, String dashboardId, {required bool snapshotNamed}) async {
  final Future<Object?> dashboard = client.getDashboard(id: dashboardId);
  final Future<Object?>? datasets = snapshotNamed ? null : client.listBiDatasets();
  final Object? definition = await dashboard;
  final Object? datasetList = await datasets;
  final String? datasetId = datasetList == null ? null : periodSnapshotDatasetId(datasetList);
  final Object? versions = datasetId == null ? null : await client.listBiDatasetVersions(id: datasetId);
  return <String, Object?>{'dashboard': definition, 'versions': versions};
}

class _DashboardPage extends StatelessWidget {
  const _DashboardPage({required this.dashboardId, this.snapshotId});

  final String dashboardId;
  final String? snapshotId;

  @override
  Widget build(BuildContext context) {
    final bool named = snapshotId != null && snapshotId!.isNotEmpty;
    return ScreenFrame(
      title: context.t('mob.pbi.title'),
      body: DataView<DashboardPageData>(
        cacheKey: 'pbi.dashboard.$dashboardId.${named ? snapshotId : 'policy'}',
        read: (MachvonApiClient client) => readDashboardPage(client, dashboardId, snapshotNamed: named),
        parse: parseDashboardPage,
        builder: (BuildContext context, Loaded<DashboardPageData> loaded) => _DashboardBody(dashboardId: dashboardId, page: loaded.value, named: named ? snapshotId : null, fromCopy: loaded.fromCache),
      ),
    );
  }
}

class _DashboardBody extends ConsumerStatefulWidget {
  const _DashboardBody({required this.dashboardId, required this.page, required this.named, required this.fromCopy});

  final String dashboardId;
  final DashboardPageData page;
  final String? named;
  final bool fromCopy;

  @override
  ConsumerState<_DashboardBody> createState() => _DashboardBodyState();
}

class _DashboardBodyState extends ConsumerState<_DashboardBody> {
  String? _snapshot;
  final Map<String, QueryResult> _results = <String, QueryResult>{};
  bool _renewing = false;
  Object? _renewFailure;
  String? _renewedTo;
  late final BiQueryService _service = BiQueryService(client: ref.read(apiClientProvider), polling: ref.read(jobPollingProvider), cancelled: () => !mounted);

  @override
  void initState() {
    super.initState();
    final DashboardVersion? version = widget.page.definition.version;
    _snapshot = widget.named ?? (version == null ? null : snapshotFor(version, widget.page.frozen));
  }

  void _onResult(String widgetId, QueryResult result) {
    if (!mounted) return;
    setState(() => _results[widgetId] = result);
  }

  /// The first answer that says newer data exists: its token is the one the renewal is asked with.
  QueryResult? get _newer {
    for (final QueryResult result in _results.values) {
      if (result.newDataAvailable) return result;
    }
    return null;
  }

  Future<void> _renew(String drillToken) async {
    if (_renewing) return;
    setState(() {
      _renewing = true;
      _renewFailure = null;
      _renewedTo = null;
    });
    try {
      final RenewedContext renewed = await _service.renew(drillToken);
      if (!mounted) return;
      setState(() {
        _snapshot = renewed.snapshotId;
        _results.clear();
        _renewedTo = renewed.snapshotId;
        _renewing = false;
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _renewFailure = error;
        _renewing = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final DashboardDefinition definition = widget.page.definition;
    final DashboardVersion? version = definition.version;
    final String? snapshot = _snapshot;
    final QueryResult? newer = _newer;
    final bool offline = ref.watch(reachabilityProvider) == Reachability.offline;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        _Header(definition: definition, snapshot: snapshot, period: _results.values.isEmpty ? null : _results.values.first.asOfPeriod),
        if (!definition.summary.metricsCertified) Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space4), child: GateNote(text: context.t('mob.pbi.dashboard.notCertified'))),
        if (newer != null)
          _NewDataBanner(
            shown: newer.snapshotId,
            newer: newer.newerSnapshotId,
            busy: _renewing,
            blockedReason: offline || widget.fromCopy ? context.t('mob.pbi.renew.offline') : null,
            onRenew: () => _renew(newer.drillToken),
          ),
        if (_renewFailure != null) OutcomeCard(title: queryProblemText(context, problemOfFailure(_renewFailure!)), code: problemCodeOf(_renewFailure!)),
        if (_renewedTo != null) OutcomeCard(title: context.t('mob.pbi.renew.done', <String, Object>{'snapshot': shortId(_renewedTo!)})),
        if (version == null) Padding(padding: const EdgeInsets.all(MachvonSpace.space16), child: Text(context.t('mob.pbi.dashboard.noVersion')))
        else if (version.widgets.isEmpty) Padding(padding: const EdgeInsets.all(MachvonSpace.space16), child: Text(context.t('mob.pbi.dashboard.noWidgets')))
        else if (snapshot == null) Padding(padding: const EdgeInsets.all(MachvonSpace.space16), child: Text(context.t('mob.pbi.dashboard.noSnapshot')))
        else
          for (final DashboardWidget tile in version.widgets)
            TileCard(key: ValueKey<String>('${tile.id}|$snapshot'), dashboardId: widget.dashboardId, tile: tile, snapshotId: snapshot, onResult: _onResult, onRenew: _renew),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.definition, required this.snapshot, required this.period});

  final DashboardDefinition definition;
  final String? snapshot;
  final String? period;

  @override
  Widget build(BuildContext context) {
    final DashboardVersion? version = definition.version;
    return SectionCard(
      title: definition.summary.title,
      children: <Widget>[
        FactLine(label: context.t('mob.pbi.header.code.label'), value: definition.summary.code),
        if (version != null) FactLine(label: context.t('mob.pbi.header.version.label'), value: context.t('mob.pbi.header.version.value', <String, Object>{'revision': version.revision, 'state': _stateLabel(context, version.state)})),
        if (snapshot != null) FactLine(label: context.t('mob.pbi.header.snapshot.label'), value: period == null ? shortId(snapshot!) : context.t('mob.pbi.header.snapshot.value', <String, Object>{'snapshot': shortId(snapshot!), 'period': period!})),
      ],
    );
  }

  String _stateLabel(BuildContext context, VersionState state) {
    switch (state) {
      case VersionState.draft:
        return context.t('mob.pbi.version.draft');
      case VersionState.published:
        return context.t('mob.pbi.version.published');
      case VersionState.superseded:
        return context.t('mob.pbi.version.superseded');
    }
  }
}

/// Newer data exists for the period of the snapshot that is open: the screen says so and goes on showing that snapshot until the
/// person renews. A renewal is a command, so it needs a connection.
class _NewDataBanner extends StatelessWidget {
  const _NewDataBanner({required this.shown, required this.newer, required this.busy, required this.blockedReason, required this.onRenew});

  final String shown;
  final String? newer;
  final bool busy;
  final String? blockedReason;
  final VoidCallback onRenew;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      color: MachvonColors.selected,
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Semantics(
          liveRegion: true,
          container: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(context.t('mob.pbi.banner.newData.title'), key: const ValueKey<String>('new-data'), style: Theme.of(context).textTheme.titleSmall),
              Text(context.t('mob.pbi.banner.newData.body', <String, Object>{'shown': shortId(shown), 'newer': newer == null ? '' : shortId(newer!)})),
              const SizedBox(height: MachvonSpace.space8),
              if (blockedReason != null) GateNote(text: blockedReason!),
              FilledButton(onPressed: busy || blockedReason != null ? null : onRenew, child: Text(busy ? context.t('mob.pbi.renew.busy.label') : context.t('mob.pbi.renew.action'))),
            ],
          ),
        ),
      ),
    );
  }
}
