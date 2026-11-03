import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart' as geo;
import 'package:image_picker/image_picker.dart';

import 'field_place.dart';

/// Where a photograph comes from: the camera, or a file the person chooses when the camera is not allowed or not wanted. The
/// plugin is behind this port so the screens are tested on a host; only a device proves the plugin itself.
abstract interface class PhotoSource {
  /// Opens the camera and returns the photograph, or null when the person leaves without taking one.
  Future<File?> takePhoto();

  /// Opens the gallery and returns the picture chosen, or null when the person leaves without choosing.
  Future<File?> pickPhoto();

  /// Deletes the file [takePhoto] or [pickPhoto] returned, once the photograph has been prepared (or refused, or abandoned). The
  /// plug-in leaves a full copy of the picture, with the place and the time it says, in the cache of the application; nothing may
  /// keep it after the person has decided what is kept (SEC-03, BR-MOB-06).
  Future<void> discard(File picked);
}

/// Where the position of the phone comes from. Asked only after the person consented and the system permission is granted.
abstract interface class PositionSource {
  /// The position now, or null when the phone could not give one in time (no signal, services off).
  Future<DevicePosition?> current();
}

/// The camera and the gallery through `image_picker`. The picture is not scaled or recompressed by the plugin: what is sent is
/// decided by the pipeline of [PhotoSource] users, in one place.
///
/// `requestFullMetadata` is false: on iOS the default (true) makes the plugin ask for authorisation to the whole photo library so
/// that it can read the original metadata of the asset, and the person chose one picture, not their library (BR-MOB-06, data
/// minimisation). The picker of the system hands over the picture they chose without it. What the file says of where and when is
/// still read from the file itself and handled by the pipeline (stripped unless the person consented), so nothing in the consent
/// logic depends on the library permission. Info.plist still carries `NSPhotoLibraryUsageDescription`: the store policy requires
/// the entry for an application that uses the picker, and it is the text shown should a library permission ever be asked.
final class ImagePickerPhotoSource implements PhotoSource {
  const ImagePickerPhotoSource();

  Future<File?> _get(ImageSource source) async {
    final XFile? file = await ImagePicker().pickImage(source: source, requestFullMetadata: false);
    return file == null ? null : File(file.path);
  }

  @override
  Future<File?> takePhoto() => _get(ImageSource.camera);

  @override
  Future<File?> pickPhoto() => _get(ImageSource.gallery);

  @override
  Future<void> discard(File picked) async {
    try {
      if (picked.existsSync()) await picked.delete();
    } on FileSystemException {
      // The cache is the system's to clear: a copy that cannot be deleted now is removed when the system clears it.
    }
  }
}

/// The position through `geolocator`, while the application is in use (never in the background), with a time limit.
final class GeolocatorPositionSource implements PositionSource {
  const GeolocatorPositionSource({this.timeout = const Duration(seconds: 20)});

  final Duration timeout;

  @override
  Future<DevicePosition?> current() async {
    try {
      final geo.Position position = await geo.Geolocator.getCurrentPosition(
        locationSettings: geo.LocationSettings(
          accuracy: geo.LocationAccuracy.high,
          timeLimit: timeout,
        ),
      );
      return DevicePosition(
        latitude: position.latitude,
        longitude: position.longitude,
        accuracyMetres: position.accuracy,
      );
    } on Object {
      return null;
    }
  }
}

final Provider<PhotoSource> photoSourceProvider = Provider<PhotoSource>(
  (Ref ref) => const ImagePickerPhotoSource(),
);

final Provider<PositionSource> positionSourceProvider =
    Provider<PositionSource>((Ref ref) => const GeolocatorPositionSource());
