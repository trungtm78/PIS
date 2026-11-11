import 'dart:math';

import '../release/app_info.dart';
import '../session/auth/secure_store.dart';

/// The key under which the identity of this installation is kept in the secure store.
const String kInstallIdKey = 'push.install_id';

/// The identity of an installation: 32 random characters from the system generator, made once and kept in the secure store. It is not the
/// token and not a hardware id, so a reinstall is a new installation.
String newInstallId([Random? random]) {
  final Random generator = random ?? Random.secure();
  const String alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return List<String>.generate(32, (int _) => alphabet[generator.nextInt(alphabet.length)]).join();
}

/// What a registration of the device says about the installation, whatever the push provider is: the identity that the server keys the
/// registration by (and, through the registration, the offline command queue names as its device) and the version of the application.
///
/// It is shared by every adapter of the push port, so a build without push has an identity of its own, as a build with push has: two phones
/// of one person must never share a registration because neither of them has a provider.
final class InstallIdentity {
  InstallIdentity({SecureValueStore? store, Future<AppInfo> Function()? info, Random? random})
      : _store = store,
        _info = info ?? (() => const PlatformAppInfoSource().read()),
        _random = random;

  final SecureValueStore? _store;
  final Future<AppInfo> Function() _info;
  final Random? _random;
  AppInfo? _loaded;
  String? _installId;

  /// The version the application reported, once [installId] has been read (the registration reads it first).
  String get appVersion => _loaded?.full ?? '0.0.0';

  /// The identity of this installation: read from the secure store, or made and kept there. Without a store (a test, a host that has none) it
  /// is made once for the life of this object.
  Future<String> installId() async {
    _loaded ??= await _info();
    final String? known = _installId ?? await _store?.read(kInstallIdKey);
    if (known != null && known.length >= 16) return _installId = known;
    final String made = newInstallId(_random);
    await _store?.write(kInstallIdKey, made);
    return _installId = made;
  }
}
