import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../vendor_models.dart';

/// MOB-73: the grades of risk of the contractors for an officer. A list by tier, with the filters "review overdue" and "waiting for confirmation", the
/// score and the next review of each, the counts and the rule the server names (with the flag when it is not verified). It only reads: a grade is a
/// signal with its explanation, and a second person confirms it on the computer. A tap opens the grade and the performance of the contractor (MOB-74).
Widget buildRiskListScreen(BuildContext context, ScreenContext screen) => const RiskListScreen();

/// The most rows one page asks for.
const int kVendorPageSize = 30;

/// Where a tap goes, as a parameter so that a test can say what a tap does; the default opens MOB-74 on top of the list.
typedef OpenContractor = void Function(BuildContext context, String contractorId);

void _openContractor(BuildContext context, String contractorId) => openScreen(context, 'MOB-74', pathSuffix: '/${Uri.encodeComponent(contractorId)}', stacked: true);

class RiskListScreen extends StatefulWidget {
  const RiskListScreen({this.open = _openContractor, super.key});

  final OpenContractor open;

  @override
  State<RiskListScreen> createState() => _RiskListScreenState();
}

/// What narrows the list; all of it is the server's filter, nothing is cut on the phone.
enum _Filter { all, low, medium, high, critical, reviewDue, pending }

class _RiskListScreenState extends State<RiskListScreen> {
  _Filter _filter = _Filter.all;

  Map<String, Object?> _query() {
    final Map<String, Object?> query = <String, Object?>{'limit': kVendorPageSize};
    switch (_filter) {
      case _Filter.all:
        break;
      case _Filter.low:
        query['tier'] = 'LOW';
      case _Filter.medium:
        query['tier'] = 'MEDIUM';
      case _Filter.high:
        query['tier'] = 'HIGH';
      case _Filter.critical:
        query['tier'] = 'CRITICAL';
      case _Filter.reviewDue:
        query['review_due'] = true;
      case _Filter.pending:
        query['pending'] = true;
    }
    return query;
  }

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.vnd.list.title'),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _Filters(selected: _filter, onChanged: (_Filter value) => setState(() => _filter = value)),
          Expanded(
            child: DataView<VendorRiskPage>(
              cacheKey: 'vnd.risk.${_filter.name}',
              read: (MachvonApiClient client) => client.listVendorRiskGrades(query: _query()),
              parse: parseVendorRiskPage,
              asOf: (VendorRiskPage page) => page.asOf,
              isEmpty: (VendorRiskPage page) => page.items.isEmpty,
              activeFilters: _filter == _Filter.all ? const <String>[] : <String>[_filterWord(context, _filter)],
              onClearFilters: _filter == _Filter.all ? null : () => setState(() => _filter = _Filter.all),
              builder: (BuildContext context, Loaded<VendorRiskPage> loaded) => _List(key: ValueKey<String>(_filter.name), page: loaded.value, query: _query(), open: widget.open),
            ),
          ),
        ],
      ),
    );
  }
}

String _filterWord(BuildContext context, _Filter filter) {
  switch (filter) {
    case _Filter.all:
      return context.t('mob.vnd.list.filter.all');
    case _Filter.low:
      return context.t('mob.vnd.tier.low');
    case _Filter.medium:
      return context.t('mob.vnd.tier.medium');
    case _Filter.high:
      return context.t('mob.vnd.tier.high');
    case _Filter.critical:
      return context.t('mob.vnd.tier.critical');
    case _Filter.reviewDue:
      return context.t('mob.vnd.list.filter.review');
    case _Filter.pending:
      return context.t('mob.vnd.list.filter.pending');
  }
}

class _Filters extends StatelessWidget {
  const _Filters({required this.selected, required this.onChanged});

  final _Filter selected;
  final ValueChanged<_Filter> onChanged;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: MediaQuery.textScalerOf(context).scale(48) + 16,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
        child: Row(
          children: <Widget>[
            for (final _Filter filter in _Filter.values)
              Padding(
                padding: const EdgeInsets.only(right: MachvonSpace.space8),
                child: Semantics(
                  button: true,
                  selected: filter == selected,
                  label: _filterWord(context, filter),
                  onTap: () => onChanged(filter),
                  excludeSemantics: true,
                  child: ChoiceChip(
                    label: Text(_filterWord(context, filter)),
                    selected: filter == selected,
                    onSelected: (_) => onChanged(filter),
                    materialTapTargetSize: MaterialTapTargetSize.padded,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _List extends ConsumerStatefulWidget {
  const _List({required this.page, required this.query, required this.open, super.key});

  final VendorRiskPage page;
  final Map<String, Object?> query;
  final OpenContractor open;

  @override
  ConsumerState<_List> createState() => _ListState();
}

class _ListState extends ConsumerState<_List> {
  late List<VendorRiskItem> _items;
  String? _cursor;
  bool _loading = false;
  bool _failed = false;

  /// Counts the pages the list was reset to, so that an answer to a request of an older page is never appended to a newer one.
  int _epoch = 0;

  @override
  void initState() {
    super.initState();
    _reset();
  }

  void _reset() {
    _items = List<VendorRiskItem>.of(widget.page.items);
    _cursor = widget.page.nextCursor;
    _loading = false;
    _failed = false;
    _epoch += 1;
  }

  /// A refresh gives a new first page for the same filter: the rows and the cursor of the old page are dropped with it.
  @override
  void didUpdateWidget(_List oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.page, widget.page)) _reset();
  }

  /// The next page, appended; a page that cannot be had says so in place and can be asked again, and what is shown stays.
  Future<void> _more() async {
    final String? cursor = _cursor;
    if (cursor == null || _loading) return;
    final int epoch = _epoch;
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final Object? raw = await ref.read(apiClientProvider).listVendorRiskGrades(query: <String, Object?>{...widget.query, 'cursor': cursor});
      final VendorRiskPage? page = parseVendorRiskPage(raw);
      if (!mounted || epoch != _epoch) return;
      if (page == null) {
        setState(() {
          _loading = false;
          _failed = true;
        });
        return;
      }
      setState(() {
        _items.addAll(page.items);
        _cursor = page.nextCursor == cursor ? null : page.nextCursor;
        _loading = false;
      });
    } on Object {
      if (!mounted || epoch != _epoch) return;
      setState(() {
        _loading = false;
        _failed = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final VendorRiskPage page = widget.page;
    return ListView.builder(
      itemCount: _items.length + 2,
      itemBuilder: (BuildContext context, int index) {
        if (index == 0) {
          return Padding(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(context.t('mob.vnd.list.readonly'), style: theme.textTheme.bodySmall),
                for (final VendorFigure figure in page.figures) Text(context.t('mob.vnd.figure.line', <String, Object>{'code': figure.code, 'numerator': figure.numerator, 'denominator': figure.denominator}), style: theme.textTheme.bodySmall),
                if (page.policy != null) Text(context.t('mob.vnd.policy.line', <String, Object>{'code': page.policy!.code, 'version': page.policy!.version}), style: theme.textTheme.bodySmall),
                if (page.policy?.unverified == true) Text(context.t('mob.vnd.policy.unverified'), style: theme.textTheme.bodySmall),
                const SizedBox(height: MachvonSpace.space4),
                Text(context.t('mob.vnd.list.count', <String, Object>{'shown': _items.length}), style: theme.textTheme.titleSmall),
              ],
            ),
          );
        }
        if (index == _items.length + 1) return _Footer(hasMore: _cursor != null, loading: _loading, failed: _failed, onMore: _more);
        final VendorRiskItem item = _items[index - 1];
        return _RowTile(item: item, onTap: () => widget.open(context, item.contractorId));
      },
    );
  }
}

class _RowTile extends StatelessWidget {
  const _RowTile({required this.item, required this.onTap});

  final VendorRiskItem item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String? review = item.nextReviewOn;
    return TappableRow(
      semanticLabel: context.t('mob.vnd.row.aria', <String, Object>{'name': item.name, 'tier': item.tier == null ? context.t('mob.vnd.tier.none') : tierWord(context, item.tier!)}),
      onTap: onTap,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(item.name, style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
                if (item.taxId != null) Text(context.t('mob.vnd.row.tax', <String, Object>{'tax': item.taxId!}), style: theme.textTheme.bodySmall),
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
                  child: Wrap(
                    spacing: MachvonSpace.space8,
                    runSpacing: MachvonSpace.space4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: <Widget>[
                      TierPill(tier: item.tier),
                      if (item.score != null) Text(context.t('mob.vnd.row.score', <String, Object>{'score': item.score!}), style: theme.textTheme.bodyMedium),
                    ],
                  ),
                ),
                if (review != null)
                  Text(
                    item.reviewOverdue ? context.t('mob.vnd.row.reviewOverdue', <String, Object>{'day': formatDay(review)}) : context.t('mob.vnd.row.review', <String, Object>{'day': formatDay(review)}),
                    style: theme.textTheme.bodySmall?.copyWith(color: item.reviewOverdue ? MachvonColors.danger : null),
                  ),
                if (item.pendingTier != null) Text(context.t('mob.vnd.row.pending', <String, Object>{'tier': tierWord(context, item.pendingTier!)}), style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
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
    if (!hasMore) return const SizedBox(height: MachvonSpace.space24);
    return Padding(
      padding: const EdgeInsets.all(MachvonSpace.space16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (failed)
            Padding(
              padding: const EdgeInsets.only(bottom: MachvonSpace.space8),
              child: Text(context.t('mob.vnd.list.more.error'), style: Theme.of(context).textTheme.bodySmall?.copyWith(color: MachvonColors.danger)),
            ),
          if (loading)
            const LinearProgressIndicator(minHeight: 3)
          else
            OutlinedButton(onPressed: onMore, child: Text(failed ? context.t('mob.vnd.list.more.retry') : context.t('mob.vnd.list.more.action'))),
        ],
      ),
    );
  }
}
