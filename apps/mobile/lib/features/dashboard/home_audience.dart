import '../read_support/wire.dart';

/// Who the home tab is laid out for (R53, docs/mobile-ux/design-system-v2.md): a leader gets the command band, the three figures and "what waits for your decision"; an officer gets "today's work": their own
/// workflow tasks, the approvals that wait for them and their unread notifications. The server says which (`home_audience` of `getMyEffectiveAccess`); the phone never judges it from a name of a role, and a
/// right to READ (the workspace of the steering committee, the dashboards) never makes a leader.
enum HomeAudience { leader, officer }

/// The authority that makes a person somebody who decides for a unit, for a server that does not say the audience yet: deciding an approval over a unit or wider.
const String kLeaderPermission = 'approval.decide';

/// The scopes that are a unit or wider; an authority over one project or one contract is the work of an officer of that project.
const List<String> kLeaderScopes = <String>['TENANT', 'UNIT_SUBTREE', 'UNIT_ONLY'];

/// Whether a permission a grant holds covers [wanted]: the same permission, or a pattern that ends in `.*` over its prefix. A bare `*` holds nothing, as on the server.
bool permissionCovers(String held, String wanted) {
  if (held == wanted) return true;
  if (!held.endsWith('.*')) return false;
  final String prefix = held.substring(0, held.length - 1);
  return wanted.length > prefix.length && wanted.startsWith(prefix);
}

/// The audience of the answer of `getMyEffectiveAccess`: what the server says (`home_audience`), and for a server that does not say it, a leader when a grant or a delegation in force carries
/// [kLeaderPermission] over a unit or wider and an officer otherwise. Null when the answer is not what the contract says (the home then keeps the layout it has always had, and guesses nothing).
HomeAudience? homeAudienceOf(Object? raw) {
  final Json? access = asRecord(raw);
  if (access == null || access['grants'] is! List<Object?>) return null;
  switch (access['home_audience']) {
    case 'LEADER':
      return HomeAudience.leader;
    case 'OFFICER':
      return HomeAudience.officer;
  }
  bool decides(Object? entry) {
    final Json? row = asRecord(entry);
    if (row == null || row['state'] != 'ACTIVE' || !kLeaderScopes.contains(row['scope_kind'])) return false;
    for (final Object? held in listOf(row['permissions'])) {
      if (held is String && permissionCovers(held, kLeaderPermission)) return true;
    }
    return false;
  }

  final bool leader = listOf(access['grants']).any(decides) || listOf(access['delegations_in']).any(decides);
  return leader ? HomeAudience.leader : HomeAudience.officer;
}
