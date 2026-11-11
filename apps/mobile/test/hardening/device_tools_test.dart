import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../../tool/device/perf_verdict.dart' as perf;
import '../../tool/device/touch_target_audit.dart' as touch;

String _node({String cls = 'android.view.View', String text = '', String desc = '', required String bounds, bool clickable = true, String extra = ''}) =>
    '<node index="0" text="$text" resource-id="" class="$cls" package="vn.machvon.app" content-desc="$desc" checkable="false" checked="false" '
    'clickable="$clickable" enabled="true" focusable="true" long-clickable="false" $extra bounds="$bounds" />';

String _dump(List<String> nodes) => '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${nodes.join()}</hierarchy>';

String _csv(String metric, String device, Iterable<int> values) {
  int run = 0;
  return values.map((int v) => '$metric,$device,${run += 1},$v').join('\n');
}

void main() {
  group('AC-ST-MOB-040-1 UAT-NFR-ACCESSIBILITY-02 the touch area audit of a hierarchy dump taken on a device', () {
    // 420 dpi is 2.625 pixels per dp: 48 dp is 126 px.
    test('a control of 48 dp by 48 dp with a name passes', () {
      final String xml = _dump(<String>[_node(desc: 'Trang chủ', bounds: '[0,0][126,126]')]);
      expect(touch.auditDump(xml, densityDpi: 420), isEmpty);
    });

    test('a control one pixel short in either direction is reported with its size in dp', () {
      final List<touch.TouchFinding> narrow = touch.auditDump(_dump(<String>[_node(desc: 'Đóng', bounds: '[0,0][125,126]')]), densityDpi: 420);
      expect(narrow.map((touch.TouchFinding f) => f.rule), <String>['TOUCH_TARGET_TOO_SMALL']);
      expect(narrow.single.widthDp, closeTo(47.6, 0.1));
      final List<touch.TouchFinding> low = touch.auditDump(_dump(<String>[_node(desc: 'Đóng', bounds: '[0,0][126,125]')]), densityDpi: 420);
      expect(low.map((touch.TouchFinding f) => f.rule), <String>['TOUCH_TARGET_TOO_SMALL']);
    });

    test('the density decides: the same pixels are large enough on a 160 dpi screen and too small on a 420 dpi one', () {
      final String xml = _dump(<String>[_node(desc: 'Gửi', bounds: '[0,0][60,60]')]);
      expect(touch.auditDump(xml, densityDpi: 160), isEmpty);
      expect(touch.auditDump(xml, densityDpi: 420), isNotEmpty);
    });

    test('a control with neither a text nor a description has no name for the screen reader', () {
      final List<touch.TouchFinding> findings = touch.auditDump(_dump(<String>[_node(bounds: '[0,0][200,200]')]), densityDpi: 420);
      expect(findings.map((touch.TouchFinding f) => f.rule), <String>['NO_ACCESSIBLE_NAME']);
      expect(touch.auditDump(_dump(<String>[_node(text: 'Gửi', bounds: '[0,0][200,200]')]), densityDpi: 420), isEmpty);
      expect(touch.auditDump(_dump(<String>[_node(desc: '   ', bounds: '[0,0][200,200]')]), densityDpi: 420), hasLength(1));
    });

    test('a node that is not a control is not audited, a long-clickable or checkable one is', () {
      expect(touch.auditDump(_dump(<String>[_node(clickable: false, bounds: '[0,0][10,10]')]), densityDpi: 420), isEmpty);
      final String longClick = _dump(<String>[
        '<node text="x" class="android.view.View" clickable="false" long-clickable="true" bounds="[0,0][10,10]" />',
        '<node text="y" class="android.widget.Switch" clickable="false" checkable="true" bounds="[0,0][10,10]" />',
      ]);
      expect(touch.auditDump(longClick, densityDpi: 420), hasLength(2));
    });

    test('a node without area is not on screen and is skipped', () {
      expect(touch.auditDump(_dump(<String>[_node(bounds: '[0,0][0,0]')]), densityDpi: 420), isEmpty);
    });

    test('the text of a name is read with its XML escapes, and a finding prints where it is', () {
      final List<touch.UiNode> nodes = touch.parseControls(_dump(<String>[_node(desc: 'Tom &amp; Jerry &quot;x&quot;', bounds: '[1,2][3,4]')]));
      expect(nodes.single.name, 'Tom & Jerry "x"');
      final touch.TouchFinding finding = touch.auditDump(_dump(<String>[_node(desc: 'a', bounds: '[1,2][3,4]')]), densityDpi: 320).first;
      expect(finding.toString(), contains('TOUCH_TARGET_TOO_SMALL'));
      expect(finding.toString(), contains('[1,2][3,4]'));
    });

    test('a dump that is half understood does not pass: unreadable bounds are an error, so is an implausible density', () {
      expect(() => touch.auditDump(_dump(<String>[_node(bounds: 'nowhere')]), densityDpi: 420), throwsFormatException);
      expect(() => touch.auditDump(_dump(<String>[]), densityDpi: 3), throwsArgumentError);
      expect(() => touch.auditDump(_dump(<String>[]), densityDpi: 9000), throwsArgumentError);
    });

    test('input that is not a whole hierarchy dump audits nothing and is refused, never a PASS: empty, not XML, cut short, or with no node', () {
      final String whole = _dump(<String>[_node(desc: 'Gửi', bounds: '[0,0][200,200]')]);
      final Map<String, String> unusable = <String, String>{
        'empty': '',
        'blank': '  \n ',
        'not XML': 'adb: error: device offline',
        'the error text of a failed dump': 'ERROR: null root node returned by UiTestAutomationBridge.',
        'cut before the end of the hierarchy': whole.substring(0, whole.length - '</hierarchy>'.length),
        'cut inside a node': whole.substring(0, whole.length - 40),
        'a hierarchy with no node': '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"></hierarchy>',
      };
      for (final MapEntry<String, String> entry in unusable.entries) {
        expect(() => touch.auditDump(entry.value, densityDpi: 420), throwsFormatException, reason: entry.key);
      }
      expect(touch.auditDump(whole, densityDpi: 420), isEmpty, reason: 'a whole dump with nothing wrong is still a clean audit');
    });

    test('the command line: a dump that is unusable, or a file that cannot be read, is 65 (not 0 and not the 1 of a finding), also when other dumps are clean', () {
      final Directory directory = Directory.systemTemp.createTempSync('machvon-touch-');
      addTearDown(() => directory.deleteSync(recursive: true));
      final File clean = File('${directory.path}/clean.xml')..writeAsStringSync(_dump(<String>[_node(desc: 'Gửi', bounds: '[0,0][200,200]')]));
      final File small = File('${directory.path}/small.xml')..writeAsStringSync(_dump(<String>[_node(desc: 'Gửi', bounds: '[0,0][20,20]')]));
      final File empty = File('${directory.path}/empty.xml')..writeAsStringSync('');
      final File cut = File('${directory.path}/cut.xml')..writeAsStringSync('<hierarchy rotation="0"><node text="" clickable="true" bounds="[0,0][3');
      expect(touch.run(<String>[empty.path, '420']), 65);
      expect(touch.run(<String>[cut.path, '420']), 65);
      expect(touch.run(<String>['${directory.path}/missing.xml', '420']), 65);
      expect(touch.run(<String>[clean.path, '420', empty.path]), 65, reason: 'one capture that failed makes the run unusable');
      expect(touch.run(<String>[small.path, '420', empty.path]), 65, reason: 'a finding does not hide a capture that audited nothing');
    });

    test('the command line: a bad call is 64', () {
      expect(touch.run(<String>[]), 64);
      expect(touch.run(<String>['dump.xml', 'abc']), 64);
    });

    test('the command line: 0 when every dump is clean, 1 when one control is not', () {
      final Directory directory = Directory.systemTemp.createTempSync('machvon-touch-');
      addTearDown(() => directory.deleteSync(recursive: true));
      final File clean = File('${directory.path}/clean.xml')..writeAsStringSync(_dump(<String>[_node(desc: 'Gửi', bounds: '[0,0][200,200]')]));
      final File small = File('${directory.path}/small.xml')..writeAsStringSync(_dump(<String>[_node(desc: 'Gửi', bounds: '[0,0][20,20]')]));
      expect(touch.run(<String>[clean.path, '420']), 0);
      expect(touch.run(<String>[small.path, '420']), 1);
      expect(touch.run(<String>[clean.path, '420', small.path]), 1, reason: 'every dump of the run is audited');
    });
  });

  group('AC-ST-MOB-040-2 UAT-NFR-PERFORMANCE-02 the cold start script only reads a hierarchy dump that its own attempt has just taken', () {
    // The script is run for real, with an `adb` that behaves like a phone whose `uiautomator dump` can fail (the file of an earlier
    // dump then stays on the sdcard, as it does on a device).
    const String fakeAdb = r'''#!/usr/bin/env bash
[ "$1" = "-s" ] && shift 2
[ "$1" = shell ] || exit 2
shift
root="$FAKE_SDCARD"
am() { :; }
uiautomator() {
  local calls=0
  [ -f "$root/dump_calls" ] && calls=$(cat "$root/dump_calls")
  calls=$((calls + 1))
  echo "$calls" >"$root/dump_calls"
  if [ "$calls" -le "$FAKE_DUMP_FAILS" ]; then echo "ERROR: could not get idle state." >&2; return 1; fi
  printf '<hierarchy rotation="0"><node text="%s" /></hierarchy>' "$FAKE_MARKER" >"$2"
}
cmd="$*"
eval "${cmd//\/sdcard/$root}"
''';

    Future<({List<String> lines, int dumps})> sample({required int failures, required bool staleDump}) async {
      final Directory phone = Directory.systemTemp.createTempSync('machvon-cold-');
      addTearDown(() => phone.deleteSync(recursive: true));
      final String marker = RegExp(r'^marker="([^"]+)"', multiLine: true).firstMatch(File('qa/device/scripts/run_cold_start_samples.sh').readAsStringSync())!.group(1)!;
      final Directory bin = Directory('${phone.path}/bin')..createSync();
      final Directory sdcard = Directory('${phone.path}/sdcard')..createSync();
      File('${bin.path}/adb').writeAsStringSync(fakeAdb);
      // A shell finds `adb` on the PATH only when the file is executable: Windows has no such bit, Linux and macOS do.
      if (!Platform.isWindows) Process.runSync('chmod', <String>['755', '${bin.path}/adb']);
      if (staleDump) File('${sdcard.path}/machvon_cold.xml').writeAsStringSync('<hierarchy rotation="0"><node text="$marker" /></hierarchy>');
      final ProcessResult result = await Process.run(
        'bash',
        <String>['qa/device/scripts/run_cold_start_samples.sh', 'fake-phone', '1'],
        environment: <String, String>{
          'PATH': '${bin.path.replaceAll(r'\', '/')}${Platform.isWindows ? ';' : ':'}${Platform.environment['PATH']}',
          'FAKE_SDCARD': sdcard.path.replaceAll(r'\', '/'),
          'FAKE_DUMP_FAILS': '$failures',
          'FAKE_MARKER': marker,
          'COLD_START_SETTLE_SECONDS': '0',
        },
      );
      expect(result.exitCode, 0, reason: '${result.stderr}');
      final File calls = File('${sdcard.path}/dump_calls');
      return (
        lines: (result.stdout as String).trim().split(RegExp(r'\r?\n')),
        dumps: calls.existsSync() ? int.parse(calls.readAsStringSync().trim()) : 0,
      );
    }

    test('a dump that is taken on the first attempt is the sample', () async {
      final ({List<String> lines, int dumps}) run = await sample(failures: 0, staleDump: true);
      expect(run.dumps, 1);
      expect(run.lines.last, matches(RegExp(r'^cold_start_main_content_ms,fake-phone,1,\d+$')));
      expect(int.parse(run.lines.last.split(',').last), lessThan(15000));
    });

    test('an attempt whose dump fails is not read from the file of an earlier dump: the next attempt, with a fresh dump, is the sample', () async {
      final ({List<String> lines, int dumps}) run = await sample(failures: 1, staleDump: true);
      expect(run.dumps, 2, reason: 'the stale dump that holds the card must not be taken for the screen of the first attempt');
      expect(run.lines.last, matches(RegExp(r'^cold_start_main_content_ms,fake-phone,1,\d+$')));
    });

    test('a start whose dump never succeeds is a failed sample (15000 ms) even though an earlier dump on the phone holds the card', () async {
      final ({List<String> lines, int dumps}) run = await sample(failures: 1000000, staleDump: true);
      expect(run.lines.last, 'cold_start_main_content_ms,fake-phone,1,15000');
      expect(run.dumps, greaterThan(1));
    }, timeout: const Timeout(Duration(seconds: 90)));
  });

  group('AC-ST-MOB-040-2 UAT-NFR-PERFORMANCE-02 the verdict of the measurements of the device matrix', () {
    test('the budgets are 2.5 s for the main content and 1 s for a command round trip', () {
      expect(perf.kBudgetsMs, <String, int>{'cold_start_main_content_ms': 2500, 'list_load_ms': 2500, 'command_round_trip_ms': 1000});
    });

    test('the percentile is the nearest rank', () {
      final List<int> hundred = List<int>.generate(100, (int i) => i + 1);
      expect(perf.percentile(hundred, 95), 95);
      expect(perf.percentile(hundred, 100), 100);
      expect(perf.percentile(hundred, 1), 1);
      expect(perf.percentile(<int>[5, 1, 3], 95), 5, reason: 'with few values the 95th percentile is the largest');
      expect(perf.percentile(List<int>.generate(20, (int i) => i + 1), 95), 19);
      expect(() => perf.percentile(<int>[], 95), throwsArgumentError);
      expect(() => perf.percentile(<int>[1], 0), throwsArgumentError);
      expect(() => perf.percentile(<int>[1], 101), throwsArgumentError);
    });

    test('20 runs whose 95th percentile is on the budget pass, one millisecond over fails', () {
      // 19 runs at 100 ms and one at 9000 ms: the 95th percentile of 20 runs is the 19th value, so the single slow run does not count.
      final List<int> onBudget = <int>[...List<int>.filled(19, 100), 9000];
      expect(perf.judge(perf.parseMeasurements(_csv('list_load_ms', 'pixel', onBudget))).single.verdict, perf.Verdict.pass);
      final List<int> exactly = <int>[...List<int>.filled(19, 2500), 9000];
      expect(perf.judge(perf.parseMeasurements(_csv('list_load_ms', 'pixel', exactly))).single.verdict, perf.Verdict.pass);
      final List<int> over = <int>[...List<int>.filled(18, 100), 2501, 2501];
      final perf.PairVerdict verdict = perf.judge(perf.parseMeasurements(_csv('list_load_ms', 'pixel', over))).single;
      expect(verdict.verdict, perf.Verdict.fail);
      expect(verdict.p95, 2501);
    });

    test('the command round trip has its own, tighter budget', () {
      final List<int> values = List<int>.filled(20, 1001);
      expect(perf.judge(perf.parseMeasurements(_csv('command_round_trip_ms', 'iphone', values))).single.verdict, perf.Verdict.fail);
      expect(perf.judge(perf.parseMeasurements(_csv('command_round_trip_ms', 'iphone', List<int>.filled(20, 1000)))).single.verdict, perf.Verdict.pass);
      expect(perf.judge(perf.parseMeasurements(_csv('cold_start_main_content_ms', 'iphone', List<int>.filled(20, 1001)))).single.verdict, perf.Verdict.pass);
    });

    test('fewer than 20 runs prove nothing: INSUFFICIENT, never PASS', () {
      final perf.PairVerdict verdict = perf.judge(perf.parseMeasurements(_csv('cold_start_main_content_ms', 'pixel', List<int>.filled(19, 10)))).single;
      expect(verdict.verdict, perf.Verdict.insufficient);
      expect(verdict.runs, 19);
    });

    test('every device and every metric is judged on its own', () {
      final String csv = <String>[
        'metric,device,run,ms',
        _csv('list_load_ms', 'pixel', List<int>.filled(20, 500)),
        _csv('list_load_ms', 'galaxy-a14', List<int>.filled(20, 3000)),
        _csv('command_round_trip_ms', 'pixel', List<int>.filled(20, 400)),
        '# a comment',
        '',
      ].join('\n');
      final List<perf.PairVerdict> verdicts = perf.judge(perf.parseMeasurements(csv));
      expect(verdicts.map((perf.PairVerdict v) => '${v.metric}/${v.device}/${v.verdict.name}'), <String>[
        'list_load_ms/pixel/pass',
        'list_load_ms/galaxy-a14/fail',
        'command_round_trip_ms/pixel/pass',
      ]);
      expect(verdicts[1].toString(), 'FAIL list_load_ms galaxy-a14 runs=20 p95=3000ms budget=2500ms');
    });

    test('a file that cannot be read is refused with the line, and so is a metric with no budget', () {
      expect(() => perf.parseMeasurements('list_load_ms,pixel,1'), throwsFormatException);
      expect(() => perf.parseMeasurements('list_load_ms,pixel,one,10'), throwsFormatException);
      expect(() => perf.parseMeasurements('list_load_ms,pixel,1,-5'), throwsFormatException);
      expect(() => perf.parseMeasurements('list_load_ms,,1,5'), throwsFormatException);
      expect(() => perf.parseMeasurements('cold_start_first_frame_ms,pixel,1,5'), throwsFormatException);
      expect(() => perf.parseMeasurements('metric,device,run,ms\n'), throwsFormatException);
    });

    test('the command line: a bad call is 64', () {
      expect(perf.run(<String>[]), 64);
      expect(perf.run(<String>['a', 'b']), 64);
    });

    test('the command line: 0 when every pair passes, 1 when one does not, 64 for a file that cannot be read', () {
      final Directory directory = Directory.systemTemp.createTempSync('machvon-perf-');
      addTearDown(() => directory.deleteSync(recursive: true));
      final File good = File('${directory.path}/good.csv')..writeAsStringSync(_csv('list_load_ms', 'pixel', List<int>.filled(20, 500)));
      final File slow = File('${directory.path}/slow.csv')..writeAsStringSync(_csv('list_load_ms', 'pixel', List<int>.filled(20, 5000)));
      final File few = File('${directory.path}/few.csv')..writeAsStringSync(_csv('list_load_ms', 'pixel', List<int>.filled(3, 5)));
      final File broken = File('${directory.path}/broken.csv')..writeAsStringSync('nonsense');
      expect(perf.run(<String>[good.path]), 0);
      expect(perf.run(<String>[slow.path]), 1);
      expect(perf.run(<String>[few.path]), 1);
      expect(perf.run(<String>[broken.path]), 64);
    });
  });
}
