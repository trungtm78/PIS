import '../read_support/wire.dart';

/// A role the person holds, as `getMyEffectiveAccess` names it: the code of the role and the name its organisation gave it.
typedef HeldRole = ({String code, String name});

/// The words of the interface for a key, as `context.t` gives them.
typedef RoleWords = String Function(String key, [Map<String, Object> values]);

/// A grant of a role as `getMyEffectiveAccess` gives it: the role, its rank and the instant the grant ends. Only the grants the server said were in
/// force (`state: ACTIVE`) are kept; the end is kept with each, because a grant can end between the read and the moment the screen is drawn.
final class HeldGrant {
  const HeldGrant({required this.code, required this.name, required this.rank, this.effectiveUntil});

  final String code;
  final String name;
  final num rank;

  /// The instant the grant ends (`effective_until`); null for a grant with no end.
  final DateTime? effectiveUntil;

  /// Whether the grant is still in force at [now]: the window is judged as the server judges it (`now < effective_until`).
  bool inForceAt(DateTime now) => effectiveUntil == null || now.isBefore(effectiveUntil!);
}

/// The grants in force of the answer of `getMyEffectiveAccess`, in the order the server gave them. Null when the answer is not what the contract
/// says (the screen then says no role, and never takes the type of the membership for one).
List<HeldGrant>? heldGrantsOf(Object? raw) {
  final Json? access = asRecord(raw);
  if (access == null || access['grants'] is! List<Object?>) return null;
  final List<HeldGrant> grants = <HeldGrant>[];
  for (final Object? entry in listOf(access['grants'])) {
    final Json? grant = asRecord(entry);
    final String? code = filled(grant?['role_code']);
    if (grant == null || grant['state'] != 'ACTIVE' || code == null) continue;
    final Object? rank = grant['rank'];
    final String? until = filled(grant['effective_until']);
    final DateTime? end = until == null ? null : DateTime.tryParse(until);
    // An end that is said and cannot be read is not "no end": the grant is left out rather than shown for ever.
    if (until != null && end == null) continue;
    grants.add(HeldGrant(code: code, name: filled(grant['role_name']) ?? '', rank: rank is num ? rank : 0, effectiveUntil: end));
  }
  return grants;
}

/// The HIGHEST role in force of the person at [now] (by rank): the same rule the web shell names the person by
/// (`apps/web/src/shell/account-role.ts`). A grant whose end has passed at [now] is not counted, whatever the server said when it was read.
/// Null when no grant is in force.
HeldRole? highestRoleOf(List<HeldGrant> grants, DateTime now) {
  HeldGrant? top;
  for (final HeldGrant grant in grants) {
    if (!grant.inForceAt(now)) continue;
    if (top == null || grant.rank > top.rank) top = grant;
  }
  return top == null ? null : (code: top.code, name: top.name);
}

final RegExp _partSuffix = RegExp(r' \(phần \d+\)$', unicode: true);

/// The name of [role] as the person reads it (L5). A role of the product has its words in the catalogue (its stored name is a key, not words); a role
/// of the organisation shows the name the organisation gave it (a role made in several parts shows one name). Null when there are no words to show:
/// the name is empty, is the code itself, or is a key of the catalogue.
String? roleNameOf(HeldRole role, RoleWords t) {
  switch (role.code) {
    case 'TENANT_OWNER':
      return t('mob.account.role.tenantOwner');
    case 'TENANT_ADMIN':
      return t('mob.account.role.tenantAdmin');
    case 'SECURITY_ADMIN':
      return t('mob.account.role.securityAdmin');
    case 'UNIT_ADMIN':
      return t('mob.account.role.unitAdmin');
    case 'LEADER':
      return t('mob.account.role.leader');
    case 'COMMITTEE_HEAD':
      return t('mob.account.role.committeeHead');
    case 'COMMITTEE_MEMBER':
      return t('mob.account.role.committeeMember');
    case 'COMMITTEE_SECRETARIAT':
      return t('mob.account.role.committeeSecretariat');
    case 'AUDITOR':
      return t('mob.account.role.auditor');
    case 'STAFF_MEMBER':
      return t('mob.account.role.staffMember');
    case 'MEMBER':
      return t('mob.account.role.member');
  }
  final String name = role.name.replaceFirst(_partSuffix, '').trim();
  return name.isEmpty || name == role.code || name.startsWith('iam.role.') ? null : name;
}
