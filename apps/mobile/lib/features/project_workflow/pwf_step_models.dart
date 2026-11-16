import '../read_support/wire.dart';

/// What the phone reads of the step table of a project (PWF-5): where the colour of a deadline comes from, the time limit with its unit, the unit
/// that receives a task and who has taken it, the extension a step may be given, and the deadline of the whole file. Every one of these members is
/// OPTIONAL in the answer (R67: an app installed before they existed must keep reading, and a server that does not know them keeps answering as it
/// did), so a member that is absent, null or not of the shape stays unknown here and the screen draws what it had before. Nothing is computed: the
/// colour, the days left and the day are the server's (R73).

/// The layer the official thresholds of a task came from (R59), the most specific first: the step of the frozen template, a matching override of the
/// policy, the policy, the default of the system. The screen says it in a sentence ("Theo ngưỡng của bước"), it never recomputes the colour.
enum PwfBandTier {
  step,
  policyOverride,
  policy,
  system;

  static PwfBandTier? parse(Object? value) => switch (value) {
        'STEP' => step,
        'POLICY_OVERRIDE' => policyOverride,
        'POLICY' => policy,
        'SYSTEM' => system,
        _ => null,
      };
}

/// The three thresholds of a rule (the ones of a person's official settings and the ones a colour was counted with): red at or under [red] days left, yellow at or under [yellow], green at or under [green]
/// (null: every larger count is green).
final class PwfThresholds {
  const PwfThresholds({required this.yellow, required this.red, this.green});

  final int? green;
  final int yellow;
  final int red;
}

PwfThresholds? parsePwfThresholds(Object? raw) {
  final Json? record = asRecord(raw);
  final int? yellow = whole(record?['yellow_days']);
  final int? red = whole(record?['red_days']);
  if (record == null || yellow == null || red == null) return null;
  return PwfThresholds(yellow: yellow, red: red, green: whole(record['green_days']));
}

/// The unit of a time limit or of an extension.
enum PwfDurationUnit {
  workingDay,
  calendarDay,
  month;

  static PwfDurationUnit? parse(Object? value) => switch (value) {
        'WORKING_DAY' => workingDay,
        'CALENDAR_DAY' => calendarDay,
        'MONTH' => month,
        _ => null,
      };
}

/// The time limit of a step with its unit ("20 ngày", "1 tháng"), as the frozen template states it.
final class PwfDuration {
  const PwfDuration({required this.value, required this.unit, this.rollToWorkingDay = false});

  final int value;
  final PwfDurationUnit unit;

  /// The end falls on a day off and is moved to the next working day.
  final bool rollToWorkingDay;
}

PwfDuration? parsePwfDuration(Object? raw) {
  final Json? record = asRecord(raw);
  final int? value = whole(record?['value']);
  final PwfDurationUnit? unit = PwfDurationUnit.parse(record?['unit']);
  if (record == null || value == null || unit == null) return null;
  return PwfDuration(value: value, unit: unit, rollToWorkingDay: record['roll_to_working_day'] == true);
}

/// The extension a step may be given (R72): how many times and how much of the limit is used, as the server counts it. A null limit is "no limit".
final class PwfExtension {
  const PwfExtension({required this.allowed, required this.unit, required this.timesUsed, required this.valueUsed, this.maxTimes, this.maxValue});

  final bool allowed;
  final PwfDurationUnit unit;
  final int? maxTimes;
  final int? maxValue;
  final int timesUsed;
  final int valueUsed;

  /// A limit is reached: a request would be refused, so the screen says so instead of offering it.
  bool get capped => (maxTimes != null && timesUsed >= maxTimes!) || (maxValue != null && valueUsed >= maxValue!);

  /// What may still be asked for in the unit of the extension; null when the value has no limit.
  int? get valueLeft => maxValue == null ? null : (maxValue! - valueUsed).clamp(0, maxValue!);
}

PwfExtension? parsePwfExtension(Object? raw) {
  final Json? record = asRecord(raw);
  final PwfDurationUnit? unit = PwfDurationUnit.parse(record?['unit']);
  if (record == null || record['allowed'] is! bool || unit == null) return null;
  return PwfExtension(
    allowed: record['allowed'] == true,
    unit: unit,
    maxTimes: whole(record['max_times']),
    maxValue: whole(record['max_value']),
    timesUsed: count(record['times_used']),
    valueUsed: count(record['value_used']),
  );
}

/// A unit that receives a task: its name, the role it must hold and whether it leads the work or supports it.
final class PwfReceivingUnit {
  const PwfReceivingUnit({required this.name, this.role, this.lead = false});

  final String name;
  final String? role;
  final bool lead;
}

List<PwfReceivingUnit> parsePwfReceivingUnits(Object? raw) => <PwfReceivingUnit>[
      for (final Object? entry in listOf(raw))
        if (asRecord(entry) case final Json item when filled(item['unit_name']) != null) PwfReceivingUnit(name: filled(item['unit_name'])!, role: filled(item['role']), lead: item['part'] != 'SUPPORT'),
    ];

/// The facts of the step table that a task of a list or a detail may carry. All of them are optional; [PwfStepFacts.none] is a task of an older answer.
final class PwfStepFacts {
  const PwfStepFacts({
    this.bandTier,
    this.bandThresholds,
    this.duration,
    this.effectiveWorkingDays,
    this.receivingUnitName,
    this.receivingUnits = const <PwfReceivingUnit>[],
    this.unclaimed = false,
    this.extension,
    this.isOverallDeadline = false,
  });

  static const PwfStepFacts none = PwfStepFacts();

  final PwfBandTier? bandTier;
  final PwfThresholds? bandThresholds;
  final PwfDuration? duration;
  final int? effectiveWorkingDays;

  /// The name of the lead unit that receives the task; null for a task of a template that names no unit.
  final String? receivingUnitName;
  final List<PwfReceivingUnit> receivingUnits;

  /// The task has a receiving unit, is still open and nobody holds it ("Chưa có người nhận"). The server says it; the phone does not work it out.
  final bool unclaimed;
  final PwfExtension? extension;

  /// The task carries the deadline of the whole file (the star).
  final bool isOverallDeadline;

  /// The unit to say on the row: the lead unit, else the first one the answer names.
  String? get unitName => receivingUnitName ?? (receivingUnits.isEmpty ? null : receivingUnits.first.name);
}

/// Reads the members of the step table out of a record of a task (a row of the workflow, a row of my tasks, the detail of a task).
PwfStepFacts parsePwfStepFacts(Json record) => PwfStepFacts(
      bandTier: PwfBandTier.parse(record['band_tier']),
      bandThresholds: parsePwfThresholds(record['band_thresholds']),
      duration: parsePwfDuration(record['duration']),
      effectiveWorkingDays: whole(record['effective_working_days']),
      receivingUnitName: filled(record['receiving_unit_name']),
      receivingUnits: parsePwfReceivingUnits(record['receiving_units']),
      unclaimed: record['unclaimed'] == true,
      extension: parsePwfExtension(record['extension']),
      isOverallDeadline: record['is_overall_deadline'] == true,
    );

/// The deadline of the whole file of a workflow, with the colour of the task that carries it, as the server counted them.
final class PwfOverallDeadline {
  const PwfOverallDeadline({required this.taskId, required this.taskName, required this.dueOn, required this.band, this.taskCode, this.bandTier, this.remainingDays});

  final String taskId;
  final String? taskCode;
  final String taskName;
  final String dueOn;

  /// `NONE`, `GREEN`, `YELLOW`, `RED` or `UNKNOWN`, the same word as the task row says.
  final String band;
  final PwfBandTier? bandTier;
  final int? remainingDays;
}

PwfOverallDeadline? parsePwfOverallDeadline(Object? raw) {
  final Json? record = asRecord(raw);
  final String? id = filled(record?['task_id']);
  final String? name = filled(record?['task_name']);
  final String? due = day(record?['due_on']);
  final String? band = filled(record?['band']);
  if (record == null || id == null || name == null || due == null || band == null) return null;
  return PwfOverallDeadline(taskId: id, taskCode: filled(record['task_code']), taskName: name, dueOn: due, band: band, bandTier: PwfBandTier.parse(record['band_tier']), remainingDays: whole(record['remaining_days']));
}
