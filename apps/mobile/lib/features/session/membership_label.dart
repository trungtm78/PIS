import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/session/session.dart';
import 'auth/identity_api.dart';

/// Whether [choice] is the membership of the signed-in session. The tenant is part of the match: a membership id is the key of the
/// person inside one tenant, so a person who belongs to two organisations can carry the same id in both and the id alone names the
/// wrong organisation.
bool isCurrentMembership(MembershipChoice choice, SessionSnapshot session) =>
    choice.membershipId == session.membershipId &&
    (session.tenantId == null || choice.tenantId == session.tenantId);

/// The words of a membership type (the server's `STAFF`, `GUEST_CONTRACTOR`, `SERVICE_ACCOUNT`). A type this phone does not know is shown as the
/// server sent it, so a new type is never hidden.
String membershipTypeLabel(BuildContext context, String membershipType) {
  switch (membershipType) {
    case 'STAFF':
      return context.t('mob.account.membershipType.staff');
    case 'GUEST_CONTRACTOR':
      return context.t('mob.account.membershipType.guestContractor');
    case 'SERVICE_ACCOUNT':
      return context.t('mob.account.membershipType.serviceAccount');
  }
  return membershipType;
}
