import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/navigation/route_table.dart';

const String _licenseExpiredCode = 'LICENSE_EXPIRED';
const String _entitlementDeniedCode = 'ENTITLEMENT_DENIED';
const String _mfaRequiredCode = 'MFA_REQUIRED';

/// The query parameters of MOB-45 and MOB-46: the stable error code and the correlation id, nothing the server wrote.
const String codeParameter = 'code';
const String referenceParameter = 'cid';

/// The action the person tried, one of a closed list (a link cannot put other text on the screen).
const String actionParameter = 'action';
const Set<String> kRefusedActions = <String>{'view', 'edit', 'submit', 'approve'};

final RegExp _codeShape = RegExp(r'^[A-Z][A-Z0-9_]{2,63}$');
final RegExp _referenceShape = RegExp(r'^[A-Za-z0-9-]{8,64}$');

/// Which of the two error screens a refusal of the server leads to.
enum ErrorScreen {
  /// MOB-45: 403 `SCOPE_DENIED` (and every other refusal of permission) or `ENTITLEMENT_DENIED`.
  accessDenied('MOB-45'),

  /// MOB-46: 422 `LICENSE_EXPIRED`.
  licenceExpired('MOB-46');

  const ErrorScreen(this.screenId);

  final String screenId;
}

/// The error screen that an answer of the server leads to, or null when the answer is not about permission or licence (a
/// 401 is the session's, a 403 `MFA_REQUIRED` is the second factor's, everything else is the screen's own error).
///
/// The decision rests on the code and the status the server sent, never on the clock of the phone: the server alone knows
/// that a licence has expired.
ErrorScreen? errorScreenFor(ApiError error) {
  if (error.code == _licenseExpiredCode) return ErrorScreen.licenceExpired;
  if (error.code == _entitlementDeniedCode) return ErrorScreen.accessDenied;
  if (error.status == 403 && error.code != _mfaRequiredCode) return ErrorScreen.accessDenied;
  return null;
}

/// The location of the error screen for [error], carrying the code and the correlation id and nothing of the body: the
/// detail of a refusal can name the record that was protected.
String? errorScreenLocation(RouteTable table, ApiError error, {String? action}) {
  final ErrorScreen? screen = errorScreenFor(error);
  if (screen == null) return null;
  return Uri(
    path: table.locationOf(screen.screenId),
    queryParameters: <String, String>{
      codeParameter: error.code,
      if (_referenceShape.hasMatch(error.correlationId)) referenceParameter: error.correlationId,
      if (action != null && kRefusedActions.contains(action)) actionParameter: action,
    },
  ).toString();
}

/// The code a link may carry to an error screen: a stable code in capitals, or null.
String? safeCode(String? raw) => raw != null && _codeShape.hasMatch(raw) ? raw : null;

/// The correlation id a link may carry to an error screen, or null.
String? safeReference(String? raw) => raw != null && _referenceShape.hasMatch(raw) ? raw : null;
