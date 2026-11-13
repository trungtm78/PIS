import 'dart:math' as math;

import '../permissions/permission_service.dart';

/// Where a place came from. The label is part of the record (BR-MOB-06): a place typed by a person is never presented as one the
/// phone measured.
enum PlaceSource { none, device, manual }

/// A position measured by the phone: [accuracyMetres] is how far off it may be.
final class DevicePosition {
  const DevicePosition({
    required this.latitude,
    required this.longitude,
    required this.accuracyMetres,
  });

  final double latitude;
  final double longitude;
  final double accuracyMetres;
}

/// Above this the position is shown as a poor one and never as a proof of where the photograph was taken (BR-ISS-06).
const double kLowAccuracyMetres = 50;

/// The place of a report or a photograph, with the consent that allows it to be kept.
///
/// A position measured by the phone exists only together with the consent of the person: giving it without one is refused, and
/// taking the consent back takes the position with it (NFR-PRIVACY-01). A place typed by hand needs no measurement and says so
/// ([PlaceSource.manual]). Coordinates are never sent for a manual place: they would pass as a measurement.
final class FieldPlace {
  const FieldPlace._({
    required this.source,
    required this.consent,
    this.position,
    this.manualText,
  });

  /// No place, consent not given.
  static const FieldPlace none = FieldPlace._(
    source: PlaceSource.none,
    consent: false,
  );

  final PlaceSource source;

  /// The person agreed that the position of the phone is kept with the record.
  final bool consent;
  final DevicePosition? position;
  final String? manualText;

  bool get hasDevicePosition =>
      source == PlaceSource.device && position != null;
  bool get hasPlace => source != PlaceSource.none;
  bool get isLowAccuracy =>
      hasDevicePosition && position!.accuracyMetres > kLowAccuracyMetres;

  /// The person agrees (or not) that the position is kept. Taking the consent back drops a measured position; a place typed by
  /// hand stays, because it was never measured.
  FieldPlace withConsent(bool given) {
    if (given)
      return FieldPlace._(
        source: source,
        consent: true,
        position: position,
        manualText: manualText,
      );
    return source == PlaceSource.manual
        ? FieldPlace._(source: source, consent: false, manualText: manualText)
        : none;
  }

  /// The position the phone measured. Refused without the consent: a position nobody agreed to keep is not held at all.
  FieldPlace withDevicePosition(DevicePosition measured) {
    if (!consent)
      throw StateError('a measured position is not held without consent');
    return FieldPlace._(
      source: PlaceSource.device,
      consent: true,
      position: measured,
    );
  }

  /// The place the person typed, which replaces a measured one; the consent decision is not touched.
  FieldPlace withManual(ManualLocation typed) => FieldPlace._(
    source: PlaceSource.manual,
    consent: consent,
    manualText: typed.text,
  );

  FieldPlace clearPlace() =>
      FieldPlace._(source: PlaceSource.none, consent: consent);

  Map<String, Object?> toJson() => <String, Object?>{
    'source': source.name,
    'consent': consent,
    if (position != null) 'latitude': position!.latitude,
    if (position != null) 'longitude': position!.longitude,
    if (position != null) 'accuracy_m': position!.accuracyMetres,
    if (manualText != null) 'manual_text': manualText,
  };

  /// A place from its stored form. A measured position stored without the consent (a damaged draft) is not trusted: it is dropped.
  static FieldPlace fromJson(Object? json) {
    if (json is! Map) return none;
    final bool consent = json['consent'] == true;
    final Object? source = json['source'];
    if (source == PlaceSource.manual.name && json['manual_text'] is String) {
      return FieldPlace._(
        source: PlaceSource.manual,
        consent: consent,
        manualText: json['manual_text'] as String,
      );
    }
    final Object? lat = json['latitude'];
    final Object? lng = json['longitude'];
    final Object? accuracy = json['accuracy_m'];
    if (source == PlaceSource.device.name &&
        consent &&
        lat is num &&
        lng is num &&
        accuracy is num) {
      return FieldPlace._(
        source: PlaceSource.device,
        consent: true,
        position: DevicePosition(
          latitude: lat.toDouble(),
          longitude: lng.toDouble(),
          accuracyMetres: accuracy.toDouble(),
        ),
      );
    }
    return FieldPlace._(
      source: PlaceSource.none,
      consent: consent && source != PlaceSource.device,
    );
  }
}

/// The measurements as the server reads them (`geo_lat` is a decimal text, at most 15 decimals): six decimals are about ten
/// centimetres, more than a phone can know.
String latitudeText(DevicePosition position) =>
    fixedDecimal(position.latitude, 6);
String longitudeText(DevicePosition position) =>
    fixedDecimal(position.longitude, 6);
String accuracyText(DevicePosition position) =>
    fixedDecimal(position.accuracyMetres, 2);

/// A number with exactly [digits] decimals and a dot: the decimal text of the wire (`geo_lat`, `geo_accuracy_m`), which the server reads as it
/// is written here whatever the language of the screen. What a person reads is made from it by `coordinateLabel`.
String fixedDecimal(double value, int digits) {
  final int scaled = (value.abs() * math.pow(10, digits)).round();
  final String padded = scaled.toString().padLeft(digits + 1, '0');
  final String sign = value < 0 && scaled != 0 ? '-' : '';
  return '$sign${padded.substring(0, padded.length - digits)}.${padded.substring(padded.length - digits)}';
}
