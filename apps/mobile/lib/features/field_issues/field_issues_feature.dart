import '../../core/navigation/feature.dart';
import 'issue_strings.dart';
import 'screens/capture_screen.dart';
import 'screens/follow_up_screen.dart';
import 'screens/photo_screen.dart';
import 'screens/place_screen.dart';

/// ST-MOB-014: the capture of an obstacle in the field. MOB-28 the form, MOB-29 the photographs with their marks, MOB-30 the
/// place (with its consent) and the check before sending, MOB-31 the follow-up with the comments. A report is written offline as
/// a draft and sent as one `issue.create` command with a key the phone made, so a send repeated after a lost answer is one issue.
const MobileFeature feature = MobileFeature(
  id: 'field_issues',
  strings: issueStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-28', builder: buildCaptureScreen),
    ScreenSpec(
      screenId: 'MOB-29',
      pathSuffix: '/:draftId',
      builder: buildPhotoScreen,
    ),
    ScreenSpec(
      screenId: 'MOB-30',
      pathSuffix: '/:draftId',
      builder: buildPlaceScreen,
    ),
    ScreenSpec(
      screenId: 'MOB-31',
      pathSuffix: '/:ref',
      builder: buildFollowUpScreen,
    ),
  ],
);
