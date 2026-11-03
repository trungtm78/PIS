import '../../core/navigation/feature.dart';
import 'field_evidence_strings.dart';

/// ST-MOB-014: the tools of the field screens that handle photographs and places (the photograph pipeline, the marks, the place
/// with its consent, the camera and position ports). It has no screen of its own: the issues (MOB-28 to MOB-31), the site diary
/// and the quantities build on it.
const MobileFeature feature = MobileFeature(
  id: 'field_evidence',
  strings: fieldEvidenceStrings,
);
