import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/stat_strip.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/tap_target.dart';
import '../../../core/widgets/underline_tabs.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/paged.dart';
import '../../read_support/wire.dart';
import '../directive_models.dart';
import '../labels.dart';
import '../widgets/directive_row.dart';
import 'directive_detail_sheet.dart';

/// DIR-06: the directives of the steering meetings in the scope of the reader, read only (roadmap CN.03 and QT.02). The counts on top are the
/// ones of the server (overdue, due soon, raised to the unit head, open) with how each is counted; the list is in the order the server gives, the
/// late ones first, and is read a page at a time by cursor. The reader picks "given to me", "overdue" or "all"; a row opens the timeline. What is
/// overdue is the server's word, never the clock of the phone. The directive is noted, extended and closed on the computer.
Widget buildDirectiveListScreen(BuildContext context, ScreenContext screen) => const DirectiveListScreen();

class DirectiveListScreen extends StatefulWidget {
  const DirectiveListScreen({super.key});

  @override
  State<DirectiveListScreen> createState() => _DirectiveListScreenState();
}

class _DirectiveListScreenState extends State<DirectiveListScreen> {
  DirectiveFilter _filter = DirectiveFilter.mine;
  int _reload = 0;

  /// The directives of the view, then the counts of the scope. A refusal of the counts does not take the list down (the screen says the counts could
  /// not be read); a lost connection does, so the copy on the device is shown instead.
  static Future<Object?> _read(MachvonApiClient client, DirectiveFilter filter) async {
    final Json list = await readMerged(client, 'listDirectives', query: directiveQuery(filter), maxPages: 4);
    Object? summary;
    bool failed = false;
    try {
      summary = await client.execute('getDirectiveSummary');
    } on ApiError catch (error) {
      if (error.code == networkErrorCode) rethrow;
      failed = true;
    }
    return <String, Object?>{'list': list, 'summary': summary, 'summary_failed': failed};
  }

  @override
  Widget build(BuildContext context) {
    final DirectiveFilter filter = _filter;
    return AppScaffold(
      title: context.t('mob.dir.list.title'),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _Filters(filter: filter, onChanged: (DirectiveFilter next) => setState(() => _filter = next)),
          Expanded(
            child: DataView<DirectiveList>(
              cacheKey: 'directives.list.${filter.name}',
              reloadKey: _reload,
              read: (MachvonApiClient client) => _read(client, filter),
              parse: parseDirectiveList,
              asOf: (DirectiveList list) => list.asOf,
              isEmpty: (DirectiveList list) => list.lines.isEmpty,
              activeFilters: filter == DirectiveFilter.all ? const <String>[] : <String>[directiveFilterLabel(context, filter)],
              onClearFilters: () => setState(() => _filter = DirectiveFilter.all),
              builder: (BuildContext context, Loaded<DirectiveList> loaded) => RefreshIndicator(
                onRefresh: () async => setState(() => _reload += 1),
                child: _Body(list: loaded.value),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The three views of the list as tabs: given to me, overdue, all.
class _Filters extends StatelessWidget {
  const _Filters({required this.filter, required this.onChanged});

  final DirectiveFilter filter;
  final ValueChanged<DirectiveFilter> onChanged;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: context.t('mob.dir.list.filter.label'),
      child: UnderlineTabs(
        tabs: <TabOption>[for (final DirectiveFilter option in DirectiveFilter.values) TabOption(label: directiveFilterLabel(context, option))],
        index: DirectiveFilter.values.indexOf(filter),
        onChanged: (int index) => onChanged(DirectiveFilter.values[index]),
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.list});

  final DirectiveList list;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        _Summary(list: list),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
          child: Text(context.t('mob.dir.list.count', <String, Object>{'shown': list.lines.length}), style: text.caption),
        ),
        if (list.more)
          Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16), child: Text(context.t('mob.dir.list.more'), style: text.caption)),
        for (int index = 0; index < list.lines.length; index += 1)
          DirectiveRow(line: list.lines[index], dividerAbove: index > 0, onTap: () => showDirectiveDetail(context, list.lines[index])),
        Padding(
          padding: const EdgeInsets.all(MachvonV2Space.s16),
          child: Text(context.t('mob.dir.list.readOnly'), style: text.caption),
        ),
      ],
    );
  }
}

class _Summary extends StatefulWidget {
  const _Summary({required this.list});

  final DirectiveList list;

  @override
  State<_Summary> createState() => _SummaryState();
}

class _SummaryState extends State<_Summary> {
  bool _howOpen = false;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final DirectiveList list = widget.list;
    final DirectiveSummary? summary = list.summary;
    final Widget heading = Padding(
      padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s8),
      child: Semantics(container: true, header: true, child: Text(context.t('mob.dir.list.summary.title'), style: text.heading)),
    );
    if (summary == null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          heading,
          StatusBanner(text: context.t('mob.dir.list.summary.failed'), tone: BannerTone.warning),
        ],
      );
    }
    final List<Widget> how = <Widget>[
      if (summary.definitions['by_status'] != null) _How(text: context.t('mob.dir.list.how.overdue', <String, Object>{'text': summary.definitions['by_status']!})),
      if (summary.definitions['due_soon'] != null) _How(text: context.t('mob.dir.list.how.dueSoon', <String, Object>{'text': summary.definitions['due_soon']!})),
      if (summary.definitions['escalated'] != null) _How(text: context.t('mob.dir.list.how.escalated', <String, Object>{'text': summary.definitions['escalated']!})),
      if (summary.policy.unverified) _How(text: context.t('mob.dir.list.policy.unverified')),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        heading,
        StatStrip(
          cells: <StatCell>[
            StatCell(value: '${summary.overdue}', label: context.t('mob.dir.list.summary.overdue')),
            StatCell(value: '${summary.dueSoon}', label: context.t('mob.dir.list.summary.dueSoon')),
          ],
        ),
        StatStrip(
          cells: <StatCell>[
            StatCell(value: '${summary.escalated}', label: context.t('mob.dir.list.summary.escalated')),
            StatCell(value: '${summary.open}', label: context.t('mob.dir.list.summary.open')),
          ],
        ),
        if (summary.truncated) Padding(padding: const EdgeInsets.only(left: MachvonV2Space.s16, top: MachvonV2Space.s8, right: MachvonV2Space.s16), child: Text(context.t('mob.dir.list.summary.truncated'), style: text.caption)),
        if (list.asOf != null)
          Padding(
            padding: const EdgeInsets.only(left: MachvonV2Space.s16, top: MachvonV2Space.s8, right: MachvonV2Space.s16),
            child: Text(context.t('mob.read.asOf.line', <String, Object>{'time': asOfLabel(list.asOf!)}), style: text.caption),
          ),
        TapTarget(
          onTap: () => setState(() => _howOpen = !_howOpen),
          semanticLabel: context.t('mob.dir.list.how.title'),
          selected: _howOpen,
          radius: 0,
          minHeight: 48,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
            child: Row(
              children: <Widget>[
                Expanded(child: Text(context.t('mob.dir.list.how.title'), style: text.label.copyWith(color: v2.palette.primaryStrong))),
                ExcludeSemantics(child: Icon(_howOpen ? Icons.expand_less : Icons.expand_more, color: v2.palette.primaryStrong)),
              ],
            ),
          ),
        ),
        if (_howOpen) ...how,
      ],
    );
  }
}

class _How extends StatelessWidget {
  const _How({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(left: MachvonV2Space.s16, right: MachvonV2Space.s16, bottom: MachvonV2Space.s8),
        child: Align(alignment: Alignment.centerLeft, child: Text(text, style: context.v2text.caption)),
      );
}
