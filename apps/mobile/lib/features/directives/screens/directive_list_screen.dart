import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../../read_support/wire.dart';
import '../directive_models.dart';
import '../labels.dart';
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
    return ScreenFrame(
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

class _Filters extends StatelessWidget {
  const _Filters({required this.filter, required this.onChanged});

  final DirectiveFilter filter;
  final ValueChanged<DirectiveFilter> onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
      child: Semantics(
        container: true,
        label: context.t('mob.dir.list.filter.label'),
        child: FilterChips<DirectiveFilter>(
          padding: EdgeInsets.zero,
          options: <ChipOption<DirectiveFilter>>[for (final DirectiveFilter option in DirectiveFilter.values) ChipOption<DirectiveFilter>(value: option, label: directiveFilterLabel(context, option))],
          selected: filter,
          onChanged: onChanged,
        ),
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
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
          child: Text(context.t('mob.dir.list.count', <String, Object>{'shown': list.lines.length}), style: text.caption),
        ),
        if (list.more)
          Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16), child: Text(context.t('mob.dir.list.more'), style: text.caption)),
        for (final DirectiveLine line in list.lines) _Row(line: line),
        Padding(
          padding: const EdgeInsets.all(MachvonV2Space.s16),
          child: Text(context.t('mob.dir.list.readOnly'), style: text.caption),
        ),
      ],
    );
  }
}

class _Summary extends StatelessWidget {
  const _Summary({required this.list});

  final DirectiveList list;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final DirectiveSummary? summary = list.summary;
    if (summary == null) {
      return SectionCard(
        title: context.t('mob.dir.list.summary.title'),
        children: <Widget>[
          Semantics(liveRegion: true, child: Text(context.t('mob.dir.list.summary.failed'), style: text.body)),
        ],
      );
    }
    final String unit = context.t('mob.dir.list.summary.unit');
    return SectionCard(
      title: context.t('mob.dir.list.summary.title'),
      children: <Widget>[
        KpiGroup(
          tiles: <Widget>[
            KpiTile(label: context.t('mob.dir.list.summary.overdue'), value: '${summary.overdue}', unit: unit),
            KpiTile(label: context.t('mob.dir.list.summary.dueSoon'), value: '${summary.dueSoon}', unit: unit),
            KpiTile(label: context.t('mob.dir.list.summary.escalated'), value: '${summary.escalated}', unit: unit),
            KpiTile(label: context.t('mob.dir.list.summary.open'), value: '${summary.open}', unit: unit),
          ],
        ),
        if (summary.truncated) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.dir.list.summary.truncated'), style: text.caption)),
        if (list.asOf != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.read.asOf.line', <String, Object>{'time': asOfLabel(list.asOf!)}), style: text.caption)),
        Theme(
          data: Theme.of(context).copyWith(dividerColor: context.v2.palette.line),
          child: ExpansionTile(
            tilePadding: EdgeInsets.zero,
            childrenPadding: EdgeInsets.zero,
            title: Text(context.t('mob.dir.list.how.title')),
            children: <Widget>[
              if (summary.definitions['by_status'] != null) _How(text: context.t('mob.dir.list.how.overdue', <String, Object>{'text': summary.definitions['by_status']!})),
              if (summary.definitions['due_soon'] != null) _How(text: context.t('mob.dir.list.how.dueSoon', <String, Object>{'text': summary.definitions['due_soon']!})),
              if (summary.definitions['escalated'] != null) _How(text: context.t('mob.dir.list.how.escalated', <String, Object>{'text': summary.definitions['escalated']!})),
              if (summary.policy.unverified) _How(text: context.t('mob.dir.list.policy.unverified')),
            ],
          ),
        ),
      ],
    );
  }
}

class _How extends StatelessWidget {
  const _How({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
        child: Align(alignment: Alignment.centerLeft, child: Text(text, style: context.v2text.caption)),
      );
}

class _Row extends StatelessWidget {
  const _Row({required this.line});

  final DirectiveLine line;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String status = directiveStatusLabel(context, line.status);
    final String? clock = directiveClockLabel(context, line);
    return TappableRow(
      semanticLabel: context.t('mob.dir.row.aria', <String, Object>{'code': line.code, 'status': status, 'due': formatDay(line.dueOn), 'text': line.text}),
      onTap: () => showDirectiveDetail(context, line),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(line.code, style: text.label),
                Text(line.text, style: text.bodyStrong, maxLines: 2, overflow: TextOverflow.ellipsis),
                const SizedBox(height: MachvonV2Space.s4),
                Wrap(
                  spacing: MachvonV2Space.s8,
                  runSpacing: MachvonV2Space.s4,
                  children: <Widget>[
                    StatusPill(label: status, tone: directiveStatusTone(line.status)),
                    if (clock != null) StatusPill(label: clock, tone: directiveClockTone(line.phase), icon: line.escalated ? Icons.priority_high : null),
                  ],
                ),
                Text(context.t('mob.dir.row.due', <String, Object>{'due': formatDay(line.dueOn)}), style: text.caption),
                Text(context.t('mob.dir.row.unit', <String, Object>{'unit': line.assigneeUnit}), style: text.caption),
                Text(line.assignee == null ? context.t('mob.dir.row.personNone') : context.t('mob.dir.row.person', <String, Object>{'name': line.assignee!}), style: text.caption),
                if (line.projectCode != null) Text(context.t('mob.dir.row.project', <String, Object>{'code': line.projectCode!}), style: text.caption),
                if (line.extensionPending) Text(context.t('mob.dir.row.extension'), style: text.caption),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}
