import 'dart:convert';

import 'package:permission_handler/permission_handler.dart' as handler;

import '../session/auth/secure_store.dart';

/// What the application may ask the phone for. Each is asked for only when the person uses the feature that needs it, after
/// the rationale screen, and each has a way to do the same thing without it.
enum AppPermission {
  /// Push notifications. Without them the in-app notifications still work.
  notifications,

  /// The camera. Without it the person attaches a file.
  camera,

  /// The position while the app is in use (never in the background). Without it the person enters a place by hand.
  location,
}

/// Where a permission stands on this phone.
enum PermissionState {
  /// The phone has not been asked yet (or the answer was "ask again" on Android).
  notAsked,

  granted,

  /// The person said no; the system may show its prompt again.
  denied,

  /// The system will not show its prompt again (denied for good, or restricted by a policy): only the settings of the phone can
  /// change it.
  blocked,
}

/// The permission service of the phone: ask, read, open the settings. The adapter below is the only code that touches the
/// plugin; the rest runs against a fake in tests.
abstract interface class PermissionPlatform {
  Future<PermissionState> status(AppPermission permission);

  /// Shows the system prompt. Call it only after the rationale screen.
  Future<PermissionState> request(AppPermission permission);

  /// Opens the settings page of this application on the phone.
  Future<bool> openSettings();
}

/// The [PermissionPlatform] on `permission_handler`.
final class HandlerPermissionPlatform implements PermissionPlatform {
  const HandlerPermissionPlatform();

  static handler.Permission _of(AppPermission permission) {
    switch (permission) {
      case AppPermission.notifications:
        return handler.Permission.notification;
      case AppPermission.camera:
        return handler.Permission.camera;
      case AppPermission.location:
        return handler.Permission.locationWhenInUse;
    }
  }

  @override
  Future<PermissionState> status(AppPermission permission) async => _map(await _of(permission).status);

  @override
  Future<PermissionState> request(AppPermission permission) async => _map(await _of(permission).request());

  @override
  Future<bool> openSettings() => handler.openAppSettings();

  static PermissionState _map(handler.PermissionStatus status) {
    switch (status) {
      case handler.PermissionStatus.granted:
      case handler.PermissionStatus.limited:
      case handler.PermissionStatus.provisional:
        return PermissionState.granted;
      case handler.PermissionStatus.denied:
        return PermissionState.denied;
      case handler.PermissionStatus.permanentlyDenied:
      case handler.PermissionStatus.restricted:
        return PermissionState.blocked;
    }
  }
}

/// What the device remembers about asking: whether the system prompt was shown for a permission. It lets the screens tell
/// "never asked" from "asked and refused", which the plugin reports the same way on iOS. Nothing about the person.
class PermissionLedger {
  PermissionLedger(this._store);

  final SecureValueStore _store;

  static const String _key = 'permissions.v1';

  Future<Set<AppPermission>> asked() async {
    final String? raw = await _store.read(_key);
    if (raw == null) return <AppPermission>{};
    try {
      final Object? decoded = jsonDecode(raw);
      return decoded is List<Object?> ? <AppPermission>{for (final AppPermission p in AppPermission.values) if (decoded.contains(p.name)) p} : <AppPermission>{};
    } on FormatException {
      return <AppPermission>{};
    }
  }

  Future<void> markAsked(AppPermission permission) async {
    final Set<AppPermission> now = (await asked())..add(permission);
    await _store.write(_key, jsonEncode(<String>[for (final AppPermission p in now) p.name]));
  }
}

/// Reads and asks. A permission the phone reports as denied but that was never asked for is `notAsked`, so the screen offers
/// "Allow" rather than a link to the settings.
class PermissionService {
  PermissionService({required PermissionPlatform platform, required PermissionLedger ledger}) : _platform = platform, _ledger = ledger;

  final PermissionPlatform _platform;
  final PermissionLedger _ledger;

  Future<PermissionState> status(AppPermission permission) async {
    final PermissionState reported = await _platform.status(permission);
    if (reported == PermissionState.denied && !(await _ledger.asked()).contains(permission)) return PermissionState.notAsked;
    return reported;
  }

  /// Shows the system prompt (the caller has shown the rationale) and remembers that it was shown.
  Future<PermissionState> request(AppPermission permission) async {
    await _ledger.markAsked(permission);
    final PermissionState answer = await _platform.request(permission);
    return answer == PermissionState.notAsked ? PermissionState.denied : answer;
  }

  Future<bool> openSettings() => _platform.openSettings();
}

/// What else the person can do instead of granting a permission.
enum PermissionAlternative {
  /// Attach a file from the phone instead of using the camera.
  attachFile,

  /// Enter the place by hand, with the source labelled "entered by hand".
  manualLocation,
}

/// Where a position came from. A position typed by the person is never presented as one read from the phone.
enum LocationSource { device, manual }

/// A place entered by hand, with its source label. [text] is what the person typed (a place name or "lat, lng").
final class ManualLocation {
  const ManualLocation._({required this.text, this.latitude, this.longitude});

  static const int minLength = 3;
  static const int maxLength = 200;
  final String text;
  final double? latitude;
  final double? longitude;

  LocationSource get source => LocationSource.manual;

  /// Reads what the person typed; null when it is too short, too long, or holds control characters. A pair of numbers
  /// "lat, lng" inside the range of the earth also gives the coordinates.
  static ManualLocation? tryParse(String input) {
    final String text = input.trim().replaceAll(RegExp(r'\s+'), ' ');
    if (text.length < minLength || text.length > maxLength || text.codeUnits.any((int unit) => unit < 0x20 || unit == 0x7f)) return null;
    final Match? pair = RegExp(r'^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$').firstMatch(text);
    if (pair != null) {
      final double latitude = double.parse(pair.group(1)!);
      final double longitude = double.parse(pair.group(2)!);
      if (latitude.abs() <= 90 && longitude.abs() <= 180) return ManualLocation._(text: text, latitude: latitude, longitude: longitude);
    }
    return ManualLocation._(text: text);
  }
}

/// How a rationale screen ended: the state of each permission it asked about, whether the person put it off, and the
/// alternative they chose (with the place they typed). The caller continues the feature accordingly.
final class PermissionOutcome {
  const PermissionOutcome({
    this.states = const <AppPermission, PermissionState>{},
    this.deferred = false,
    this.alternative,
    this.manualLocation,
  });

  final Map<AppPermission, PermissionState> states;
  final bool deferred;
  final PermissionAlternative? alternative;
  final ManualLocation? manualLocation;

  bool isGranted(AppPermission permission) => states[permission] == PermissionState.granted;
}
