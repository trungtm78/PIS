import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/deadline.dart';
import '../../../core/widgets/nav_row.dart';
import '../../../core/widgets/section_panel.dart';
import '../../../core/widgets/stat_strip.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/work_row.dart';
import '../../approval_inbox/approval_models.dart';
import '../../approval_inbox/approval_support.dart' show approvalBandOf, approvalsChangedProvider, businessTypeLabel;
import '../../notification_inbox/notification_labels.dart' show stateLabel, titleOf;
import '../../notification_inbox/notification_models.dart';
import '../../project_workflow/pwf_home_card.dart' show PwfHomeCounts, parsePwfHomeCounts;
import '../../project_workflow/pwf_models.dart';
import '../../project_workflow/pwf_widgets.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/wire.dart';
import '../alerts.dart' show alertsChangedProvider;
import '../widgets/edition_cards.dart';

/// How many rows of each part the home shows; the whole list is one tap away, in the screen that owns it.
const int todayRows = 5;

/// How one part of "today's work" stands: read, not for this person (the server refused the right: the part is not drawn at all), or failed (the part says so and the others stay).
enum TodayPartState { ready, hidden, failed }

/// One part of the home of an officer: what was read, or why there is nothing to draw.
final class TodayPart<T> {
  const TodayPart.ready(T this.value) : state = TodayPartState.ready, errorCode = null;
  const TodayPart.hidden() : state = TodayPartState.hidden, value = null, errorCode = null;
  const TodayPart.failed(String this.errorCode) : state = TodayPartState.failed, value = null;

  final TodayPartState state;
  final T? value;
  final String? errorCode;

  bool get isReady => state == TodayPartState.ready;
}

/// The tasks of the person in their workflows: the first rows by deadline and the counts by official colour.
typedef TodayTasks = ({PwfMyTasks page, PwfHomeCounts? counts});

/// "Today's work" of an officer (R53, lane fix11): only what EVERY member of staff may read about themselves, each part on its own right. Nothing here reads the figures or the alerts of a scope (`home.read`).
final class OfficerToday {
  const OfficerToday({required this.tasks, required this.approvals, required this.notifications});

  final TodayPart<TodayTasks> tasks;
  final TodayPart<List<ApprovalTask>> approvals;
  final TodayPart<NotificationList> notifications;

  int get openTasks => tasks.value?.page.total ?? 0;
  int get waitingApprovals => approvals.value?.length ?? 0;
  List<NotificationItem> get unread => <NotificationItem>[...?notifications.value?.items.where((NotificationItem item) => item.isUnread || item.needsAction)];

  /// Every part that this person has was read and holds nothing: the day is done.
  bool get nothingWaits =>
      tasks.state != TodayPartState.failed &&
      approvals.state != TodayPartState.failed &&
      notifications.state != TodayPartState.failed &&
      openTasks == 0 &&
      waitingApprovals == 0 &&
      unread.isEmpty;
}

Future<({Object? value, ApiError? error})> _attempt(Future<Object?> Function() read) async {
  try {
    return (value: await read(), error: null);
  } on ApiError catch (error) {
    return (value: null, error: error);
  }
}

/// Reads the three parts together: the person's workflow tasks (`getMyTasks`), the approvals that wait for them (`approval_task?mine=true`) and their notifications (`listMyNotifications`). A part the server
/// refuses (403) is marked hidden; a part that failed is named; only the end of the session, or no connection for every part, is the state of the whole screen.
Future<Object?> readOfficerToday(MachvonApiClient client) async {
  final List<({Object? value, ApiError? error})> results = await Future.wait(<Future<({Object? value, ApiError? error})>>[
    _attempt(() => client.getMyTasks(query: const <String, Object?>{'limit': todayRows})),
    _attempt(() => client.execute('get_resources_approval_task', query: const <String, Object?>{'mine': 'true', 'status': 'Pending', 'limit': 50})),
    _attempt(() => client.execute('listMyNotifications', query: const <String, Object?>{'limit': 50})),
  ]);
  for (final ({Object? value, ApiError? error}) result in results) {
    if (result.error != null && result.error!.status == 401) throw result.error!;
  }
  if (results.every((({Object? value, ApiError? error}) result) => result.error != null && result.error!.code == networkErrorCode)) throw results.first.error!;
  String? stateOf(ApiError? error) => error == null ? null : (error.status == 403 ? 'HIDDEN' : error.code);
  return <String, Object?>{
    'today': true,
    'tasks': results[0].value,
    'tasks_state': stateOf(results[0].error),
    'approvals': results[1].value,
    'approvals_state': stateOf(results[1].error),
    'notifications': results[2].value,
    'notifications_state': stateOf(results[2].error),
    'as_of': asRecord(results[0].value)?['as_of'] ?? asRecord(results[1].value)?['as_of'],
  };
}

TodayPart<T> _part<T>(Json row, String name, T? Function(Object? raw) parse) {
  final String? state = filled(row['${name}_state']);
  if (state == 'HIDDEN') return TodayPart<T>.hidden();
  if (state != null) return TodayPart<T>.failed(state);
  final T? parsed = parse(row[name]);
  return parsed == null ? TodayPart<T>.failed('CONTRACT_MISMATCH') : TodayPart<T>.ready(parsed);
}

/// The home of an officer from [readOfficerToday], or null when it is not one.
OfficerToday? parseOfficerToday(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null || row['today'] != true) return null;
  return OfficerToday(
    tasks: _part<TodayTasks>(row, 'tasks', (Object? value) {
      final PwfMyTasks? page = parsePwfMyTasks(value);
      return page == null ? null : (page: page, counts: parsePwfHomeCounts(value));
    }),
    approvals: _part<List<ApprovalTask>>(row, 'approvals', (Object? value) => parseApprovalInbox(value)?.tasks),
    notifications: _part<NotificationList>(row, 'notifications', parseNotificationList),
  );
}

/// The home tab of a person who decides nothing for a unit: the title, then their own workflow tasks by deadline, the approvals that wait for them and their unread notifications. The title is drawn with the
/// content, once it is read: it is what a cold start is timed to (docs/qa/perf-budget.json, `mobile.coldStart`).
class OfficerTodayBody extends ConsumerStatefulWidget {
  const OfficerTodayBody({super.key});

  @override
  ConsumerState<OfficerTodayBody> createState() => _OfficerTodayBodyState();
}

class _OfficerTodayBodyState extends ConsumerState<OfficerTodayBody> {
  int _retry = 0;

  @override
  Widget build(BuildContext context) {
    return DataView<OfficerToday>(
      cacheKey: 'home.today',
      reloadKey: (_retry, ref.watch(alertsChangedProvider), ref.watch(approvalsChangedProvider)),
      read: readOfficerToday,
      parse: parseOfficerToday,
      builder: (BuildContext context, Loaded<OfficerToday> loaded) => _TodayList(today: loaded.value, onRetry: () => setState(() => _retry += 1)),
    );
  }
}

class _TodayList extends StatelessWidget {
  const _TodayList({required this.today, required this.onRetry});

  final OfficerToday today;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final TodayTasks? tasks = today.tasks.value;
    final PwfHomeCounts? counts = tasks?.counts;
    final List<ApprovalTask> approvals = today.approvals.value ?? const <ApprovalTask>[];
    final List<NotificationItem> unread = today.unread;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        const AppTopBar(showBack: false),
        LargeTitleHeader(title: context.t('mob.home.officer.title')),
        const EditionHomeHeader(),
        StatStrip(
          cells: <StatCell>[
            if (today.tasks.isReady)
              StatCell(
                value: '${today.openTasks}',
                label: context.t('mob.home.officer.openCount.label'),
                band: counts != null && counts.red > 0 ? DeadlineBand.late : null,
                bandText: counts != null && counts.red > 0 ? context.t('mob.home.today.stat.red', <String, Object>{'count': counts.red}) : null,
              ),
            if (today.approvals.isReady) StatCell(value: '${approvals.length}', label: context.t('mob.home.today.stat.approvals')),
            if (today.notifications.isReady) StatCell(value: '${unread.length}', label: context.t('mob.home.today.stat.unread')),
          ],
        ),
        if (today.nothingWaits)
          SizedBox(
            height: 320,
            child: StateView(kind: StateKind.empty, icon: Icons.check_circle_outline, title: context.t('mob.home.officer.done.title'), body: context.t('mob.home.today.done.body')),
          ),
        if (today.tasks.state == TodayPartState.failed)
          _FailedPart(title: context.t('mob.pwf6.home.title'), onRetry: onRetry)
        else if (tasks != null && tasks.page.items.isNotEmpty)
          SectionPanel(
            title: context.t('mob.pwf6.home.title'),
            padded: false,
            children: <Widget>[
              for (final (int index, PwfMyTask task) in tasks.page.items.take(todayRows).indexed) _taskRow(context, task, index > 0),
              NavRow(
                label: tasks.page.total > todayRows ? context.t('mob.home.today.tasks.all', <String, Object>{'count': tasks.page.total}) : context.t('mob.pwf.entry.tasks'),
                icon: Icons.event_available_outlined,
                dividerAbove: true,
                onTap: () => openScreen(context, 'MOB-80'),
              ),
            ],
          ),
        if (today.approvals.state == TodayPartState.failed)
          _FailedPart(title: context.t('mob.home.today.approvals.title'), onRetry: onRetry)
        else if (approvals.isNotEmpty)
          SectionPanel(
            title: context.t('mob.home.today.approvals.title'),
            padded: false,
            children: <Widget>[
              for (final (int index, ApprovalTask task) in approvals.take(todayRows).indexed) _approvalRow(context, task, index > 0),
              NavRow(label: context.t('mob.home.today.approvals.all', <String, Object>{'count': approvals.length}), icon: Icons.fact_check_outlined, dividerAbove: true, onTap: () => openScreen(context, 'MOB-23')),
            ],
          ),
        if (today.notifications.state == TodayPartState.failed)
          _FailedPart(title: context.t('mob.home.today.inbox.title'), onRetry: onRetry)
        else if (unread.isNotEmpty)
          SectionPanel(
            title: context.t('mob.home.today.inbox.title'),
            padded: false,
            children: <Widget>[
              for (final (int index, NotificationItem item) in unread.take(todayRows).indexed)
                WorkRow(
                  title: titleOf(context, item),
                  subtitle: stateLabel(context, item),
                  leading: Icon(item.needsAction ? Icons.notification_important_outlined : Icons.notifications_none, color: context.v2.palette.ink2),
                  trailing: Icon(Icons.chevron_right, color: context.v2.palette.ink3),
                  dividerAbove: index > 0,
                  onTap: () => openScreen(context, 'MOB-32'),
                ),
              NavRow(label: context.t('mob.home.today.inbox.all', <String, Object>{'count': unread.length}), icon: Icons.notifications_outlined, dividerAbove: true, onTap: () => openScreen(context, 'MOB-32')),
            ],
          ),
        const EditionHomeCards(),
      ],
    );
  }

  Widget _taskRow(BuildContext context, PwfMyTask task, bool divider) {
    final List<String> facts = <String>[task.projectCode, if (task.critical) context.t('mob.pwf.mine.row.critical')].where((String part) => part.isNotEmpty).toList();
    return WorkRow(
      title: task.name,
      titleMaxLines: 3,
      subtitle: facts.isEmpty ? null : facts.join(' · '),
      leading: PwfGlyph(band: task.official, status: task.status),
      footer: PwfDeadlineLine(band: task.official, status: task.status, dueDay: task.dueDate, forecastDay: task.forecastFinish),
      trailing: Icon(Icons.chevron_right, color: context.v2.palette.ink3),
      semanticLabel: pwfSpokenRow(context, title: task.name, facts: facts, band: task.official, status: task.status, dueDay: task.dueDate),
      dividerAbove: divider,
      onTap: () => openScreen(context, 'MOB-79', pathSuffix: '/${Uri.encodeComponent(task.taskId)}'),
    );
  }

  Widget _approvalRow(BuildContext context, ApprovalTask task, bool divider) {
    final DeadlineBand band = approvalBandOf(task);
    final String due = context.t('mob.apv.inbox.row.dueShort', <String, Object>{'day': formatDayShort(task.dueAt)});
    return WorkRow(
      title: businessTypeLabel(context, task.businessType),
      subtitle: <String>[if (task.stepName.isNotEmpty) task.stepName, if (task.initiatorName != null) context.t('mob.apv.inbox.row.sender', <String, Object>{'name': task.initiatorName!})].join(' · '),
      leading: DeadlineGlyph(band: band),
      trailing: DeadlineLabel(band: band, text: task.overdue ? context.t('mob.apv.inbox.row.late') : due, dueDay: task.dueAt),
      dividerAbove: divider,
      onTap: () => openScreen(context, 'MOB-24', pathSuffix: '/${Uri.encodeComponent(task.id)}'),
    );
  }
}

/// A part that could not be read: its name, that it could not be read, and its own retry. The other parts stay on the screen.
class _FailedPart extends StatelessWidget {
  const _FailedPart({required this.title, required this.onRetry});

  final String title;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return SectionPanel(
      title: title,
      children: <Widget>[
        Text(context.t('mob.home.today.part.failed'), style: context.v2text.body),
        Align(alignment: AlignmentDirectional.centerStart, child: TextButton(onPressed: onRetry, child: Text(context.t('mob.read.refresh.action')))),
      ],
    );
  }
}
