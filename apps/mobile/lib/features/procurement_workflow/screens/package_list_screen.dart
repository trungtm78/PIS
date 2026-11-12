import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/state_view.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../navigation.dart';
import '../node_stats.dart';
import '../node_stats_card.dart';
import '../widgets.dart';
import '../workflow_models.dart';

/// MOB-69: the packages by step. A selector of the selection method and a row of chips, one for each step with its count (read from the
/// process tree, the same counts as the web), then the packages of the chosen step: code, project, price, days in the step, holder, late.
/// It only reads. `?node=` opens it on a node of the tree (a step, a state of a step, completed...).
Widget buildPackageListScreen(BuildContext context, ScreenContext screen) =>
    PackageListScreen(initialNode: screen.queryParameters['node']);

/// The most rows one page of the list asks for.
const int kPrcPageSize = 30;

/// What the screen reads: the tree (for the chips), the node that is shown and its first page.
final class PrcListData {
  const PrcListData({
    required this.tree,
    required this.nodeId,
    required this.page,
    this.stats,
    this.statsError,
  });

  final PrcTree tree;
  final String nodeId;
  final PrcRowPage page;

  /// The statistics of the node, or null when the server could not give them (the code is in `statsError`).
  final PrcNodeStats? stats;
  final String? statsError;
}

PrcListData? parsePrcListData(Object? raw) {
  if (raw is! Map) return null;
  final PrcTree? tree = parsePrcTree(raw['tree']);
  final PrcRowPage? page = parsePrcRowPage(raw['page']);
  final Object? nodeId = raw['node'];
  if (tree == null ||
      page == null ||
      nodeId is! String ||
      tree.byId(nodeId) == null)
    return null;
  final PrcNodeStats? stats = parsePrcNodeStats(raw['stats']);
  final Object? statsError = raw['stats_error'];
  return PrcListData(tree: tree, nodeId: nodeId, page: page, stats: stats, statsError: stats == null ? (statsError is String ? statsError : 'CONTRACT_MISMATCH') : null);
}

/// The node to show when none was asked for: the method with most packages.
String defaultNodeOf(PrcTree tree) {
  PrcNode? best;
  for (final PrcNode method in tree.methods) {
    if (best == null || method.count > best.count) best = method;
  }
  return best?.id ?? 'ROOT';
}

class PackageListScreen extends StatefulWidget {
  const PackageListScreen({
    this.initialNode,
    this.navigator = const PrcNavigator(),
    super.key,
  });

  final String? initialNode;
  final PrcNavigator navigator;

  @override
  State<PackageListScreen> createState() => _PackageListScreenState();
}

class _PackageListScreenState extends State<PackageListScreen> {
  String? _node;
  int _reload = 0;

  @override
  void initState() {
    super.initState();
    _node = widget.initialNode;
  }

  Future<Object?> _read(MachvonApiClient client) async {
    final Object? tree = await client.execute('getPackageProcessTree');
    final PrcTree? parsed = parsePrcTree(tree);
    if (parsed == null)
      throw const ContractMismatch(
        'response',
        'does not hold what the screen needs',
      );
    final String node = (_node != null && parsed.byId(_node!) != null)
        ? _node!
        : defaultNodeOf(parsed);
    final Object? page = await client.execute(
      'listPackageProcessTreeNodePackages',
      query: <String, Object?>{'node_id': node, 'limit': kPrcPageSize},
    );
    // The statistics of the node are read on their own: when they fail the packages still show, and the card says why it is empty.
    Object? stats;
    String? statsError;
    try {
      stats = await client.execute('getPackageProcessTreeNode', query: <String, Object?>{'node_id': node});
    } on ApiError catch (error) {
      statsError = error.code;
    }
    return <String, Object?>{'tree': tree, 'node': node, 'page': page, 'stats': stats, 'stats_error': statsError};
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.prc.list.title'),
      body: DataView<PrcListData>(
        cacheKey: 'prc.list.${_node ?? 'default'}',
        reloadKey: _reload,
        read: _read,
        parse: parsePrcListData,
        asOf: (PrcListData data) => data.page.asOf ?? data.tree.asOf,
        isEmpty: (PrcListData data) => data.tree.totalCount == 0,
        builder: (BuildContext context, Loaded<PrcListData> loaded) =>
            _ListBody(
              data: loaded.value,
              navigator: widget.navigator,
              onNode: (String id) => setState(() => _node = id),
              onRefresh: () async {
                setState(() => _reload += 1);
                await Future<void>.delayed(const Duration(milliseconds: 300));
              },
            ),
      ),
    );
  }
}

class _ListBody extends StatelessWidget {
  const _ListBody({
    required this.data,
    required this.navigator,
    required this.onNode,
    required this.onRefresh,
  });

  final PrcListData data;
  final PrcNavigator navigator;
  final ValueChanged<String> onNode;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    final PrcTree tree = data.tree;
    final PrcNode selected = tree.byId(data.nodeId)!;
    // The method the node lies under: the node itself, or the first of its path that is a method.
    final String methodId = selected.method == null ? data.nodeId : 'M:${selected.method}';
    final PrcNode? method = tree.byId(methodId);
    final List<PrcNode> steps = method == null ? const <PrcNode>[] : tree.childrenOf(method.id);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (tree.methods.length > 1)
          FilterChips<String>(
            options: <ChipOption<String>>[
              for (final PrcNode one in tree.methods) ChipOption<String>(value: one.id, label: '${nodeLabel(context, one)} · ${one.count}'),
            ],
            selected: method?.id ?? '',
            onChanged: onNode,
          ),
        if (method != null) _Chips(method: method, steps: steps, selectedId: data.nodeId, tree: tree, onNode: onNode),
        if (selected.kind == PrcNodeKind.substate)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
            child: Align(alignment: AlignmentDirectional.centerStart, child: StatusPill(label: nodeLabel(context, selected), tone: MachvonTone.info)),
          ),
        TappableRow(
          semanticLabel: context.t('mob.prc.list.tree.link'),
          onTap: () => navigator.openTree(context),
          child: Row(
            children: <Widget>[
              Expanded(child: Text(context.t('mob.prc.list.tree.link'), style: context.v2text.bodyStrong.copyWith(color: context.v2.palette.primaryStrong))),
              const ExcludeSemantics(child: Icon(Icons.chevron_right)),
            ],
          ),
        ),
        Expanded(
          child: _RowList(
            key: ValueKey<Object>(data.page),
            data: data,
            navigator: navigator,
            onRefresh: onRefresh,
            onNode: onNode,
            methodId: methodId,
            stats: NodeStatsCard(stats: data.stats, errorCode: data.statsError),
          ),
        ),
      ],
    );
  }
}

/// The steps of the method as one row of chips: all, then each step with its count (the chips are the filters of the list).
class _Chips extends StatelessWidget {
  const _Chips({required this.method, required this.steps, required this.selectedId, required this.tree, required this.onNode});

  final PrcNode method;
  final List<PrcNode> steps;
  final String selectedId;
  final PrcTree tree;
  final ValueChanged<String> onNode;

  @override
  Widget build(BuildContext context) {
    final PrcNode? selectedNode = tree.byId(selectedId);
    // A state of a step (late, on hold...) keeps its step chosen.
    final String stepOfSelection = selectedNode?.stepCode == null ? '' : 'S:${selectedNode!.method}:${selectedNode.stepCode}';
    final bool isStep = steps.any((PrcNode step) => step.id == selectedId);
    final String chosen = isStep ? selectedId : (stepOfSelection.isEmpty ? method.id : stepOfSelection);
    return FilterChips<String>(
      options: <ChipOption<String>>[
        ChipOption<String>(value: method.id, label: context.t('mob.prc.list.chip.all', <String, Object>{'count': method.count})),
        for (final PrcNode step in steps) ChipOption<String>(value: step.id, label: context.t('mob.prc.list.chip.step', <String, Object>{'name': nodeLabel(context, step), 'count': step.count})),
      ],
      selected: chosen,
      onChanged: onNode,
    );
  }
}

class _RowList extends ConsumerStatefulWidget {
  const _RowList({
    required this.data,
    required this.navigator,
    required this.onRefresh,
    required this.onNode,
    required this.methodId,
    required this.stats,
    super.key,
  });

  final PrcListData data;
  final PrcNavigator navigator;
  final Future<void> Function() onRefresh;
  final ValueChanged<String> onNode;
  final String methodId;

  /// The statistics of the node, the first thing in the scrolling list so that it never takes room from the rows.
  final Widget stats;

  @override
  ConsumerState<_RowList> createState() => _RowListState();
}

class _RowListState extends ConsumerState<_RowList> {
  late List<PrcPackageRow> _rows;
  String? _cursor;
  bool _loading = false;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _rows = List<PrcPackageRow>.of(widget.data.page.items);
    _cursor = widget.data.page.nextCursor;
  }

  /// The next page, appended; a page that cannot be had says so in place and can be asked again, and what is shown stays.
  Future<void> _more() async {
    final String? cursor = _cursor;
    if (cursor == null || _loading) return;
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final Object? raw = await ref.read(apiClientProvider).execute(
        'listPackageProcessTreeNodePackages',
        query: <String, Object?>{'node_id': widget.data.nodeId, 'limit': kPrcPageSize, 'cursor': cursor},
      );
      final PrcRowPage? page = parsePrcRowPage(raw);
      if (!mounted) return;
      if (page == null) {
        setState(() {
          _loading = false;
          _failed = true;
        });
        return;
      }
      setState(() {
        _rows.addAll(page.items);
        _cursor = page.nextCursor == cursor ? null : page.nextCursor;
        _loading = false;
      });
    } on Object {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _failed = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    if (_rows.isEmpty) {
      final bool narrowed = widget.data.nodeId != widget.methodId;
      return RefreshIndicator(
        onRefresh: widget.onRefresh,
        child: ListView(
          children: <Widget>[
            widget.stats,
            SizedBox(
              height: 440,
              child: StateView(
                kind: StateKind.empty,
                title: context.t('mob.prc.list.empty.title'),
                body: narrowed ? context.t('mob.prc.list.empty.narrowed') : context.t('mob.prc.list.empty.body'),
                details: <Widget>[
                  Text(
                    '${context.t('mob.states.empty.filter.label')}: ${nodeLabel(context, widget.data.tree.byId(widget.data.nodeId)!)}',
                    textAlign: TextAlign.center,
                    style: text.caption,
                  ),
                ],
                actionLabel: narrowed ? context.t('mob.states.empty.clearFilters.action') : context.t('mob.states.retry.action'),
                onAction: narrowed ? () => widget.onNode(widget.methodId) : () => widget.onRefresh(),
              ),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: widget.onRefresh,
      child: ListView.builder(
        itemCount: _rows.length + 2,
        itemBuilder: (BuildContext context, int index) {
          if (index == 0) {
            return Padding(
              padding: const EdgeInsets.all(MachvonV2Space.s16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  widget.stats,
                  Text(context.t('mob.prc.list.count', <String, Object>{'shown': _rows.length}), style: text.caption),
                  if (widget.data.page.truncated) Text(context.t('mob.prc.list.truncated'), style: text.caption),
                ],
              ),
            );
          }
          if (index == _rows.length + 1) {
            return _Footer(hasMore: _cursor != null, loading: _loading, failed: _failed, onMore: _more);
          }
          final PrcPackageRow row = _rows[index - 1];
          return PackageRowTile(row: row, dividerAbove: index > 1, onTap: () => widget.navigator.openPackage(context, row.packageId));
        },
      ),
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({required this.hasMore, required this.loading, required this.failed, required this.onMore});

  final bool hasMore;
  final bool loading;
  final bool failed;
  final VoidCallback onMore;

  @override
  Widget build(BuildContext context) {
    if (!hasMore) return const SizedBox(height: MachvonV2Space.s24);
    return Padding(
      padding: const EdgeInsets.all(MachvonV2Space.s16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (failed)
            Padding(
              padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
              child: Semantics(liveRegion: true, child: Text(context.t('mob.prc.list.more.error'), style: context.v2text.caption.copyWith(color: context.v2.palette.lateFg))),
            ),
          if (loading)
            const LinearProgressIndicator(minHeight: 3)
          else
            OutlinedButton(onPressed: onMore, child: Text(failed ? context.t('mob.prc.list.more.retry') : context.t('mob.prc.list.more.action'))),
        ],
      ),
    );
  }
}
