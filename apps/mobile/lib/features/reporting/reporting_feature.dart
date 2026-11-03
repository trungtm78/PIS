import '../../core/navigation/feature.dart';
import 'reporting_strings.dart';
import 'screens/drafts_screen.dart';
import 'screens/estimate_screen.dart';
import 'screens/funding_screen.dart';
import 'screens/narrative_screen.dart';
import 'screens/period_screen.dart';
import 'screens/registration_screen.dart';
import 'screens/result_screen.dart';
import 'screens/review_screen.dart';
import 'screens/volumes_screen.dart';

/// ST-MOB-011 and ST-MOB-012: the weekly report on the phone. The steps of a draft (MOB-13 to MOB-18, MOB-55), the estimate of the
/// disbursement (MOB-56), the list of drafts (MOB-22), the review and the one command that sends the report (MOB-20) and what the
/// server answered (MOB-21). The files of a report are MOB-19 (`attachments`); the offline machinery is `lib/core/offline`.
/// `docs/mob-weekly-report.md` describes the flow.
const MobileFeature feature = MobileFeature(
  id: 'reporting',
  strings: reportingStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-13', builder: buildPeriodScreen),
    ScreenSpec(screenId: 'MOB-14', pathSuffix: '/:draftId', builder: buildVolumesScreen),
    ScreenSpec(screenId: 'MOB-15', pathSuffix: '/:draftId', builder: buildYearFundingScreen),
    ScreenSpec(screenId: 'MOB-16', pathSuffix: '/:draftId', builder: buildCarryoverFundingScreen),
    ScreenSpec(screenId: 'MOB-17', pathSuffix: '/:draftId', builder: buildOtherFundingScreen),
    ScreenSpec(screenId: 'MOB-18', pathSuffix: '/:draftId', builder: buildRegistrationScreen),
    ScreenSpec(screenId: 'MOB-20', pathSuffix: '/:draftId', builder: buildReviewScreen),
    ScreenSpec(screenId: 'MOB-21', pathSuffix: '/:reportId', builder: buildResultScreen),
    ScreenSpec(screenId: 'MOB-22', builder: buildDraftsScreen),
    ScreenSpec(screenId: 'MOB-55', pathSuffix: '/:draftId', builder: buildNarrativeScreen),
    ScreenSpec(screenId: 'MOB-56', pathSuffix: '/:draftId', builder: buildEstimateScreen),
  ],
);
