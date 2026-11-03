import '../../core/navigation/feature.dart';
import 'screens/search_screen.dart';
import 'search_strings.dart';

/// ST-MOB-027: search on the phone (MOB-51) across what the reader may see, with the keywords searched for lately. The answer is the
/// server's: the phone filters nothing, adds nothing and shows no total.
const MobileFeature feature = MobileFeature(
  id: 'phone_search',
  strings: searchStrings,
  screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-51', builder: buildSearchScreen)],
);
