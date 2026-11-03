import '../../core/navigation/feature.dart';
import 'photo_strings.dart';
import 'screens/photo_screen.dart';

/// QMS-10 (ST-QMS-003, FR-QMS-10): a site photograph taken or chosen on the phone, linked to a contract and a diary, with the flags that
/// can be known before it is kept (no place, no time of capture, the same file already registered) and a place that is kept only with
/// the consent of the person. The tools are those of `field_evidence` (the camera, the photograph pipeline, the place with its consent);
/// the photographs go up through the uploader of the offline layer. `?contract=<id>` and `?diary=<id>` open the form with them chosen.
const MobileFeature feature = MobileFeature(
  id: 'site_photo',
  strings: sitePhotoStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'QMS-10', builder: buildPhotoScreen),
  ],
);
