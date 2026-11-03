import '../../core/navigation/feature.dart';
import 'project_views_strings.dart';
import 'screens/capital_plan_screen.dart';
import 'screens/field_map_screen.dart';
import 'screens/project_detail_screen.dart';
import 'screens/project_list_screen.dart';
import 'screens/unreported_projects_screen.dart';
import 'screens/weekly_issues_screen.dart';

/// ST-MOB-010: the project screens. MOB-09 the list, MOB-10 the detail, MOB-11 the field map, MOB-12 the lines of a capital
/// plan, MOB-57 the projects that have not reported and MOB-59 the weekly issues. They only read; they use the cache rules
/// of `read_support` (BR-MOB-01).
const MobileFeature feature = MobileFeature(
  id: 'project_views',
  strings: projectViewsStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-09', builder: buildProjectListScreen),
    ScreenSpec(screenId: 'MOB-10', pathSuffix: '/:projectId', builder: buildProjectDetailScreen),
    ScreenSpec(screenId: 'MOB-11', builder: buildFieldMapScreen),
    ScreenSpec(screenId: 'MOB-12', builder: buildCapitalPlanScreen),
    ScreenSpec(screenId: 'MOB-57', builder: buildUnreportedProjectsScreen),
    ScreenSpec(screenId: 'MOB-59', builder: buildWeeklyIssuesScreen),
  ],
);
