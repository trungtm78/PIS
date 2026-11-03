import '../../core/navigation/feature.dart';
import 'screens/signing_screen.dart';
import 'signing_strings.dart';

/// ST-MOB-023: MOB-67, the documents that wait for the leader's signature: read the final PDF, compare it with the version before it
/// and sign (a session on the server, completed with the proof of the signer). Online only: no signing command is queued, sent from a
/// copy or kept for later. A document is opened with `?doc=<id>`; without it the screen is the list.
const MobileFeature feature = MobileFeature(
  id: 'document_signing',
  strings: signingStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-67', builder: buildSigningScreen),
  ],
);
