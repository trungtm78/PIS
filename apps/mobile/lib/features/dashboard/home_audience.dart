import '../read_support/wire.dart';

/// Who the home tab is laid out for (R53, docs/mobile-ux/design-system-v2.md): a leader gets the command band, the three figures and "what waits for your decision"; an officer gets "today's work", their own
/// tasks ordered by deadline. The layout follows the authority the server gave the person, never a name of a role typed on the phone.
enum HomeAudience { leader, officer }

/// The permissions that make a person somebody who decides for a scope: the authority to decide an approval, and the reading of the steering committee. A person who holds neither works on their own tasks.
const List<String> kLeaderPermissions = <String>['approval.decide', 'committee.read'];

/// Whether a permission a grant holds covers [wanted]: the same permission, or a pattern that ends in `.*` over its prefix, or `*`.
bool permissionCovers(String held, String wanted) {
  if (held == wanted || held == '*') return true;
  if (!held.endsWith('.*')) return false;
  final String prefix = held.substring(0, held.length - 1);
  return wanted.startsWith(prefix);
}

/// The audience of the answer of `getMyEffectiveAccess`: a leader when a grant or a delegation in force carries one of [kLeaderPermissions]; an officer otherwise. Null when the answer is not what the contract
/// says (the home then keeps the layout it has always had, and guesses nothing).
HomeAudience? homeAudienceOf(Object? raw) {
  final Json? access = asRecord(raw);
  if (access == null || access['grants'] is! List<Object?>) return null;
  bool decides(Object? entry) {
    final Json? row = asRecord(entry);
    if (row == null || row['state'] != 'ACTIVE') return false;
    for (final Object? held in listOf(row['permissions'])) {
      if (held is String && kLeaderPermissions.any((String wanted) => permissionCovers(held, wanted))) return true;
    }
    return false;
  }

  final bool leader = listOf(access['grants']).any(decides) || listOf(access['delegations_in']).any(decides);
  return leader ? HomeAudience.leader : HomeAudience.officer;
}
