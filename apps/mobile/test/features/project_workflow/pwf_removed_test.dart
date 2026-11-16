import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The old design of the workflow screens was REPLACED, not kept beside the new one (principle 0 of the redesign): no switch, no second layout. This test lists what was
/// removed so that it cannot come back by a merge or a copy: the three tabs of MOB-78 (overview, work, milestones), the tabs of MOB-79 (to do, facts, grounds, log), the
/// row builder of the old list, the "late first" ranking of its tasks, and the words that belonged only to them.
const String _dir = 'lib/features/project_workflow';

String _read(String file) => File('$_dir/$file').readAsStringSync();

void main() {
  group('the old workflow layouts are gone', () {
    test('MOB-78 has no tabs and no second list builder', () {
      final String panel = _read('pwf_workflow_panel.dart');
      expect(panel, isNot(contains('PwfTabs')), reason: 'the three tabs of MOB-78 are replaced by one page');
      expect(panel, isNot(contains('tabbed')), reason: 'there is no tabbed and no un-tabbed form of the panel');
      expect(panel, isNot(contains('_byUrgency')), reason: 'the steps are in the order of the process, not ranked by colour');
      expect(_read('pwf_widgets.dart'), isNot(contains('pwfTaskRow(')), reason: 'the row of the old list');
      expect(_read('pwf_models.dart'), isNot(contains('upcomingMilestones')), reason: 'the milestones tab and its list');
      expect(_read('screens/workflow_screen.dart'), isNot(contains('PwfTabs')));
      expect(_read('pwf_progress_section.dart'), isNot(contains('tabbed')));
    });

    test('MOB-79 has one main section and folds, no tabs', () {
      final String task = _read('screens/task_detail_screen.dart');
      expect(task, isNot(contains('PwfTabs')));
      expect(task, isNot(contains('PwfTab(')));
      expect(task, contains("context.t('mob.pwfs.task.todo')"), reason: 'the one main section "Cần làm gì để xong"');
      expect(task, contains('PwfFold('), reason: 'the rest is in folds');
    });

    test('the words that belonged only to the old layouts are not declared any more', () {
      final String strings = _read('pwf_strings.dart');
      for (final String key in <String>[
        'mob.pwf7.tab.overview',
        'mob.pwf7.tab.work',
        'mob.pwf7.tab.milestones',
        'mob.pwf7.work.title',
        'mob.pwf7.overview.urgent',
        'mob.pwf7.overview.phases',
        'mob.pwf7.milestones.ahead',
        'mob.pwf7.milestones.over',
        'mob.pwf7.milestones.none',
        'mob.pwf6.tab.todo',
        'mob.pwf6.tab.facts',
        'mob.pwf6.tab.legal',
        'mob.pwf6.tab.log',
        'mob.pwf7.group.people',
        'mob.pwf7.group.schedule',
        'mob.pwf7.group.place',
      ]) {
        expect(strings, isNot(contains("'$key'")), reason: key);
      }
    });

    test('the old files are not back', () {
      for (final String file in <String>['pwf_overview.dart', 'pwf_milestones_tab.dart', 'pwf_facts_tab.dart', 'pwf_task_tabs.dart']) {
        expect(File('$_dir/$file').existsSync(), isFalse, reason: file);
      }
    });
  });
}
