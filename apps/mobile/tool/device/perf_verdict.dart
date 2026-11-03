// Turns the measurements of a run on the device matrix into the verdict of AC-ST-MOB-040-2 (UAT-NFR-PERFORMANCE-02).
//
// Input: one CSV file, a line per measurement, `metric,device,run,milliseconds` (a first line `metric,device,run,ms` is skipped):
//
//   cold_start_main_content_ms,pixel-8a-android14,1,1830
//   list_load_ms,pixel-8a-android14,1,640
//   command_round_trip_ms,pixel-8a-android14,1,412
//
// The verdict is given for every (metric, device): the 95th percentile by the nearest-rank method against the budget of the
// requirement. Fewer than [kMinimumRuns] runs cannot show a 95th percentile (it would be the largest value), so the pair is
// INSUFFICIENT and the run does not pass. Exit code 0 only when every pair is PASS; 1 otherwise; 64 for a bad file.
//
//   dart run tool/device/perf_verdict.dart measurements.csv
import 'dart:io';

/// The budgets of the requirement, in milliseconds, by metric: 2.5 s p95 for the main content (cold start and list load) and 1 s
/// p95 for the round trip of a command (NFR-PERFORMANCE-02).
const Map<String, int> kBudgetsMs = <String, int>{
  'cold_start_main_content_ms': 2500,
  'list_load_ms': 2500,
  'command_round_trip_ms': 1000,
};

/// Runs needed before a 95th percentile means anything. A measurement of "launch to the first frame" (`am start -W`) can only
/// disprove the budget, never prove it, so it has no entry in [kBudgetsMs] and is not accepted here.
const int kMinimumRuns = 20;

enum Verdict { pass, fail, insufficient }

final class Measurement {
  const Measurement({required this.metric, required this.device, required this.run, required this.milliseconds});

  final String metric;
  final String device;
  final int run;
  final int milliseconds;
}

final class PairVerdict {
  const PairVerdict({required this.metric, required this.device, required this.runs, required this.p95, required this.budget, required this.verdict});

  final String metric;
  final String device;
  final int runs;
  final int p95;
  final int budget;
  final Verdict verdict;

  @override
  String toString() => '${verdict.name.toUpperCase()} $metric $device runs=$runs p95=${p95}ms budget=${budget}ms';
}

/// The nearest-rank percentile: the value at rank `ceil(p/100 * n)` of the sorted values.
int percentile(List<int> values, int percent) {
  if (values.isEmpty) throw ArgumentError.value(values, 'values', 'is empty');
  if (percent < 1 || percent > 100) throw ArgumentError.value(percent, 'percent', 'must be from 1 to 100');
  final List<int> sorted = List<int>.of(values)..sort();
  final int rank = (percent * sorted.length / 100).ceil();
  return sorted[rank - 1];
}

/// Reads the lines of a measurement file. A line that cannot be read is an error that names it.
List<Measurement> parseMeasurements(String csv) {
  final List<Measurement> measurements = <Measurement>[];
  final List<String> lines = csv.split(RegExp(r'\r?\n'));
  for (int index = 0; index < lines.length; index += 1) {
    final String line = lines[index].trim();
    if (line.isEmpty || line.startsWith('#') || (index == 0 && line.startsWith('metric,'))) continue;
    final List<String> parts = line.split(',');
    final int? run = parts.length == 4 ? int.tryParse(parts[2]) : null;
    final int? milliseconds = parts.length == 4 ? int.tryParse(parts[3]) : null;
    if (parts.length != 4 || run == null || milliseconds == null || milliseconds < 0 || parts[1].isEmpty) {
      throw FormatException('line ${index + 1} is not metric,device,run,milliseconds', line);
    }
    if (!kBudgetsMs.containsKey(parts[0])) throw FormatException('line ${index + 1} names a metric with no budget: ${parts[0]}', line);
    measurements.add(Measurement(metric: parts[0], device: parts[1], run: run, milliseconds: milliseconds));
  }
  if (measurements.isEmpty) throw const FormatException('the file holds no measurement');
  return measurements;
}

/// The verdict for every (metric, device) pair, in the order the pairs first appear.
List<PairVerdict> judge(List<Measurement> measurements) {
  final Map<String, List<Measurement>> groups = <String, List<Measurement>>{};
  for (final Measurement measurement in measurements) {
    groups.putIfAbsent('${measurement.metric}\u0000${measurement.device}', () => <Measurement>[]).add(measurement);
  }
  return <PairVerdict>[
    for (final List<Measurement> group in groups.values)
      () {
        final int budget = kBudgetsMs[group.first.metric]!;
        final int p95 = percentile(group.map((Measurement m) => m.milliseconds).toList(), 95);
        final Verdict verdict = group.length < kMinimumRuns ? Verdict.insufficient : (p95 <= budget ? Verdict.pass : Verdict.fail);
        return PairVerdict(metric: group.first.metric, device: group.first.device, runs: group.length, p95: p95, budget: budget, verdict: verdict);
      }(),
  ];
}

/// Runs the verdict for the command line and returns the exit code.
int run(List<String> arguments) {
  if (arguments.length != 1) {
    stderr.writeln('usage: dart run tool/device/perf_verdict.dart <measurements.csv>');
    return 64;
  }
  final List<PairVerdict> verdicts;
  try {
    verdicts = judge(parseMeasurements(File(arguments.single).readAsStringSync()));
  } on FormatException catch (error) {
    stderr.writeln('${error.message}${error.source == null ? '' : ': ${error.source}'}');
    return 64;
  }
  verdicts.forEach(stdout.writeln);
  final bool passed = verdicts.every((PairVerdict v) => v.verdict == Verdict.pass);
  stdout.writeln(passed ? 'PASS: every pair is within its budget' : 'NOT PASSED: see the lines above');
  return passed ? 0 : 1;
}

void main(List<String> arguments) => exit(run(arguments));
