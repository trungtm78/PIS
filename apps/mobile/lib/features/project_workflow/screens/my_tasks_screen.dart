import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/di/providers.dart' show apiClientProvider;
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/nav_row.dart';
import '../../../core/widgets/stat_strip.dart';
import '../../../core/widgets/underline_tabs.dart';
import '../../../core/widgets/work_row.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../pwf_models.dart';
import '../pwf_widgets.dart';

/// MOB-80: "Việc của tôi": the tasks of the person by deadline. The colours are the ones of the person's own settings, each row says so ("theo cài đặt
/// của bạn") and always carries the real day the task falls due; a person can switch to the official colours, which are the ones every shared screen,
/// the alerts and the score use. A personal setting can only remind earlier than the official rule, never later (R40), and it is never shown on a screen
/// that another person reads.
Widget buildMyTasksScreen(BuildContext context, ScreenContext screen) => const PwfMyTasksScreen();

/// The way the tasks are coloured and grouped.
enum PwfColourMode { personal, official }

/// The groups of the list, in the order the person reads them.
enum PwfGroup { late, due, soon, ok, far, unknown, done }

class PwfMyTasksScreen extends StatelessWidget {
  const PwfMyTasksScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.pwf.mine.title'),
      body: DataView<PwfMyTasks>(
        cacheKey: 'pwf.mine',
        read: (MachvonApiClient client) => client.getMyTasks(query: const <String, Object?>{'limit': 50}),
        parse: parsePwfMyTasks,
        asOf: (PwfMyTasks tasks) => tasks.asOf,
        isEmpty: (PwfMyTasks tasks) => tasks.items.isEmpty,
        builder: (BuildContext context, Loaded<PwfMyTasks> loaded) => PwfMyTasksList(first: loaded.value, canLoadMore: !loaded.fromCache, onOpenTask: (PwfMyTask task) => openScreen(context, 'MOB-79', pathSuffix: '/${Uri.encodeComponent(task.taskId)}', stacked: true), onSettings: () => openScreen(context, 'MOB-82', stacked: true)),
      ),
    );
  }
}

/// The group of a task in the band the list is coloured by.
PwfGroup pwfGroupOf(PwfMyTask task, PwfColourMode mode) {
  if (task.status == PwfTaskStatus.done || task.status == PwfTaskStatus.cancelled) return PwfGroup.done;
  final PwfBand band = mode == PwfColourMode.personal ? task.personal : task.official;
  return switch (band.kind) {
    // Red is not the same as late (R49): a task is under "late" only when its deadline has passed; a red one that is not overdue (due today, or inside the red line of the ladder) is "due".
    PwfBandKind.red => band.overdue ? PwfGroup.late : PwfGroup.due,
    PwfBandKind.yellow => PwfGroup.soon,
    PwfBandKind.green => PwfGroup.ok,
    PwfBandKind.none => PwfGroup.far,
    PwfBandKind.unknown => PwfGroup.unknown,
  };
}

/// The tasks in groups, the first page the server gave and the pages the person asked for after it. It reads more pages itself with the cursor.
class PwfMyTasksList extends ConsumerStatefulWidget {
  const PwfMyTasksList({required this.first, required this.onOpenTask, required this.onSettings, this.canLoadMore = true, super.key});

  final PwfMyTasks first;
  final ValueChanged<PwfMyTask> onOpenTask;
  final VoidCallback onSettings;

  /// More pages are read only from the server: a copy kept on the device has a cursor that is no longer valid.
  final bool canLoadMore;

  @override
  ConsumerState<PwfMyTasksList> createState() => _PwfMyTasksListState();
}

class _PwfMyTasksListState extends ConsumerState<PwfMyTasksList> {
  PwfColourMode _mode = PwfColourMode.personal;
  int _tab = 0;
  final List<PwfMyTask> _more = <PwfMyTask>[];
  String? _cursor;
  bool _loading = false;
  String? _failure;

  /// Which first page the pages after it belong to: a request that left before the list was read again (pull to refresh, a new first page) answers for a cursor that no
  /// longer exists, and its answer, success or failure, must change nothing.
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _cursor = widget.first.nextCursor;
  }

  @override
  void didUpdateWidget(PwfMyTasksList oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.first, widget.first)) {
      _generation += 1;
      _more.clear();
      _cursor = widget.first.nextCursor;
      _failure = null;
      _loading = false;
    }
  }

  Future<void> _loadMore() async {
    final String? cursor = _cursor;
    if (_loading || cursor == null) return;
    final int generation = _generation;
    setState(() {
      _loading = true;
      _failure = null;
    });
    try {
      final PwfMyTasks? page = parsePwfMyTasks(await ref.read(apiClientProvider).getMyTasks(query: <String, Object?>{'limit': 50, 'cursor': cursor}));
      if (!mounted || generation != _generation) return;
      if (page == null) throw const ContractMismatch('getMyTasks', 'does not hold what the screen needs');
      setState(() {
        _more.addAll(page.items);
        _cursor = page.nextCursor;
        _loading = false;
      });
    } on Object catch (error) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _failure = ProblemView.from(error).code;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final List<PwfMyTask> all = <PwfMyTask>[...widget.first.items, ..._more];
    final Map<PwfGroup, List<PwfMyTask>> groups = <PwfGroup, List<PwfMyTask>>{for (final PwfGroup group in PwfGroup.values) group: <PwfMyTask>[]};
    for (final PwfMyTask task in all) {
      groups[pwfGroupOf(task, _mode)]!.add(task);
    }
    for (final List<PwfMyTask> members in groups.values) {
      members.sort((PwfMyTask a, PwfMyTask b) => (a.dueDate ?? '9999-99-99').compareTo(b.dueDate ?? '9999-99-99'));
    }
    final bool personal = _mode == PwfColourMode.personal;
    // One purpose a tab: what the person still has to do (by deadline), what waits for another person's approval, and what is over.
    final List<PwfMyTask> waiting = <PwfMyTask>[for (final PwfMyTask task in all) if (task.status == PwfTaskStatus.awaitingApproval) task];
    final List<PwfMyTask> over = groups[PwfGroup.done]!;
    final int todoCount = all.length - waiting.length - over.length;
    int inGroups(List<PwfGroup> which) => which.fold<int>(0, (int sum, PwfGroup group) => sum + groups[group]!.where((PwfMyTask task) => task.status != PwfTaskStatus.awaitingApproval).length);
    final int tab = _tab.clamp(0, 2);
    return ListView(
      padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom + MachvonV2Size.rowMinHeight + MachvonV2Space.s32),
      children: <Widget>[
        // The main figures first: what is still to do, by band.
        StatStrip(
          cells: <StatCell>[
            StatCell(value: '${inGroups(const <PwfGroup>[PwfGroup.late, PwfGroup.due])}', label: context.t('mob.pwf6.home.red'), band: DeadlineBand.late, bandInline: true),
            StatCell(value: '${inGroups(const <PwfGroup>[PwfGroup.soon])}', label: context.t('mob.pwf6.home.yellow'), band: DeadlineBand.soon, bandInline: true),
            StatCell(value: '${inGroups(const <PwfGroup>[PwfGroup.ok])}', label: context.t('mob.pwf6.home.green'), band: DeadlineBand.ok, bandInline: true),
          ],
        ),
        UnderlineTabs(
          index: tab,
          onChanged: (int next) => setState(() => _tab = next),
          tabs: <TabOption>[
            TabOption(label: context.t('mob.pwf7.mine.tab.todo'), count: todoCount == 0 ? null : todoCount),
            TabOption(label: context.t('mob.pwf7.mine.tab.waiting'), count: waiting.isEmpty ? null : waiting.length),
            TabOption(label: context.t('mob.pwf7.mine.tab.over'), count: over.isEmpty ? null : over.length),
          ],
        ),
        if (tab == 0) ...<Widget>[
          FilterChips<PwfColourMode>(
            options: <ChipOption<PwfColourMode>>[
              ChipOption<PwfColourMode>(value: PwfColourMode.personal, label: context.t('mob.pwf.mine.mode.personal')),
              ChipOption<PwfColourMode>(value: PwfColourMode.official, label: context.t('mob.pwf.mine.mode.official')),
            ],
            selected: _mode,
            onChanged: (PwfColourMode next) => setState(() => _mode = next),
          ),
          Padding(
            padding: const EdgeInsets.only(left: MachvonV2Space.s16, right: MachvonV2Space.s16, bottom: MachvonV2Space.s12),
            child: Semantics(container: true, child: Text(personal ? context.t('mob.pwf.mine.note.personal') : context.t('mob.pwf.mine.note.official'), style: text.caption)),
          ),
          for (final PwfGroup group in PwfGroup.values)
            if (group != PwfGroup.done)
              ...(() {
                final List<PwfMyTask> members = <PwfMyTask>[for (final PwfMyTask task in groups[group]!) if (task.status != PwfTaskStatus.awaitingApproval) task];
                if (members.isEmpty) return const <Widget>[];
                return <Widget>[
                  GroupHeader(title: _groupTitle(context, group), count: members.length),
                  for (int index = 0; index < members.length; index += 1) _row(context, members[index], personal, index > 0),
                ];
              })(),
          if (todoCount == 0) _none(context),
        ],
        if (tab == 1) ...<Widget>[
          for (int index = 0; index < waiting.length; index += 1) _row(context, waiting[index], false, index > 0),
          if (waiting.isEmpty) _none(context),
        ],
        if (tab == 2) ...<Widget>[
          for (int index = 0; index < over.length; index += 1) _row(context, over[index], false, index > 0),
          if (over.isEmpty) _none(context),
        ],
        Padding(
          padding: const EdgeInsets.all(MachvonV2Space.s16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(context.t('mob.pwf.mine.count', <String, Object>{'shown': all.length, 'total': widget.first.total}), style: text.caption),
              if (_failure != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.pwf.mine.more.failed', <String, Object>{'code': _failure!}), style: text.caption)),
              if (_cursor != null && widget.canLoadMore) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: OutlinedButton(onPressed: _loading ? null : _loadMore, child: Text(context.t('mob.pwf.mine.more.action')))),
            ],
          ),
        ),
        NavRow(label: context.t('mob.pwf.mine.settings'), icon: Icons.tune, dividerAbove: true, onTap: widget.onSettings),
      ],
    );
  }

  Widget _none(BuildContext context) => Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf7.mine.none'), style: context.v2text.body));

  String _groupTitle(BuildContext context, PwfGroup group) => switch (group) {
        PwfGroup.late => context.t('mob.pwf.group.late'),
        PwfGroup.due => context.t('mob.pwf.group.due'),
        PwfGroup.soon => context.t('mob.pwf.group.soon'),
        PwfGroup.ok => context.t('mob.pwf.group.ok'),
        PwfGroup.far => context.t('mob.pwf.group.far'),
        PwfGroup.unknown => context.t('mob.pwf.group.unknown'),
        PwfGroup.done => context.t('mob.pwf.group.done'),
      };

  Widget _row(BuildContext context, PwfMyTask task, bool personal, bool divider) {
    final PwfBand band = personal ? task.personal : task.official;
    // A personal colour is always said to be one, and always comes with the real day (R40); where it differs from the official one, the official one is said too.
    final String? note = !personal || task.status.isFinal
        ? null
        : (task.personalDiffers
            ? context.t('mob.pwf6.mine.note', <String, Object>{'personal': context.t('mob.pwf.mine.row.personal'), 'official': context.t('mob.pwf.mine.row.official', <String, Object>{'words': pwfDeadlineWords(context, task.official)})})
            : context.t('mob.pwf.mine.row.personal'));
    // The deadline is a line of its own under the name, across the width of the row, and the note of a personal colour a line under it: in a narrow end column they
    // broke into five lines and squeezed the name of the task. The code of the task is not on the row (it is among the facts of the task).
    final String? forecast = pwfForecastWords(context, status: task.status, dueDay: task.dueDate, forecastDay: task.forecastFinish);
    final List<String> facts = <String>[task.projectCode, if (task.critical) context.t('mob.pwf.mine.row.critical')].where((String part) => part.isNotEmpty).toList();
    return WorkRow(
      title: task.name,
      titleMaxLines: 3,
      subtitle: facts.isEmpty ? null : facts.join(' · '),
      leading: PwfGlyph(band: band, status: task.status),
      footer: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          PwfDeadlineLine(band: band, status: task.status, dueDay: task.dueDate, forecastDay: task.forecastFinish),
          if (note != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(note, style: context.v2text.caption)),
        ],
      ),
      trailing: Icon(Icons.chevron_right, color: context.v2.palette.ink3),
      onTap: () => widget.onOpenTask(task),
      semanticLabel: pwfSpokenRow(context, title: task.name, facts: facts, band: band, status: task.status, dueDay: task.dueDate, note: <String>[?forecast, ?note].isEmpty ? null : <String>[?forecast, ?note].join(', ')),
      dividerAbove: divider,
    );
  }
}
