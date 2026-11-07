import '../core/edition/edition.dart';
import '../editions/enterprise/enterprise_profile.dart';

const String _editionDefine = String.fromEnvironment('MACHVON_EDITION');

/// Whether this build was made as the enterprise edition. A compile-time constant: in a public build the branch below is dropped, so the enterprise
/// strings are not in the binary.
const bool _enterpriseBuild = _editionDefine == 'enterprise';

/// The enterprise profile this build carries, or null for a build that does not.
const EditionProfile? kBuildEnterpriseProfile = _enterpriseBuild
    ? kEnterpriseEditionProfile
    : null;

/// The one place of the phone that names the enterprise folder (ENT-0, R20); `npm run edition:check` and the module rules allow this file and no other
/// shared one to do so. The enterprise edition fails, naming the edition, when the build does not carry it ([enterprise] is for tests that bring their own).
EditionProfile editionProfileFor(
  Edition edition, {
  EditionProfile? enterprise = kBuildEnterpriseProfile,
}) {
  switch (edition) {
    case Edition.public:
      return kPublicEditionProfile;
    case Edition.enterprise:
      if (enterprise == null) {
        throw StateError(
          'the enterprise edition was selected but this build does not carry it (build with --dart-define=MACHVON_EDITION=enterprise)',
        );
      }
      return enterprise;
  }
}
