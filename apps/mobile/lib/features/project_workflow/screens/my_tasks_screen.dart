import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/di/providers.dart' show apiClientProvider;
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/state_view.dart';
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
enum PwfGroup { late, soon, ok, far, unknown, done }

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
    PwfBandKind.red => PwfGroup.late,
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
    return ListView(
      padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom + MachvonV2Size.rowMinHeight + MachvonV2Space.s32),
      children: <Widget>[
        FilterChips<PwfColourMode>(
          options: <ChipOption<PwfColourMode>>[
            ChipOption<PwfColourMode>(value: PwfColourMode.personal, label: context.t('mob.pwf.mine.mode.personal')),
            ChipOption<PwfColourMode>(value: PwfColourMode.official, label: context.t('mob.pwf.mine.mode.official')),
          ],
          selected: _mode,
          onChanged: (PwfColourMode next) => setState(() => _mode = next),
        ),
        StatusBanner(text: personal ? context.t('mob.pwf.mine.note.personal') : context.t('mob.pwf.mine.note.official'), icon: Icons.info_outline),
        if (personal) WorkRow(title: context.t('mob.pwf.mine.settings'), leading: const Icon(Icons.tune), trailing: const Icon(Icons.chevron_right), onTap: widget.onSettings, semanticLabel: context.t('mob.pwf.mine.settings')),
        for (final PwfGroup group in PwfGroup.values)
          if (groups[group]!.isNotEmpty) ...<Widget>[
            GroupHeader(title: _groupTitle(context, group), count: groups[group]!.length),
            for (int index = 0; index < groups[group]!.length; index += 1) _row(context, groups[group]![index], personal, index > 0),
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
      ],
    );
  }

  String _groupTitle(BuildContext context, PwfGroup group) => switch (group) {
        PwfGroup.late => _mode == PwfColourMode.personal ? context.t('mob.pwf6.group.personalLate') : context.t('mob.pwf.group.late'),
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
    // The note of a personal colour is a line of its own under the row, across its whole width: in the narrow end column it broke into five lines and squeezed the name of the task.
    final Widget row = WorkRow(
      title: task.name,
      subtitle: <String>[task.projectCode, task.code, if (task.critical) context.t('mob.pwf.mine.row.critical')].where((String part) => part.isNotEmpty).join(' · '),
      leading: PwfGlyph(band: band, status: task.status),
      trailing: PwfDeadlineColumn(band: band, status: task.status, dueDay: task.status.isFinal ? null : task.dueDate),
      onTap: () => widget.onOpenTask(task),
      semanticLabel: pwfSpokenRow(context, title: task.name, facts: <String>[task.projectCode, task.code].where((String part) => part.isNotEmpty).toList(), band: band, status: task.status, dueDay: task.dueDate, note: note),
      dividerAbove: divider,
    );
    if (note == null) return row;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        row,
        ExcludeSemantics(
          child: Padding(
            padding: const EdgeInsets.only(left: MachvonV2Space.s16 + MachvonV2Size.glyph + MachvonV2Space.s12, right: MachvonV2Space.s16, bottom: MachvonV2Space.s12),
            child: Text(note, style: context.v2text.caption),
          ),
        ),
      ],
    );
  }
}
