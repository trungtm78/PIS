import '../../core/navigation/feature.dart';
import 'ai_strings.dart';
import 'screens/findings_screen.dart';
import 'screens/qa_screen.dart';
import 'screens/source_screen.dart';

/// ST-MOB-030: AI on the phone. MOB-37 asks about the proposals of a package and answers only with citations in the person's scope,
/// MOB-38 shows what the model proposed for each criterion, one finding to a card, and MOB-39 opens the cited page after the server has
/// judged the access again. Everything the model says is a proposal for an expert to verify and every citation shows the server's
/// verdict; there is no swipe, push or one-tap action that approves, rejects or applies anything. Nothing is kept on the device.
const MobileFeature feature = MobileFeature(
  id: 'ai_review',
  strings: aiStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-37', builder: buildQaScreen),
    ScreenSpec(screenId: 'MOB-38', builder: buildFindingsScreen),
    ScreenSpec(screenId: 'MOB-39', builder: buildSourceScreen),
  ],
);
