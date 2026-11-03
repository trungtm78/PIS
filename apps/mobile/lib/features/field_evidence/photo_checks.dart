import 'evidence_photos.dart';
import 'field_place.dart';

/// Where the place of a photograph comes from, in the words of `site_photo.gps_source` (QMS 5.6): the position the phone measured
/// when the photograph was taken, the position inside the file (kept only with the consent), or none.
enum GpsSource {
  none('NONE'),
  deviceAtCapture('DEVICE_AT_CAPTURE'),
  exif('EXIF');

  const GpsSource(this.code);

  final String code;
}

/// What the reviewer will be told about a photograph, shown to the person before it is sent (QMS-10: "hiển thị cờ trước khi gửi").
/// A flag is a note for review and never stops a photograph: a missing place or time is a warning only, because the person may have
/// refused the position (BR-MOB-06) and the server does not call a photograph true or false.
final class PhotoChecks {
  const PhotoChecks({
    required this.gpsSource,
    required this.geoConsent,
    required this.placeMissing,
    required this.timeMissing,
  });

  final GpsSource gpsSource;

  /// The person consented to keep the position with the record: the flag the photograph is registered with.
  final bool geoConsent;
  final bool placeMissing;
  final bool timeMissing;

  /// A photograph is never refused for what it does not say.
  bool get blocking => false;

  bool get hasWarning => placeMissing || timeMissing;
}

PhotoChecks checksOf(EvidencePhoto photo, FieldPlace place) {
  final bool consent = place.consent;
  final GpsSource source = consent && place.hasDevicePosition
      ? GpsSource.deviceAtCapture
      : (consent && photo.keptGps ? GpsSource.exif : GpsSource.none);
  return PhotoChecks(
    gpsSource: source,
    geoConsent: consent,
    placeMissing: source == GpsSource.none,
    timeMissing: !photo.keptTime,
  );
}
