import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/core_strings.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/registry.generated.dart';

/// The texts of the page of the identity provider, which the application does not own.
const Set<String> _identityProviderTexts = <String>{'Sign in', 'Sign In'};

/// The texts of the system browser (first start of Chrome on the emulator) and the names of the units of the seeded test tenant: neither is a string of the application.
const Set<String> _systemAndFixtureTexts = <String>{'Use without an account', 'No thanks', 'Cao Bằng', '(Đạm Phú Mỹ|Cao Bằng)'};

/// What a Maestro text stands for: a pattern ending in `.*` (a tab name carries "Tab 2 trong tổng số 5") is the text before it.
String _plain(String text) => text.endsWith('.*') ? text.substring(0, text.length - 2) : text;

/// The texts a pattern with one group of alternatives stands for: 'Trang chủ (lãnh đạo|điều hành)' is the home title of the public edition and of the enterprise one.
List<String> _variants(String text) {
  final RegExpMatch? group = RegExp(r'\(([^()|]+(?:\|[^()|]+)+)\)').firstMatch(text);
  if (group == null) return <String>[text];
  return <String>[for (final String option in group.group(1)!.split('|')) text.replaceRange(group.start, group.end, option)];
}

/// The words the phone overlay of the enterprise edition says in place of the base ones: read as text, since only tests named *enterprise_test.dart import the folder.
String _overlayText() => File('lib/editions/enterprise/enterprise_strings.dart').readAsStringSync();

List<File> _files(String directory, String extension) =>
    Directory(directory).listSync().whereType<File>().where((File f) => f.path.endsWith(extension)).toList()..sort((a, b) => a.path.compareTo(b.path));

String _doc(String name) => File('../../docs/$name').readAsStringSync();

StringCatalogue _catalogue() => StringCatalogue(<StringTable>[
      kCoreStrings,
      for (final MobileFeature feature in kAllFeatures)
        if (feature.strings != null) feature.strings!,
    ]);

/// The texts a Maestro flow taps on or waits for (`tapOn: 'x'`, `assertVisible: 'x'`, `visible: 'x'`, `notVisible: 'x'`).
Set<String> _texts(String flow) => <String>{
      for (final RegExpMatch m in RegExp(r"(?:tapOn|assertVisible|visible|notVisible):\s*'([^']+)'").allMatches(flow)) m.group(1)!,
    };

void main() {
  final List<File> flows = _files('qa/device/flows', '.yaml');
  final List<File> scripts = _files('qa/device/scripts', '.sh');

  group('AC-ST-MOB-040-1 AC-ST-MOB-040-2 AC-ST-MOB-040-3 TK-MOB-040-1 the device flows and scripts are marked as not run and stay in step with the application', () {
    test('there are flows for sign-in (against a real provider and against the test provider of the e2e stack), the tabs, the cold start and the flapping case, and scripts for the cold start and the audit', () {
      expect(flows.map((File f) => f.uri.pathSegments.last), <String>[
        '05_sign_in.yaml',
        '06_sign_in_test_idp.yaml',
        '10_core_tabs_traversal.yaml',
        '20_cold_start_main_content.yaml',
        '30_flapping_and_kill_during_submit.yaml',
      ]);
      expect(scripts.map((File f) => f.uri.pathSegments.last), <String>['android_a11y_audit.sh', 'run_cold_start_samples.sh']);
    });

    test('every flow and script says on its first line that it has not been run on a device (a flow that was run on the emulator says so and still says "NOT RUN" for the phones), and names the application', () {
      for (final File file in <File>[...flows, ...scripts]) {
        final List<String> lines = file.readAsLinesSync();
        final String first = file.path.endsWith('.sh') ? lines[1] : lines.first;
        if (!file.path.endsWith('.sh') && (first.startsWith('# STATUS: RUN ON AN EMULATOR ONLY') || first.startsWith('# STATUS: PARTLY RUN on the emulator'))) {
          expect(lines.take(2).join(' '), contains('NOT RUN'), reason: '${file.path}: a run on an emulator proves nothing for the phones of the matrix and must say so');
        } else {
          expect(first, startsWith('# STATUS: NOT RUN'), reason: file.path);
        }
      }
      for (final File flow in flows) {
        expect(flow.readAsStringSync(), contains('appId: vn.machvon.app'), reason: flow.path);
      }
    });

    test('together they name the three UAT ids of the story, and each flow names the criterion it supports', () {
      final String all = <File>[...flows, ...scripts].map((File f) => f.readAsStringSync()).join('\n');
      for (final String id in <String>['UAT-NFR-ACCESSIBILITY-02', 'UAT-NFR-PERFORMANCE-02', 'UAT-AC502', 'AC-ST-MOB-040-1', 'AC-ST-MOB-040-2', 'AC-ST-MOB-040-3']) {
        expect(all, contains(id), reason: id);
      }
      for (final File file in <File>[...flows, ...scripts]) {
        expect(RegExp(r'AC-ST-MOB-04[01]-\d').hasMatch(file.readAsStringSync()), isTrue, reason: file.path);
      }
    });

    test('every text a flow taps on or waits for is a string of the application in Vietnamese (or a text of the identity provider)', () {
      final StringCatalogue catalogue = _catalogue();
      final Set<String> known = <String>{for (final String key in catalogue.viKeys) catalogue.lookup('vi', key)!};
      // A string with a placeholder ('Lũy kế giải ngân {cell}') stands for every text it can take once filled in.
      final List<RegExp> templates = <RegExp>[
        for (final String value in known)
          if (value.contains('{')) RegExp('^${value.split(RegExp(r'\{[a-zA-Z0-9]+\}')).map(RegExp.escape).join('.+')}\$'),
      ];
      bool isKnown(String part) => known.contains(part) || templates.any((RegExp template) => template.hasMatch(part));
      for (final File flow in flows) {
        for (final String text in _texts(flow.readAsStringSync())) {
          if (_identityProviderTexts.contains(text) || _systemAndFixtureTexts.contains(_plain(text)) || text.startsWith(r'${')) continue;
          for (final String variant in _variants(_plain(text))) {
            // A pattern may join several texts of one control with ".*" (the label of a field: 'Dự án.*Chọn dự án'): each text is checked.
            for (final String part in variant.split('.*').where((String piece) => piece.isNotEmpty)) {
              if (_systemAndFixtureTexts.contains(part)) continue;
              expect(isKnown(part) || _overlayText().contains("'$part'"), isTrue, reason: '${flow.path} uses "$text" ("$part"), which no string table of the application declares');
            }
          }
        }
      }
    });

    test('the flows match whole texts: the tab carries a position, the banner carries its body, the unit chooser lists either demo tenant', () {
      final StringCatalogue catalogue = _catalogue();
      final String flapping = File('qa/device/flows/30_flapping_and_kill_during_submit.yaml').readAsStringSync();
      final String projects = catalogue.lookup('vi', 'mob.shell.tab.projects')!;
      expect(flapping, isNot(contains("tapOn: '$projects'")), reason: 'the tab is named "$projects, tab 2 of 5": the pattern ends with .*');
      expect("tapOn: '$projects.*'".allMatches(flapping), isNotEmpty, reason: 'the flow reaches the project tab by the pattern that ends with .*');
      final String banner = catalogue.lookup('vi', 'mob.banner.offline.title')!;
      expect(banner, 'Bạn đang ngoại tuyến');
      expect(flapping, contains("visible: '$banner.*'"), reason: 'the banner reads "$banner. <body>" as one text');
      expect(flapping, isNot(contains("assertVisible: '$banner'")));
      final String signIn = File('qa/device/flows/06_sign_in_test_idp.yaml').readAsStringSync();
      expect(signIn, contains("tapOn: '(Đạm Phú Mỹ|Cao Bằng).*'"));
    });

    test('the traversal reaches the five tabs by their names', () {
      final Set<String> texts = _texts(File('qa/device/flows/10_core_tabs_traversal.yaml').readAsStringSync());
      final StringCatalogue catalogue = _catalogue();
      for (final String tab in <String>['home', 'projects', 'approval', 'inbox', 'account']) {
        expect(texts.map(_plain), contains(catalogue.lookup('vi', 'mob.shell.tab.$tab')), reason: tab);
      }
    });

    test('the cold start flow waits no longer than the budget of 2.5 s', () {
      final String flow = File('qa/device/flows/20_cold_start_main_content.yaml').readAsStringSync();
      expect(RegExp(r'timeout:\s*2500\b').hasMatch(flow), isTrue);
      expect(RegExp(r'timeout:\s*(\d+)').allMatches(flow).map((RegExpMatch m) => int.parse(m.group(1)!)).every((int ms) => ms <= 2500), isTrue);
    });

    test('the cold start is timed to the content of the home screen once loaded, not to the tab label that is there before it', () {
      final StringCatalogue catalogue = _catalogue();
      final Set<String> tabs = <String>{for (final String tab in <String>['home', 'projects', 'approval', 'inbox', 'account']) catalogue.lookup('vi', 'mob.shell.tab.$tab')!};
      final String loaded = catalogue.lookup('vi', 'mob.home.decide.title')!;
      final String script = File('qa/device/scripts/run_cold_start_samples.sh').readAsStringSync();
      final String marker = RegExp(r'^marker="([^"]+)"', multiLine: true).firstMatch(script)!.group(1)!;
      expect(tabs, isNot(contains(marker)), reason: 'the tab bar is drawn before the dashboard has asked the server for anything');
      expect(marker, loaded, reason: 'the heading "Cần bạn quyết định" of the alerts of the loaded home: the body is built only once the dashboard has its answer, so it is on no loading, empty or failed screen');
      final String flow = File('qa/device/flows/20_cold_start_main_content.yaml').readAsStringSync();
      final Set<String> waited = <String>{for (final RegExpMatch m in RegExp(r"visible:\s*'([^']+)'").allMatches(flow)) m.group(1)!};
      expect(waited, <String>{loaded});
    });

    test('the measurement template holds a header and no number: nothing is pre-filled', () {
      expect(File('qa/device/results/measurements.template.csv').readAsStringSync().trim(), 'metric,device,run,ms');
      expect(Directory('qa/device/results').listSync().whereType<File>().map((File f) => f.uri.pathSegments.last), <String>['measurements.template.csv']);
    });

    test('the screens audited are the ten core screens, each with its id', () {
      final List<String> lines = File('qa/device/screens.core.txt').readAsLinesSync().where((String l) => l.isNotEmpty).toList();
      expect(lines, hasLength(10));
      expect(lines.every((String l) => RegExp(r'^MOB-\d\d ').hasMatch(l)), isTrue);
    });
  });

  group('TK-MOB-040-4 the device matrix and the security review say what was not run', () {
    test('the device matrix has the platforms of the acceptance criterion, the budgets, and no measured result', () {
      final String matrix = _doc('mobile-device-matrix.md');
      for (final String needle in <String>['Android 14', 'iOS 18', 'TalkBack', 'VoiceOver', '2.5 s', '1 s', '48 dp', '200 percent', 'UAT-AC502', 'UAT-NFR-ACCESSIBILITY-02', 'UAT-NFR-PERFORMANCE-02', 'Nothing on this page has been run on a device']) {
        expect(matrix, contains(needle), reason: needle);
      }
      final Iterable<String> resultRows = matrix.split('\n').where((String l) => RegExp(r'^\| (A\d|I\d) \|').hasMatch(l) && l.contains('NOT RUN'));
      expect(resultRows, isNotEmpty);
      for (final String row in resultRows) {
        expect(row, isNot(matches(RegExp(r'\|\s*(PASS|FAIL|OK)\s*\|'))), reason: row);
      }
      expect(matrix, isNot(contains('| PASS |')));
    });

    test('every host test the documents name exists', () {
      final String both = _doc('mobile-device-matrix.md') + _doc('mobile-security-review.md');
      final Set<String> named = <String>{for (final RegExpMatch m in RegExp(r'`((?:test/hardening/)?[a-z_]+_test\.dart)`').allMatches(both)) m.group(1)!};
      expect(named, isNotEmpty);
      for (final String name in named) {
        final bool exists = File(name.startsWith('test/') ? name : 'test/hardening/$name').existsSync() ||
            Directory('test').listSync(recursive: true).whereType<File>().any((File f) => f.path.replaceAll(r'\', '/').endsWith('/$name'));
        expect(exists, isTrue, reason: '$name is named in a document and does not exist');
      }
    });

    test('the security review records the decisions, the findings with severity and status, and the acceptance ids', () {
      final String review = _doc('mobile-security-review.md');
      for (final String id in <String>['D-SEC-01', 'D-SEC-02', 'D-SEC-03', 'D-SEC-04', 'D-SEC-05', 'AC-ST-MOB-041-1', 'AC-ST-MOB-041-2', 'AC-ST-MOB-041-3', 'UAT-NFR-TENANCY-07', 'UAT-AC500', 'UAT-AC501']) {
        expect(review, contains(id), reason: id);
      }
      final List<List<String>> findings = <List<String>>[
        for (final String line in review.split('\n'))
          if (RegExp(r'^\| (SEC|SYNC|NAV|PERF|INTEG)-\d\d \| [^`]').hasMatch(line)) line.split('|').map((String c) => c.trim()).toList(),
      ];
      expect(findings.length, greaterThanOrEqualTo(10));
      for (final List<String> cells in findings) {
        expect(<String>{'High', 'Medium', 'Low', 'Info'}, contains(cells[2]), reason: cells[1]);
        expect(RegExp(r'^(Open|Fixed|Accepted|Checked)').hasMatch(cells[3]), isTrue, reason: '${cells[1]}: ${cells[3]}');
      }
      final Set<String> ids = findings.map((List<String> c) => c[1]).toSet();
      expect(ids, hasLength(findings.length), reason: 'a finding id is used once');
    });

    test('every open finding is pinned by an OPEN FINDING test, and every fixed one by a test that says so, so it cannot be undone or forgotten silently', () {
      final String review = _doc('mobile-security-review.md');
      final String pinned = <File>[...Directory('test').listSync(recursive: true).whereType<File>().where((File f) => f.path.endsWith('_test.dart'))].map((File f) => f.readAsStringSync()).join('\n');
      Iterable<String> withStatus(String status) =>
          review.split('\n').where((String l) => RegExp('^\\| (SEC|SYNC|NAV|PERF|INTEG)-\\d\\d \\| [A-Za-z]+ \\| $status').hasMatch(l)).map((String l) => l.split('|')[1].trim());
      final Iterable<String> open = withStatus('Open ');
      for (final String id in open) {
        expect(pinned, contains('OPEN FINDING $id'), reason: id);
      }
      expect(open, isEmpty, reason: 'every finding is fixed, accepted or checked');
      final Iterable<String> fixed = withStatus('Fixed');
      expect(fixed, containsAll(<String>['SEC-01', 'SYNC-01', 'SEC-03', 'SEC-04', 'INTEG-01', 'NAV-01', 'NAV-02', 'PERF-01']));
      for (final String id in fixed) {
        if (id == 'SEC-02') continue; // pinned by the manifest test of platform_config_test.dart
        expect(RegExp('$id (FIXED|fixed)').hasMatch(pinned), isTrue, reason: '$id is Fixed and no test says so');
      }
    });

    test('the signature cells of the risk acceptance record are empty: nobody signed on behalf of the security lead', () {
      final Iterable<String> rows = _doc('mobile-security-review.md').split('\n').where((String l) => RegExp(r'^\| R-0\d \|').hasMatch(l));
      expect(rows, hasLength(5));
      for (final String row in rows) {
        expect(row.split('|')[5].trim(), isEmpty, reason: row);
      }
    });
  });
}
