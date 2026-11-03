import '../../core/navigation/feature.dart';
import 'screens/context_screen.dart';
import 'screens/second_factor_screen.dart';
import 'screens/session_expired_screen.dart';
import 'screens/sign_in_screen.dart';
import 'session_strings.dart';

/// ST-MOB-002: sign-in with OpenID Connect (Authorization Code + PKCE through the system browser), the second factor, the
/// choice of unit and role, and the session-expired screen. The session itself (`OidcSession`, `AuthService`) is in
/// `session_providers.dart`; the application root installs it with `sessionOverrides()`.
const MobileFeature feature = MobileFeature(
  id: 'session',
  strings: sessionStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-02', builder: buildSignInScreen),
    ScreenSpec(screenId: 'MOB-03', builder: buildSecondFactorScreen),
    ScreenSpec(screenId: 'MOB-04', builder: buildContextScreen),
    ScreenSpec(screenId: 'MOB-44', builder: buildSessionExpiredScreen),
  ],
);
