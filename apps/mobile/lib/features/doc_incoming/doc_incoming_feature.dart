import '../../core/navigation/feature.dart';
import 'incoming_strings.dart';
import 'screens/incoming_screen.dart';

/// DOC-23 (ST-DOC-020, FR-DOC-23): the incoming letters assigned to the person, on the phone, with the deadline, the leader's directive
/// and the days late, and the two commands a handler sends: start handling and resolve. Online only, nothing queued, nothing kept on the
/// device. A letter is opened with `?doc=<id>`; without it the screen is the list.
const MobileFeature feature = MobileFeature(
  id: 'doc_incoming',
  strings: incomingStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'DOC-23', builder: buildIncomingScreen),
  ],
);
