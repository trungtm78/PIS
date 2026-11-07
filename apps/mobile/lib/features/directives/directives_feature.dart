import '../../core/navigation/feature.dart';
import 'directives_strings.dart';
import 'screens/directive_list_screen.dart';

/// DIR-1 on the phone: DIR-06 the directives of the steering meetings, read only (the list with its counts, and the timeline of one directive).
/// It reads with the cache rules of `read_support` (BR-MOB-01). Commands (progress, extension, close) are the web's in this round.
const MobileFeature feature = MobileFeature(
  id: 'directives',
  strings: directivesStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'DIR-06', builder: buildDirectiveListScreen),
  ],
);
