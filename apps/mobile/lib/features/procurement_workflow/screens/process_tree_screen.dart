import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/app_theme.dart' show kTabularFigures;
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../navigation.dart';
import '../widgets.dart';
import '../workflow_models.dart';

/// MOB-71: "Progress tree" as an outline (docs/process-tree-design.md section 8): one expandable row for each state of the process, with the
/// number of packages, their health (icon and word), their share and how long they have been there; a tap on a state opens its packages.
/// The flow drawing of the web is not rendered on a phone; what it says (the counts and the moves of the period) is written as text.
Widget buildProcessTreeScreen(BuildContext context, ScreenContext screen) => const ProcessTreeScreen();

/// Which rows were open, kept while the app runs (UI state only, never sent anywhere).
final Set<String> _expandedNodes = <String>{};

/// Forgets which rows were open (a test starts clean).
void forgetExpandedNodes() => _expandedNodes.clear();

class ProcessTreeScreen extends StatelessWidget {
  const ProcessTreeScreen({this.navigator = const PrcNavigator(), super.key});

  final PrcNavigator navigator;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.prc.tree.title'),
      body: DataView<PrcTree>(
        cacheKey: 'prc.tree',
        read: (MachvonApiClient client) => client.execute('getPackageProcessTree'),
        parse: parsePrcTree,
        asOf: (PrcTree tree) => tree.asOf,
        isEmpty: (PrcTree tree) => tree.totalCount == 0,
        builder: (BuildContext context, Loaded<PrcTree> loaded) => _TreeBody(tree: loaded.value, navigator: navigator),
      ),
    );
  }
}

class _TreeBody extends StatelessWidget {
  const _TreeBody({required this.tree, required this.navigator});

  final PrcTree tree;
  final PrcNavigator navigator;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final List<PrcNode> roots = tree.methods;
    return ListView(
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonSpace.space16, MachvonSpace.space12, MachvonSpace.space16, MachvonSpace.space4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(context.t('mob.prc.tree.total', <String, Object>{'count': tree.totalCount}), style: theme.textTheme.titleMedium),
              Text(context.t('mob.prc.tree.period', <String, Object>{'from': formatDay(tree.periodFrom), 'to': formatDay(tree.periodTo)}), style: theme.textTheme.bodySmall),
              if (tree.truncated) Text(context.t('mob.prc.tree.truncated'), style: theme.textTheme.bodySmall),
            ],
          ),
        ),
        SectionCard(
          title: context.t('mob.prc.tree.title'),
          children: <Widget>[
            KpiGroup(
              tiles: <Widget>[
                KpiTile(label: context.t('mob.prc.tree.kpi.running'), value: '${tree.running}'),
                KpiTile(label: context.t('mob.prc.tree.kpi.late'), value: '${tree.late}', note: tree.late > 0 ? context.t('mob.prc.tree.health.late') : null, noteTone: MachvonTone.danger),
                KpiTile(label: context.t('mob.prc.tree.kpi.stalled'), value: '${tree.stalled}'),
                KpiTile(label: context.t('mob.prc.tree.kpi.hold'), value: '${tree.onHold}'),
                KpiTile(label: context.t('mob.prc.tree.kpi.noOwner'), value: '${tree.noOwner}'),
              ],
            ),
          ],
        ),
        for (final PrcNode node in roots) _NodeTile(tree: tree, node: node, depth: 0, navigator: navigator),
        Padding(padding: const EdgeInsets.all(MachvonSpace.space16), child: Text(context.t('mob.prc.tree.help'), style: theme.textTheme.bodySmall)),
      ],
    );
  }
}

/// A node of the outline. A node with children is an expandable row (the first thing in it is the way to its own packages); a node with none
/// is a row that opens its packages. A node with no package is drawn in secondary text and does not open anything, but stays in the structure.
class _NodeTile extends StatefulWidget {
  const _NodeTile({required this.tree, required this.node, required this.depth, required this.navigator});

  final PrcTree tree;
  final PrcNode node;
  final int depth;
  final PrcNavigator navigator;

  @override
  State<_NodeTile> createState() => _NodeTileState();
}

class _NodeTileState extends State<_NodeTile> {
  @override
  Widget build(BuildContext context) {
    final PrcNode node = widget.node;
    final List<PrcNode> children = widget.tree.childrenOf(node.id);
    final EdgeInsets padding = EdgeInsets.only(left: MachvonSpace.space16 + widget.depth * MachvonSpace.space16, right: MachvonSpace.space16);
    final Widget header = _NodeHeader(tree: widget.tree, node: node);
    final VoidCallback? open = node.count == 0 ? null : () => widget.navigator.openNode(context, node.id);
    if (children.isEmpty) {
      return Padding(
        padding: EdgeInsets.only(left: widget.depth * MachvonSpace.space16),
        child: _Guide(
          depth: widget.depth,
          child: TappableRow(semanticLabel: _aria(context, widget.tree, node), onTap: open, child: header),
        ),
      );
    }
    final bool isMethod = node.kind == PrcNodeKind.method;
    final bool noSteps = isMethod && !children.any((PrcNode child) => child.kind == PrcNodeKind.step);
    return _Guide(
      depth: widget.depth,
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          key: PageStorageKey<String>(node.id),
          initiallyExpanded: _expandedNodes.contains(node.id),
          onExpansionChanged: (bool open) => open ? _expandedNodes.add(node.id) : _expandedNodes.remove(node.id),
          tilePadding: padding,
          childrenPadding: EdgeInsets.zero,
          expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
          title: header,
          children: <Widget>[
            if (open != null)
              Padding(
                padding: EdgeInsets.only(left: widget.depth * MachvonSpace.space16),
                child: TappableRow(
                  semanticLabel: context.t('mob.prc.tree.open', <String, Object>{'count': node.count}),
                  onTap: open,
                  child: Row(children: <Widget>[Expanded(child: Text(context.t('mob.prc.tree.open', <String, Object>{'count': node.count}), style: const TextStyle(color: MachvonColors.primary))), const ExcludeSemantics(child: Icon(Icons.chevron_right))]),
                ),
              ),
            if (noSteps && node.count > 0)
              Padding(padding: EdgeInsets.fromLTRB(MachvonSpace.space16 + (widget.depth + 1) * MachvonSpace.space16, 0, MachvonSpace.space16, MachvonSpace.space8), child: Text(context.t('mob.prc.tree.noDefinition'), style: Theme.of(context).textTheme.bodySmall)),
            for (final PrcNode child in children) _NodeTile(tree: widget.tree, node: child, depth: widget.depth + 1, navigator: widget.navigator),
          ],
        ),
      ),
    );
  }
}

/// The 1 px guide line that shows depth under a parent.
class _Guide extends StatelessWidget {
  const _Guide({required this.depth, required this.child});

  final int depth;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (depth == 0) return child;
    return DecoratedBox(
      decoration: const BoxDecoration(border: Border(left: BorderSide(color: MachvonColors.border))),
      child: child,
    );
  }
}

String _aria(BuildContext context, PrcTree tree, PrcNode node) {
  final PrcHealth health = healthOf(node);
  return context.t('mob.prc.tree.node.aria', <String, Object>{
    'label': nodeLabel(context, node),
    'count': node.count,
    'value': moneyLabel(context, node.valueVnd),
    'late': node.lateCount,
    'health': health == PrcHealth.none ? '' : healthLabel(context, health),
  });
}

class _NodeHeader extends StatelessWidget {
  const _NodeHeader({required this.tree, required this.node});

  final PrcTree tree;
  final PrcNode node;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final PrcHealth health = healthOf(node);
    final bool empty = node.count == 0;
    final Color? muted = empty ? MachvonColors.textSecondary : null;
    final int moved = tree.movedInto(node.id);
    final int returned = tree.returnedFrom(node.id);
    final double? median = node.medianDays;
    String? medianText;
    if (median != null) {
      final Map<String, Object> days = <String, Object>{'n': median == median.truncateToDouble() ? median.toInt().toString() : median.toStringAsFixed(1)};
      medianText = node.medianWorking ? context.t('mob.prc.tree.median.working', days) : context.t('mob.prc.tree.median.calendar', days);
    }
    // No container: the sentence joins the row that opens or expands, so a screen reader reads that row as one labelled control.
    return Semantics(
      label: _aria(context, tree, node),
      excludeSemantics: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(child: Text(nodeLabel(context, node), style: theme.textTheme.bodyLarge?.copyWith(color: muted, fontWeight: node.kind == PrcNodeKind.method ? FontWeight.w700 : null))),
              const SizedBox(width: MachvonSpace.space8),
              Text(context.t('mob.prc.tree.count', <String, Object>{'count': node.count}), style: theme.textTheme.bodyLarge?.copyWith(color: muted, fontWeight: FontWeight.w700, fontFeatures: kTabularFigures)),
            ],
          ),
          if (!empty) ...<Widget>[
            const SizedBox(height: MachvonSpace.space4),
            Wrap(
              spacing: MachvonSpace.space8,
              runSpacing: MachvonSpace.space4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: <Widget>[
                HealthPill(health: health),
                if (node.lateCount > 0 && node.kind != PrcNodeKind.substate) Text(context.t('mob.prc.tree.late', <String, Object>{'n': node.lateCount}), style: theme.textTheme.bodySmall),
                Text(moneyLabel(context, node.valueVnd), style: theme.textTheme.bodySmall),
                if (medianText != null) Text(medianText, style: theme.textTheme.bodySmall),
              ],
            ),
            const SizedBox(height: MachvonSpace.space4),
            Row(
              children: <Widget>[
                Expanded(child: ShareBar(fraction: node.shareFraction)),
                const SizedBox(width: MachvonSpace.space8),
                Text(context.t('mob.prc.tree.share', <String, Object>{'percent': _percent(node.shareCountBp)}), style: theme.textTheme.bodySmall),
              ],
            ),
            if (moved > 0) Text(context.t('mob.prc.tree.moved', <String, Object>{'n': moved}), style: theme.textTheme.bodySmall),
            if (returned > 0) Text(context.t('mob.prc.tree.returned', <String, Object>{'n': returned}), style: theme.textTheme.bodySmall),
          ],
        ],
      ),
    );
  }
}

/// A share in ten-thousandths as a percentage with at most one decimal: 1234 is `12,3`, 5000 is `50`.
String _percent(int basisPoints) {
  final int tenths = (basisPoints / 100 * 10).round();
  final String whole = (tenths ~/ 10).toString();
  final int fraction = tenths % 10;
  return fraction == 0 ? whole : '$whole,$fraction';
}
