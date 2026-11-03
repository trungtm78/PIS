import '../security/device_integrity.dart' show IntegrityRestriction;

/// The screen a signed-out user is sent to.
const String kSignInScreenId = 'MOB-02';

/// The screen that tells the user the session ended.
const String kSessionExpiredScreenId = 'MOB-44';

/// The screen that tells the user the access is not allowed (a wrong tenant, a missing grant).
const String kAccessDeniedScreenId = 'MOB-45';

/// The screens that open without a session: tenant discovery, sign-in, MFA, unit and role selection (the session is
/// being built there), the session-expired screen (it leads back to sign-in) and the forced-upgrade screen. They are
/// shown without the bottom navigation. Every other screen needs a session and is guarded (BR-MOB-05).
const Set<String> kPublicScreenIds = <String>{'MOB-01', 'MOB-02', 'MOB-03', 'MOB-04', 'MOB-44', 'MOB-54'};

/// The screens that keep working during a maintenance window because they work from the device: the offline queue, the
/// conflict screen and the sync settings (MOB-54: the offline drafts stay available).
const Set<String> kMaintenanceReachableScreenIds = <String>{'MOB-41', 'MOB-42', 'MOB-43'};

/// The screen that stops the user during a maintenance window or when the version must be updated.
const String kReleaseNoticeScreenId = 'MOB-54';

/// The screen that asks for the second factor (the step-up of the session).
const String kSecondFactorScreenId = 'MOB-03';

/// Whether the screen opens without a session.
bool isPublicScreen(String screenId) => kPublicScreenIds.contains(screenId);

/// The screens that show money or a decision: the approvals (MOB-23 to 26), the signing of a document (MOB-67, and DOC-22 which is the same
/// signing view with the return of the document), the payments
/// (MOB-27 and 60) and the amounts of the weekly report (MOB-14 to 17, the review MOB-20, its result MOB-21 and the estimate
/// MOB-56). The window is protected against screenshots, screen recording and the thumbnail of the app switcher while one of them
/// is shown (ST-MOB-041, SEC-04); the rest of the application is not, because a person legitimately needs a screenshot of a map,
/// a photograph or a task.
const Set<String> kSecureScreenIds = <String>{
  'MOB-14', 'MOB-15', 'MOB-16', 'MOB-17', 'MOB-20', 'MOB-21', 'MOB-23', 'MOB-24', 'MOB-25', 'MOB-26', 'MOB-27', 'MOB-56', 'MOB-60', 'MOB-67', 'DOC-22',
};

/// The screens whose action a phone that looks modified may not take without the second factor, under a tenant that restricts such
/// phones (D-SEC-01, `restrict_sensitive`): the approval and the return of a task (MOB-25, MOB-26) and the signing of a document
/// (MOB-67, DOC-22).
const Map<String, IntegrityRestriction> kIntegrityRestrictedScreens = <String, IntegrityRestriction>{
  'MOB-25': IntegrityRestriction.approvals,
  'MOB-26': IntegrityRestriction.approvals,
  'MOB-67': IntegrityRestriction.signing,
  'DOC-22': IntegrityRestriction.signing,
};
