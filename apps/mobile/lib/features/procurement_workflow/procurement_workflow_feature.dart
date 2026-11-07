import '../../core/navigation/feature.dart';
import 'navigation.dart';
import 'procurement_workflow_strings.dart';
import 'screens/package_detail_screen.dart';
import 'screens/package_list_screen.dart';
import 'screens/process_tree_screen.dart';

/// PRC-1 on the phone: MOB-69 the packages by step, MOB-70 one package with its stepper and day-by-day timeline, MOB-71 the process tree as an
/// outline. They only read (the workflow is run on the desktop); every number and every day comes from the server.
///
/// The three screens are in [kProcurementWorkflowScreens]; their ids are in `screen_catalog.json` and `navigation_architecture.json` (Projects tab, root MOB-09)
/// and the route table was generated from them (`dart run tool/generate_routes.dart`).
const List<ScreenSpec> kProcurementWorkflowScreens = <ScreenSpec>[
  ScreenSpec(screenId: kPrcListScreenId, builder: buildPackageListScreen),
  ScreenSpec(screenId: kPrcDetailScreenId, pathSuffix: '/:packageId', builder: buildPackageDetailScreen),
  ScreenSpec(screenId: kPrcTreeScreenId, builder: buildProcessTreeScreen),
];

const MobileFeature feature = MobileFeature(
  id: 'procurement_workflow',
  strings: procurementWorkflowStrings,
  screens: kProcurementWorkflowScreens,
);
