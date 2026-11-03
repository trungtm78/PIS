import '../../core/navigation/feature.dart';
import 'hub_strings.dart';
import 'screens/hub_screen.dart';

/// QMS-09 (ST-QMS-002, FR-QMS-09): the site diary on the phone, offline, as a whole: what is written on the phone and not yet sent, the
/// copies that came back in conflict, and the diaries on the server that wait for a settling or for the contractor's signature. The
/// diary is written, queued and signed in `site_diary` (MOB-62) and a queued diary in conflict is settled in MOB-42; this screen shows
/// them together and settles the copies that devices left on the server (online only, never queued). A diary with copies is opened with
/// `?diary=<id>`; without it the screen shows the two lists.
const MobileFeature feature = MobileFeature(
  id: 'diary_hub',
  strings: diaryHubStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'QMS-09', builder: buildHubScreen),
  ],
);
