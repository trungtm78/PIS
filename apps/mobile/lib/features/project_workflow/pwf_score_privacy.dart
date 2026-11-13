import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session/session.dart';

/// The privacy of the score of a person (R33, BR-PWF-40). The score is read-only on the phone and is the person's own: the screen shows what the
/// server answers to `getMyStaffScore` and nothing else, so a manager's view of the scores of other people is not on the phone at all.
///
/// Nothing of it is kept: the answer is read with `keepCopy: false` (no copy on the device, none in the read cache), so a person who loses the right,
/// or hands the phone to someone else, finds no score left. What the open screen holds in memory is dropped as soon as the scope changes: the
/// screen is keyed by it.
///
/// The server does not hand the phone a version of the rights. Until it does, the scope is what changes with them on the phone: the status of the
/// session, the tenant, the person, the membership (unit and role) that is selected, the mode of the session and whether the device is locked. A
/// right taken away answers 403 on the next read, which is shown as "no access" and never falls back to anything kept.
String pwfScoreScopeOf(SessionSnapshot session) => <Object?>[session.status.name, session.tenantId, session.userId, session.membershipId, session.mode.name, session.locked].join('|');

final Provider<String> pwfScoreScopeProvider = Provider<String>((Ref ref) => pwfScoreScopeOf(ref.watch(sessionProvider)));
