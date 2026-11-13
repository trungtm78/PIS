import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/format/format.dart';
import '../read_support/wire.dart';

/// The three levels of an alert. Each has an icon and a word on the screen, never a colour alone. An item the server sends
/// without a level is a task to do (ACTION): the contract adds the field and an older server omits it.
enum AlertSeverity { urgent, action, watch }

/// Where an alert is in its life. Read is not handled: only the server closes an alert, when its source record is handled.
enum AlertLifecycle { fresh, claimed, inProgress, resolved }

const Map<String, AlertSeverity> _severities = <String, AlertSeverity>{
  'URGENT': AlertSeverity.urgent,
  'ACTION': AlertSeverity.action,
  'WATCH': AlertSeverity.watch,
};

const Map<String, AlertLifecycle> _lifecycles = <String, AlertLifecycle>{
  'NEW': AlertLifecycle.fresh,
  'CLAIMED': AlertLifecycle.claimed,
  'IN_PROGRESS': AlertLifecycle.inProgress,
  'RESOLVED': AlertLifecycle.resolved,
};

/// A person named on an alert: who claimed it (and when) or who it was given to (and by when).
final class AlertPerson {
  const AlertPerson({required this.name, this.at, this.dueOn});

  final String name;
  final String? at;
  final String? dueOn;
}

AlertPerson? _person(Object? raw) {
  final Json? row = asRecord(raw);
  final String? name = filled(row?['name']);
  if (row == null || name == null) return null;
  return AlertPerson(name: name, at: filled(row['at']), dueOn: filled(row['due_on']));
}

/// The step of the chain of escalation the alert is at (`level` of `of`) and when it goes up.
final class AlertEscalation {
  const AlertEscalation({required this.level, required this.of, this.nextAt});

  final int level;
  final int of;
  final String? nextAt;
}

AlertEscalation? _escalation(Object? raw) {
  final Json? row = asRecord(raw);
  final int? level = whole(row?['level']);
  if (row == null || level == null) return null;
  final int chain = listOf(row['chain']).length;
  return AlertEscalation(level: level, of: whole(row['of']) ?? (chain > 0 ? chain : level), nextAt: filled(row['next_at']));
}

/// What the server says about the snooze an alert is under: who, until when, why, and the place in the run (`ordinal` of `of`).
final class AlertSnooze {
  const AlertSnooze({required this.ordinal, required this.of, required this.isFinal, this.by, this.until, this.reasonCode, this.note, this.policyVersion});

  final AlertPerson? by;
  final String? until;
  final String? reasonCode;
  final String? note;
  final int ordinal;
  final int of;

  /// The last snooze the policy allows: the next level up is told.
  final bool isFinal;
  final int? policyVersion;
}

AlertSnooze? _snooze(Object? raw) {
  final Json? row = asRecord(raw);
  final int? ordinal = whole(row?['ordinal']);
  if (row == null || ordinal == null) return null;
  final int of = whole(row['of']) ?? ordinal;
  return AlertSnooze(
    by: _person(row['by']),
    until: filled(row['until']),
    reasonCode: filled(row['reason_code']),
    note: filled(row['note']),
    ordinal: ordinal,
    of: of,
    isFinal: row['final'] == true,
    policyVersion: whole(row['policy_version']),
  );
}

/// The state of a clock of an obligation: the time to take the item up (`claim`) or to resolve it (`resolve`), in working hours.
enum ClockState { running, paused, met, metLate, breached }

const Map<String, ClockState> _clockStates = <String, ClockState>{
  'RUNNING': ClockState.running,
  'PAUSED': ClockState.paused,
  'MET': ClockState.met,
  'MET_LATE': ClockState.metLate,
  'BREACHED': ClockState.breached,
};

final class AlertClock {
  const AlertClock({required this.state, this.startedAt, this.dueAt, this.metAt});

  final ClockState state;
  final String? startedAt;

  /// The due instant (ISO 8601), already counted in working hours by the server.
  final String? dueAt;
  final String? metAt;
}

AlertClock? _clock(Object? raw) {
  final Json? row = asRecord(raw);
  final ClockState? state = _clockStates[row?['state']];
  if (row == null || state == null) return null;
  return AlertClock(state: state, startedAt: filled(row['started_at']), dueAt: filled(row['due_at']), metAt: filled(row['met_at']));
}

/// Where the clocks come from: the published working calendar, no calendar yet, or no starting point.
enum ClockBasis { workingTime, calendarUnavailable, noStart }

const Map<String, ClockBasis> _clockBases = <String, ClockBasis>{
  'WORKING_TIME': ClockBasis.workingTime,
  'CALENDAR_UNAVAILABLE': ClockBasis.calendarUnavailable,
  'NO_START': ClockBasis.noStart,
};

final class AlertClocks {
  const AlertClocks({required this.basis, this.claim, this.resolve, this.paused = false, this.needsReclaim = false});

  final ClockBasis basis;
  final AlertClock? claim;
  final AlertClock? resolve;
  final bool paused;
  final bool needsReclaim;
}

AlertClocks? _clocks(Object? raw) {
  final Json? row = asRecord(raw);
  final ClockBasis? basis = _clockBases[row?['basis']];
  if (row == null || basis == null) return null;
  return AlertClocks(basis: basis, claim: _clock(row['claim']), resolve: _clock(row['resolve']), paused: row['paused'] == true, needsReclaim: row['needs_reclaim'] == true);
}

/// A pause of the clocks the server granted (the web grants it; the phone only shows it).
final class AlertPause {
  const AlertPause({this.from, this.until, this.resumedAt, this.reasonCode, this.reason, this.allowedBy});

  final String? from;
  final String? until;
  final String? resumedAt;
  final String? reasonCode;
  final String? reason;
  final AlertPerson? allowedBy;

  bool get active => resumedAt == null;
}

AlertPause? _pause(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null || row.isEmpty) return null;
  return AlertPause(
    from: filled(row['from']),
    until: filled(row['until']),
    resumedAt: filled(row['resumed_at']),
    reasonCode: filled(row['reason_code']),
    reason: filled(row['reason']),
    allowedBy: _person(row['allowed_by']),
  );
}

/// The reminders sent for an alert and when the next one is due.
final class AlertReminders {
  const AlertReminders({required this.sent, required this.due, required this.exhausted, this.nextAt});

  final int sent;
  final String? nextAt;
  final bool due;
  final bool exhausted;
}

AlertReminders? _reminders(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null || row.isEmpty) return null;
  return AlertReminders(sent: count(row['sent']), nextAt: filled(row['next_at']), due: row['due'] == true, exhausted: row['exhausted'] == true);
}

/// One thing the server asks of the person (`getMyWork`), in the vocabulary of the alert centre.
final class AlertItem {
  const AlertItem({
    required this.id,
    required this.source,
    required this.severity,
    required this.title,
    required this.lifecycle,
    required this.overdue,
    required this.daysLate,
    required this.targetScreen,
    required this.targetId,
    this.subtitle,
    this.dueOn,
    this.consequence,
    this.claimedBy,
    this.assignee,
    this.escalation,
    this.snoozedUntil,
    this.startedAt,
    this.expectedAction,
    this.needsReclaim = false,
    this.snooze,
    this.snoozeCount = 0,
    this.pause,
    this.clocks,
    this.reminders,
  });

  final String id;

  /// The module source (`APPROVAL`, `PERMIT`, ...); the old `kind` when the server sends no source yet.
  final String source;
  final AlertSeverity severity;
  final String title;
  final String? subtitle;
  final String? dueOn;
  final AlertLifecycle lifecycle;
  final bool overdue;
  final int daysLate;
  final String targetScreen;
  final String targetId;
  final String? consequence;
  final AlertPerson? claimedBy;
  final AlertPerson? assignee;
  final AlertEscalation? escalation;
  final String? snoozedUntil;

  /// When the obligation started and what the server expects of the person (null from an older server).
  final String? startedAt;
  final String? expectedAction;

  /// Taken up and then silent: the person must take it up again.
  final bool needsReclaim;
  final AlertSnooze? snooze;

  /// How many snoozes in a row the alert has had.
  final int snoozeCount;
  final AlertPause? pause;
  final AlertClocks? clocks;
  final AlertReminders? reminders;

  bool get isUrgent => severity == AlertSeverity.urgent;

  /// Nobody has taken it yet.
  bool get unclaimed => claimedBy == null && assignee == null && lifecycle == AlertLifecycle.fresh;

  /// An urgent alert cannot be snoozed (the server refuses it too).
  bool get canSnooze => !isUrgent;

  /// It can be taken: nobody has it, or it was taken and went silent.
  bool get canClaim => unclaimed || needsReclaim;

  /// The snoozes used in a row: the count the server gives, or the place of the snooze it reports.
  int get snoozesUsed => snoozeCount > (snooze?.ordinal ?? 0) ? snoozeCount : (snooze?.ordinal ?? 0);

  /// Until when the clocks are paused, while the pause lasts.
  String? get pausedUntil => pause != null && pause!.active ? pause!.until : null;
}

AlertItem? _alertItem(Object? raw) {
  final Json? row = asRecord(raw);
  final Json? target = asRecord(row?['target']);
  final String? id = filled(row?['id']);
  final String? screen = filled(target?['screen']);
  if (row == null || id == null || screen == null) return null;
  final AlertLifecycle lifecycle = _lifecycles[row['lifecycle']] ?? AlertLifecycle.fresh;
  final AlertClocks? clocks = _clocks(row['clocks']);
  return AlertItem(
    id: id,
    source: filled(row['source']) ?? filled(row['kind']) ?? '',
    severity: _severities[row['severity']] ?? AlertSeverity.action,
    title: text(row['title']) ?? '',
    subtitle: filled(row['subtitle']),
    dueOn: filled(row['due_on']),
    lifecycle: lifecycle,
    overdue: row['overdue'] == true || row['bucket'] == 'OVERDUE',
    daysLate: count(row['days_late']),
    targetScreen: screen,
    targetId: text(target?['id']) ?? '',
    consequence: filled(row['consequence']),
    claimedBy: _person(row['claimed_by']),
    assignee: _person(row['assignee']),
    escalation: _escalation(row['escalation']),
    snoozedUntil: filled(row['snoozed_until']),
    startedAt: filled(row['started_at']),
    expectedAction: filled(row['expected_action']),
    needsReclaim: row['needs_reclaim'] == true || clocks?.needsReclaim == true,
    snooze: _snooze(row['snooze']),
    snoozeCount: count(row['snooze_count']),
    pause: _pause(row['pause']),
    clocks: clocks,
    reminders: _reminders(row['reminders']),
  );
}

/// The most important first: by level, then late before not late (the longest late first), then the nearest due day.
int compareAlerts(AlertItem a, AlertItem b) {
  final int bySeverity = a.severity.index.compareTo(b.severity.index);
  if (bySeverity != 0) return bySeverity;
  if (a.overdue != b.overdue) return a.overdue ? -1 : 1;
  if (a.overdue && a.daysLate != b.daysLate) return b.daysLate.compareTo(a.daysLate);
  final String? dueA = a.dueOn;
  final String? dueB = b.dueOn;
  if (dueA != dueB) {
    if (dueA == null) return 1;
    if (dueB == null) return -1;
    final int byDue = dueA.compareTo(dueB);
    if (byDue != 0) return byDue;
  }
  return a.id.compareTo(b.id);
}

/// How many alerts there are at each level (the whole list, whatever page was read).
final class AlertCounts {
  const AlertCounts({required this.urgent, required this.action, required this.watch});

  final int urgent;
  final int action;
  final int watch;

  int get total => urgent + action + watch;

  /// What is asked of the person now: the badge of the tab counts these two levels, not the ones only watched.
  int get needsDoing => urgent + action;

  int of(AlertSeverity severity) {
    switch (severity) {
      case AlertSeverity.urgent:
        return urgent;
      case AlertSeverity.action:
        return action;
      case AlertSeverity.watch:
        return watch;
    }
  }
}

/// The alerts of one view and the sources that could not be read.
final class AlertFeed {
  const AlertFeed({required this.items, required this.counts, required this.unavailableSources, required this.truncated, this.asOf, this.view});

  final List<AlertItem> items;
  final AlertCounts counts;

  /// The sources that failed: they are named, and the screen never says "no work" while one is missing.
  final List<String> unavailableSources;
  final bool truncated;
  final String? asOf;

  /// `mine` or `scope`: the view the answer is of, as the server says it (null when it does not).
  final String? view;

  bool get isComplete => unavailableSources.isEmpty;
  bool get isEmpty => items.isEmpty;

  /// The first [limit] alerts, most important first.
  List<AlertItem> top(int limit) => items.length <= limit ? items : items.sublist(0, limit);
}

/// The alerts from the answer of `getMyWork`, or null when the answer is not a list. Items the screen cannot open (no target) and
/// resolved ones are left out; a count the server does not give is counted from the items.
AlertFeed? parseAlertFeed(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null || row['items'] is! List) return null;
  final List<AlertItem> items = <AlertItem>[
    for (final Object? entry in listOf(row['items']))
      if (_alertItem(entry) case final AlertItem item when item.lifecycle != AlertLifecycle.resolved) item,
  ]..sort(compareAlerts);
  final Json? rawCounts = asRecord(row['counts']);
  int counted(AlertSeverity severity) => items.where((AlertItem item) => item.severity == severity).length;
  final bool serverCounts = rawCounts != null && (rawCounts.containsKey('urgent') || rawCounts.containsKey('action') || rawCounts.containsKey('watch'));
  return AlertFeed(
    items: items,
    counts: serverCounts
        ? AlertCounts(urgent: count(rawCounts['urgent']), action: count(rawCounts['action']), watch: count(rawCounts['watch']))
        : AlertCounts(urgent: counted(AlertSeverity.urgent), action: counted(AlertSeverity.action), watch: counted(AlertSeverity.watch)),
    unavailableSources: <String>[for (final Object? source in listOf(row['unavailable_sources'])) ?filled(source)],
    truncated: row['truncated'] == true,
    asOf: filled(row['as_of']),
    view: filled(row['view']),
  );
}

/// The counts of `getMyWorkCounts` (`{view, counts: {urgent, action, watch, total}, unavailable_sources, as_of}`), or null.
AlertCounts? parseAlertCounts(Object? raw) {
  final Json? counts = asRecord(asRecord(raw)?['counts']);
  if (counts == null || !(counts.containsKey('urgent') || counts.containsKey('action') || counts.containsKey('watch'))) return null;
  return AlertCounts(urgent: count(counts['urgent']), action: count(counts['action']), watch: count(counts['watch']));
}

/// The page size of the alert list on the home and in the inbox.
const int alertPageSize = 20;

/// Reads the alerts of [view]. A leader asks for the whole scope (`scope`); a role that may not read it is refused, and the
/// alerts of the person (`mine`) are read instead, so the home is never left without them.
Future<Json> readAlertFeed(MachvonApiClient client, {String view = 'mine', bool fallbackToMine = false}) async {
  Future<Json> read(String which) async {
    final Json? body = asRecord(await client.getMyWork(query: <String, Object?>{'view': which, 'limit': alertPageSize}));
    if (body == null) throw ApiError.unusableAnswer(200, 'my-work');
    return body;
  }

  try {
    return await read(view);
  } on ApiError catch (error) {
    final bool refused = error.status == 400 || error.status == 403 || error.status == 422;
    if (view == 'mine' || !fallbackToMine || !refused) rethrow;
    return <String, Object?>{...await read('mine'), 'view': 'mine', 'scope_refused': true};
  }
}

/// Counts changes made to the alerts on this device (a push arrived, an alert was claimed or given), so the screens that show
/// them read again.
class AlertsChanged extends Notifier<int> {
  @override
  int build() => 0;

  void bump() => state += 1;
}

final NotifierProvider<AlertsChanged, int> alertsChangedProvider = NotifierProvider<AlertsChanged, int>(AlertsChanged.new);

// ---- the countdown ------------------------------------------------------------------------------------------------------------

enum AlertDueKind { none, remainingDays, remainingHours, today, overdueDays, overdueHours, overdue }

/// What the countdown line says, before it is put into words: the remaining time and the absolute day. Never seconds.
final class AlertDue {
  const AlertDue(this.kind, {this.amount = 0, this.day, this.time});

  final AlertDueKind kind;
  final int amount;

  /// `dd/MM` of the due day.
  final String? day;

  /// `HH:mm` of the due instant when the server gave one.
  final String? time;

  bool get isOverdue => kind == AlertDueKind.overdueDays || kind == AlertDueKind.overdueHours || kind == AlertDueKind.overdue;
}

final RegExp _dayOnly = RegExp(r'^\d{4}-\d{2}-\d{2}$');

String _dayMonth(String ddMmYyyy) => ddMmYyyy.substring(0, 5);

/// The countdown of an alert at [now]. Whether it is late is the word of the server (`overdue`, `days_late`); the clock of the
/// phone only counts the days or hours that remain before a due day the server named.
AlertDue describeDue(AlertItem item, DateTime now) {
  final String? due = item.dueOn;
  if (item.overdue) {
    if (item.daysLate > 0) return AlertDue(AlertDueKind.overdueDays, amount: item.daysLate, day: due == null ? null : _dayMonth(formatDay(due)));
    if (due == null || _dayOnly.hasMatch(due)) return AlertDue(AlertDueKind.overdue, day: due == null ? null : _dayMonth(formatDay(due)));
  }
  if (due == null) return const AlertDue(AlertDueKind.none);
  if (_dayOnly.hasMatch(due)) {
    final DateTime dueDay = DateTime.utc(int.parse(due.substring(0, 4)), int.parse(due.substring(5, 7)), int.parse(due.substring(8, 10)));
    final String todayText = vietnamDayOf(now);
    final DateTime today = DateTime.utc(int.parse(todayText.substring(0, 4)), int.parse(todayText.substring(5, 7)), int.parse(todayText.substring(8, 10)));
    final int days = dueDay.difference(today).inDays;
    final String day = _dayMonth(formatDay(due));
    if (days > 0) return AlertDue(AlertDueKind.remainingDays, amount: days, day: day);
    if (days == 0) return AlertDue(AlertDueKind.today, day: day);
    return AlertDue(AlertDueKind.overdueDays, amount: -days, day: day);
  }
  return describeInstant(due, now);
}

/// The countdown to an instant (ISO 8601) at [now]: hours under a day, else days; late the same way. Never seconds.
AlertDue describeInstant(String due, DateTime now) {
  final DateTime? instant = DateTime.tryParse(due);
  if (instant == null) return const AlertDue(AlertDueKind.none);
  final String moment = formatMoment(due);
  final String day = _dayMonth(moment);
  final String time = moment.substring(moment.length - 5);
  final Duration left = instant.difference(now);
  if (left.isNegative) {
    final Duration late = -left;
    return late.inHours < 24 ? AlertDue(AlertDueKind.overdueHours, amount: late.inHours < 1 ? 1 : late.inHours, day: day, time: time) : AlertDue(AlertDueKind.overdueDays, amount: late.inDays, day: day, time: time);
  }
  if (left.inHours < 24) return AlertDue(AlertDueKind.remainingHours, amount: left.inHours, day: day, time: time);
  return AlertDue(AlertDueKind.remainingDays, amount: left.inDays, day: day, time: time);
}

// ---- where an alert opens ----------------------------------------------------------------------------------------------------

/// Every module source the contract names (`WorkSource` of `WorkActionTarget`). A test compares this list with the contract, and
/// another asserts that each one has a label, so a source added to the contract cannot reach the phone as a bare code.
const List<String> kAlertSources = <String>[
  'APPROVAL', 'EXPLANATION', 'EXPLANATION_CONCLUDE', 'REPORT', 'OBLIGATION', 'EARLY_WARNING', 'ADVANCE', 'PERMIT', 'AUDIT_RECOMMENDATION',
  'ISSUE', 'SITE_DIARY', 'GUARANTEE', 'MONEY_CONTROL', 'DIRECTIVE', 'CLOCK', 'PROCUREMENT_WORKFLOW', 'TREASURY_RECON', 'CROSS_TOTAL',
  'SOD_EXCEPTION', 'PAYMENT_INTEGRITY', 'DISBURSEMENT_EXCEPTION', 'PROJECT_GOVERNANCE', 'CONNECTOR', 'EGP_POSTING', 'VENDOR',
  'CONTRACT_CLAIM', 'CONTRACT_EARLY_WARNING', 'ESCALATION', 'COVERAGE', 'RED_FLAG', 'CONTRACT_CLOCK', 'DOC_REVIEW', 'DATA_FRESHNESS',
  'ANOMALY', 'ALERT_FEEDBACK', 'PAYMENT_CLOCK', 'DISBURSEMENT_FORECAST', 'SETTLEMENT_CLOCK', 'CONTRACT_ADJUSTMENT', 'LOOK_AHEAD',
  'LESSONS_LEARNED', 'PROJECT_RISK', 'COMMITTEE', 'PROJECT_TASK',
];

/// How the web screen an alert names opens on the phone: the screen of the phone, and whether the id of the record goes into its path.
typedef AlertTargetRule = ({String screenId, bool withId});

/// The web screens that alerts name as their target and the screen of the phone each one opens. A web screen that is not here opens
/// nothing: the alert is then handled from its actions, and the web screen is named in the detail.
const Map<String, AlertTargetRule> kAlertTargets = <String, AlertTargetRule>{
  // an approval task
  'ADM-06': (screenId: 'MOB-24', withId: true),
  'MOB-24': (screenId: 'MOB-24', withId: true),
  // a project: its workspace, the look-ahead plan, the baseline, the risk register and the lessons of the project name the project id
  'PRJ-03': (screenId: 'MOB-10', withId: true),
  'PRJ-26': (screenId: 'MOB-10', withId: true),
  'PRJ-28': (screenId: 'MOB-10', withId: true),
  'PRJ-29': (screenId: 'MOB-10', withId: true),
  'PRJ-30': (screenId: 'MOB-10', withId: true),
  'MOB-10': (screenId: 'MOB-10', withId: true),
  // one package of the procurement workflow: its progress and day-by-day timeline
  'BID-29': (screenId: 'MOB-70', withId: true),
  'MOB-70': (screenId: 'MOB-70', withId: true),
  // the directives of the steering meetings (the list carries the directive and its timeline)
  'DIR-04': (screenId: 'DIR-06', withId: false),
  // the steering committee: its alerts are read on the dashboard
  'BAN-05': (screenId: 'MOB-72', withId: false),
  // a contractor: the grade of risk and the performance of its contracts
  'VND-11': (screenId: 'MOB-74', withId: true),
  'VND-12': (screenId: 'MOB-74', withId: true),
  'MOB-74': (screenId: 'MOB-74', withId: true),
  // payments: the clock of the Treasury, the payment and its documents, advances, recovery, the ceiling exceptions: the payment tracking list
  'PAY-22': (screenId: 'MOB-27', withId: false),
  'PAY-03': (screenId: 'MOB-27', withId: false),
  'PAY-12': (screenId: 'MOB-27', withId: false),
  'PAY-18': (screenId: 'MOB-27', withId: false),
  'PAY-21': (screenId: 'MOB-27', withId: false),
  'MOB-27': (screenId: 'MOB-27', withId: false),
  // the daily Treasury reconciliation
  'PAY-20': (screenId: 'MOB-60', withId: false),
  'MOB-60': (screenId: 'MOB-60', withId: false),
  // contracts (claims, early warnings, guarantees, the settlement clock, the adjustments): the contracts and site milestones list
  'CTR-03': (screenId: 'MOB-61', withId: false),
  'CTR-05': (screenId: 'MOB-61', withId: false),
  'CTR-33': (screenId: 'MOB-61', withId: false),
  'CTR-35': (screenId: 'MOB-61', withId: false),
  'CTR-36': (screenId: 'MOB-61', withId: false),
  'CTR-38': (screenId: 'MOB-61', withId: false),
  'CTR-39': (screenId: 'MOB-61', withId: false),
  'MOB-61': (screenId: 'MOB-61', withId: false),
  // the site diary of a contract (the missing-diary alert names the contract)
  'QMS-11': (screenId: 'MOB-62', withId: true),
  'MOB-62': (screenId: 'MOB-62', withId: true),
  // issues: the follow-up screen (MOB-31) is keyed by the local reference of a queued report, so a server issue opens the weekly issues list
  'ISS-03': (screenId: 'MOB-59', withId: false),
  // reports that are returned or overdue: the drafts list
  'DIS-03': (screenId: 'MOB-22', withId: false),
  // the cover of an absence (alert coverage): the delegations and absences view
  'ADM-28': (screenId: 'MOB-75', withId: false),
  'MOB-75': (screenId: 'MOB-75', withId: false),
};

/// The target screens of the server that the phone has no screen for, each once. The alert is then handled from its actions (claim, assign, snooze).
/// A test reads the target screens the server writes and fails when one is in neither table, so a screen added on the server is decided here.
const Set<String> kAlertTargetsWithoutPhoneScreen = <String>{
  // permits (PMT-02): the phone has no permit register; audit (AUD-11 escalations, AUD-13 duty separation, AUD-14 to AUD-16 red flags); the alert dossier
  'PMT-02', 'AUD-11', 'AUD-13', 'AUD-14', 'AUD-15', 'AUD-16', 'HOME-06', 'HOME-30', 'HOME-31', 'NOT-30',
  // administration, data governance, integrations, documents
  'ADM-24', 'DGV-04', 'HUB-03', 'FEED-01', 'FEED-04', 'BID-22', 'BID-32', 'DOC-02',
  // money planning, monthly reports and explanations
  'CAP-07', 'CAP-22', 'PRJ-19', 'PRJ-22', 'MNE-03', 'DIS-26', 'DIS-30',
  // contractor registers and the portal (the phone reads the grade and the performance only)
  'VND-02', 'VND-03', 'VND-04', 'VND-05', 'VND-06', 'VND-07', 'VND-08', 'VND-09', 'VND-10', 'VND-13', 'VND-14', 'VND-15', 'VND-16', 'VND-17',
  'VND-18', 'VND-19', 'VND-20', 'VND-21', 'VND-22',
};

final RegExp _plainId = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

/// The screen of the phone an alert opens, by the web screen its target names (see [kAlertTargets]). Null when the phone has no screen
/// for it (the alert is then handled from its actions). [has] tells whether a screen id is a screen of the phone that takes no
/// parameter; [available] tells whether a screen that takes the record in its path is part of this build (it defaults to yes).
({String screenId, String pathSuffix})? alertScreenOf(AlertItem item, {required bool Function(String screenId) has, bool Function(String screenId)? available}) {
  final AlertTargetRule? rule = kAlertTargets[item.targetScreen];
  if (rule != null) {
    if (rule.withId) {
      if (!_plainId.hasMatch(item.targetId)) return null;
      if (available != null && !available(rule.screenId)) return null;
      return (screenId: rule.screenId, pathSuffix: '/${Uri.encodeComponent(item.targetId)}');
    }
    return has(rule.screenId) ? (screenId: rule.screenId, pathSuffix: '') : null;
  }
  final String screen = item.targetScreen;
  if (screen.startsWith('MOB-') && has(screen)) return (screenId: screen, pathSuffix: '');
  return null;
}
