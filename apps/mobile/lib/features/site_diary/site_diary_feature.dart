import '../../core/navigation/feature.dart';
import '../../core/offline/drafts/conflict_adapter.dart' show ConflictAdapter;
import 'diary_conflict.dart';
import 'diary_models.dart';
import 'diary_strings.dart';
import 'screens/contracts_screen.dart';
import 'screens/diary_screen.dart';

/// ST-MOB-020: the contracts and their milestones for a contractor or a supervisor (MOB-61), and the daily site diary written on the
/// phone, offline, for signing (MOB-62). The diary is queued as `site_diary.append` with a key the phone made; the signature, the
/// correction of a signed diary and the choice between two versions are made online. A diary that came back in conflict is settled in
/// MOB-42 through the adapter declared here.
const MobileFeature feature = MobileFeature(
  id: 'site_diary',
  strings: diaryStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-61', builder: buildContractsScreen),
    ScreenSpec(
      screenId: 'MOB-62',
      pathSuffix: '/:contractId',
      builder: buildDiaryScreen,
    ),
  ],
  conflictAdapters: <String, ConflictAdapter>{
    kDiaryAppendCommand: siteDiaryConflictAdapter,
  },
);
