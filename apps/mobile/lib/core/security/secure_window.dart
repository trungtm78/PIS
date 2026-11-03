import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The name of the channel the two platforms listen on (`MainActivity.kt`, `AppDelegate.swift` and `SceneDelegate.swift`).
const String kSecureWindowChannel = 'vn.machvon/secure_window';

/// What the platform does for a window that shows money or a decision (ST-MOB-041, decision D-SEC-03 of
/// `docs/mobile-security-review.md`): on Android the window is flagged secure (no screenshot, no screen recording, a blank
/// thumbnail in the app switcher); on iOS a cover hides the content when the scene leaves the foreground and while the screen is
/// being captured.
abstract interface class SecureWindowPlatform {
  /// Turns the protection on or off. Returns whether the platform did it (false on a host with no platform side, or when the
  /// platform refused).
  Future<bool> setSecure({required bool enabled});
}

/// The platform side through a method channel, `set` with `{enabled: bool}`.
final class MethodChannelSecureWindow implements SecureWindowPlatform {
  const MethodChannelSecureWindow({MethodChannel channel = const MethodChannel(kSecureWindowChannel)}) : _channel = channel;

  final MethodChannel _channel;

  @override
  Future<bool> setSecure({required bool enabled}) async {
    try {
      await _channel.invokeMethod<void>('set', <String, Object>{'enabled': enabled});
      return true;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }
}

/// Counts the screens that want the window protected and tells the platform when the first one appears and when the last one
/// goes, so two sensitive screens on top of each other never switch the protection off early, and a sensitive screen that is
/// covered by an ordinary one does not keep it on.
final class SecureWindowController {
  SecureWindowController(this._platform);

  final SecureWindowPlatform _platform;
  int _holders = 0;
  bool _requested = false;
  Future<void> _tail = Future<void>.value();

  /// Whether the last request reached the platform. False means the content of the screen is not protected on this device.
  bool applied = false;

  /// How many screens hold the protection now.
  int get holders => _holders;

  /// Asks for the protection and returns the function that gives it back (calling it twice gives it back once).
  void Function() acquire() {
    _holders += 1;
    _sync();
    bool released = false;
    return () {
      if (released) return;
      released = true;
      _holders -= 1;
      _sync();
    };
  }

  void _sync() {
    final bool wanted = _holders > 0;
    if (wanted == _requested) return;
    _requested = wanted;
    _tail = _tail.then((void _) async {
      applied = await _platform.setSecure(enabled: wanted);
    });
  }

  /// Completes when every request made so far has reached the platform (for tests).
  Future<void> get settled => _tail;
}

/// The platform side. A test overrides it with a recording one; the host has none and answers "not applied".
final Provider<SecureWindowPlatform> secureWindowPlatformProvider = Provider<SecureWindowPlatform>((Ref ref) => const MethodChannelSecureWindow());

final Provider<SecureWindowController> secureWindowControllerProvider =
    Provider<SecureWindowController>((Ref ref) => SecureWindowController(ref.watch(secureWindowPlatformProvider)));
