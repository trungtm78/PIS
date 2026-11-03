import '../read_support/wire.dart';

/// The category that stands for every category of events.
const String allCategories = '*';

/// The channels of a notification, in the order of the screen.
const List<String> preferenceChannels = <String>['IN_APP', 'PUSH', 'EMAIL', 'ZALO', 'WHATSAPP', 'SMS'];
const List<String> digestModes = <String>['IMMEDIATE', 'HOURLY', 'DAILY'];

/// The zones the screen offers; the zone the person has saved is always offered too.
const List<String> timeZones = <String>['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/Paris', 'America/New_York', 'UTC'];

const int maxPreferenceItems = 200;
final RegExp _clock = RegExp(r'^([01][0-9]|2[0-3]):[0-5][0-9]$');

String cellKey(String category, String channel) => '$category|$channel';

/// The preferences as the server holds them (`getMyNotificationPreferences`).
final class PreferenceView {
  const PreferenceView({
    required this.version,
    required this.isDefault,
    required this.timeZone,
    required this.off,
    required this.digest,
    required this.categories,
    required this.locked,
    this.quietStart,
    this.quietEnd,
  });

  /// The version a save is made under; 0 for a person who never saved.
  final int version;
  final bool isDefault;
  final String timeZone;
  final String? quietStart;
  final String? quietEnd;

  /// `category|channel` of every cell that is switched off.
  final Set<String> off;

  /// The digest mode of a category (every channel of it); absent means immediate.
  final Map<String, String> digest;

  /// The categories shown as rows besides every category.
  final List<String> categories;

  /// The channels the person cannot switch off: the inbox of the categories that hold an urgent event.
  final List<({String category, String channel})> locked;

  bool get quietOn => quietStart != null && quietEnd != null;

  /// Whether the person cannot change the cell: the inbox of a category that holds an urgent event (or of every category when
  /// any does).
  bool isLocked(String category, String channel) =>
      channel == 'IN_APP' && locked.any((({String category, String channel}) entry) => category == allCategories || entry.category == category);
}

/// The preferences, or null when the answer is not readable: the version in it decides what a save overwrites, so a reading that
/// cannot be trusted is refused as a whole.
PreferenceView? parsePreferences(Object? raw) {
  final Json? view = asRecord(raw);
  final int? version = whole(view?['version']);
  final String? zone = filled(view?['time_zone']);
  if (view == null || version == null || version < 0 || zone == null || view['items'] is! List) return null;
  final Set<String> off = <String>{};
  final Map<String, String> digest = <String, String>{};
  final Set<String> categories = <String>{};
  for (final Object? entry in listOf(view['items'])) {
    final Json? item = asRecord(entry);
    final String? category = filled(item?['event_category']);
    final String? channel = text(item?['channel']);
    if (item == null || category == null || channel == null || !preferenceChannels.contains(channel) || item['enabled'] is! bool) return null;
    if (item['enabled'] == false) off.add(cellKey(category, channel));
    final String mode = text(item['digest_mode']) ?? 'IMMEDIATE';
    if (digestModes.contains(mode) && mode != 'IMMEDIATE') digest[category] = mode;
    if (category != allCategories) categories.add(category);
  }
  final List<({String category, String channel})> locked = <({String category, String channel})>[];
  for (final Object? entry in listOf(view['locked'])) {
    final Json? item = asRecord(entry);
    final String? category = filled(item?['event_category']);
    final String? channel = text(item?['channel']);
    if (category != null && channel != null && preferenceChannels.contains(channel)) {
      locked.add((category: category, channel: channel));
      if (category != allCategories) categories.add(category);
    }
  }
  return PreferenceView(
    version: version,
    isDefault: view['is_default'] == true,
    timeZone: zone,
    quietStart: filled(view['quiet_start']),
    quietEnd: filled(view['quiet_end']),
    off: off,
    digest: digest,
    categories: categories.toList()..sort(),
    locked: locked,
  );
}

/// What the person is editing.
final class PreferenceDraft {
  PreferenceDraft({
    required this.off,
    required this.digest,
    required this.categories,
    required this.quietOn,
    required this.quietStart,
    required this.quietEnd,
    required this.timeZone,
  });

  /// The draft a reading starts from; the quiet hours default to 21:00 - 07:00 when none were saved.
  factory PreferenceDraft.of(PreferenceView view) => PreferenceDraft(
        off: <String>{...view.off},
        digest: <String, String>{...view.digest},
        categories: <String>[...view.categories],
        quietOn: view.quietOn,
        quietStart: view.quietStart ?? '21:00',
        quietEnd: view.quietEnd ?? '07:00',
        timeZone: view.timeZone,
      );

  final Set<String> off;
  final Map<String, String> digest;
  final List<String> categories;
  bool quietOn;
  String quietStart;
  String quietEnd;
  String timeZone;

  void toggle(String category, String channel) {
    final String key = cellKey(category, channel);
    if (!off.remove(key)) off.add(key);
  }
}

/// What the quiet hours lack: both are clock times and they differ.
enum QuietProblem { clock, empty }

QuietProblem? quietProblem(PreferenceDraft draft) {
  if (!draft.quietOn) return null;
  if (!_clock.hasMatch(draft.quietStart) || !_clock.hasMatch(draft.quietEnd)) return QuietProblem.clock;
  return draft.quietStart == draft.quietEnd ? QuietProblem.empty : null;
}

/// The body of a save: a cell is sent when it is off or its category has a digest mode; everything else is on by default.
Map<String, Object?> preferenceBody(PreferenceDraft draft) {
  final List<Map<String, Object?>> items = <Map<String, Object?>>[];
  for (final String category in <String>[allCategories, ...draft.categories]) {
    final String mode = draft.digest[category] ?? 'IMMEDIATE';
    for (final String channel in preferenceChannels) {
      final bool enabled = !draft.off.contains(cellKey(category, channel));
      if (!enabled || mode != 'IMMEDIATE') items.add(<String, Object?>{'event_category': category, 'channel': channel, 'enabled': enabled, 'digest_mode': mode});
    }
  }
  return <String, Object?>{
    'items': items,
    if (draft.quietOn) 'quiet_start': draft.quietStart,
    if (draft.quietOn) 'quiet_end': draft.quietEnd,
    'time_zone': draft.timeZone,
  };
}

bool tooManyItems(PreferenceDraft draft) => (preferenceBody(draft)['items']! as List<Object?>).length > maxPreferenceItems;

/// What a refused save means to the person.
enum PreferenceProblem { locked, stale, invalid, denied, session, general }

PreferenceProblem preferenceProblemOf(String code) {
  switch (code) {
    case 'MANDATORY_CHANNEL_LOCKED':
      return PreferenceProblem.locked;
    case 'VERSION_CONFLICT':
      return PreferenceProblem.stale;
    case 'VALIDATION_FAILED':
      return PreferenceProblem.invalid;
    case 'SCOPE_DENIED':
      return PreferenceProblem.denied;
    case 'SESSION_EXPIRED':
      return PreferenceProblem.session;
    default:
      return PreferenceProblem.general;
  }
}
