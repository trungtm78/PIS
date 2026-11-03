import '../../core/navigation/route_policy.dart' show kAccessDeniedScreenId;
import 'notification_models.dart';
import 'screens/notification_detail_screen.dart' show openedViaParameter, openedViaPush;

/// The rule of the deep-link guard for the opaque link of a push (`/r/<notification id>`, BR-MOB-04, BR-MOB-05).
///
/// It runs after the session guard, so the person is signed in and the tenant was checked before this rule sees the link: a
/// link opened while signed out goes to sign-in and comes back here afterwards; a link that names another tenant never gets
/// here. It then does exactly one thing: it opens the notification (MOB-33), marked as opened from a push. It reveals nothing
/// and decides nothing: the screen reads the notification under the permission of the moment, shows nothing of a record the
/// member lost access to, and the open marks it read, never acknowledged. A link of that path that is not of the shape of an
/// opaque link goes to the access-denied screen, which tells nothing about what exists.
String? opaqueLinkRule(Uri target, String Function(String screenId) locationOf) {
  if (!isOpaquePath(target)) return null;
  final String? id = opaqueIdOf(target);
  if (id == null) return locationOf(kAccessDeniedScreenId);
  return Uri(path: '${locationOf('MOB-33')}/${Uri.encodeComponent(id)}', queryParameters: <String, String>{openedViaParameter: openedViaPush}).toString();
}
