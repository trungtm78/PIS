import 'package:flutter/foundation.dart' show kDebugMode;
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

/// `--dart-define=MACHVON_ALLOW_SCREENSHOTS=true`: the build of a design review, whose protected screens (the approvals) have to be photographed.
/// Off unless it is set at build time.
const bool _allowScreenshotsDefine = bool.fromEnvironment('MACHVON_ALLOW_SCREENSHOTS');

/// Whether the protected screens of this build may be captured: only a DEBUG build that was built with the flag. A release build protects its
/// window whatever the flag says (the flag cannot weaken what a person installs), and a debug build without the flag protects it too.
bool screenCaptureAllowed({required bool define, required bool debugBuild}) => define && debugBuild;

/// What this build does (see [screenCaptureAllowed]).
const bool kScreenCaptureAllowed = _allowScreenshotsDefine && kDebugMode;

/// The platform side of a build whose protected screens may be captured: the platform is never asked to protect the window, and the answer is
/// "not applied", so nothing in the application believes the window is protected.
final class CapturableWindow implements SecureWindowPlatform {
  const CapturableWindow();

  @override
  Future<bool> setSecure({required bool enabled}) async => false;
}

/// The platform side of a build: the real one, or the one that lets the window be captured when [allowCapture] is in force.
SecureWindowPlatform secureWindowPlatformFor({required bool allowCapture}) => allowCapture ? const CapturableWindow() : const MethodChannelSecureWindow();

/// The platform side. A test overrides it with a recording one; the host has none and answers "not applied".
final Provider<SecureWindowPlatform> secureWindowPlatformProvider =
    Provider<SecureWindowPlatform>((Ref ref) => secureWindowPlatformFor(allowCapture: screenCaptureAllowed(define: _allowScreenshotsDefine, debugBuild: kDebugMode)));

final Provider<SecureWindowController> secureWindowControllerProvider =
    Provider<SecureWindowController>((Ref ref) => SecureWindowController(ref.watch(secureWindowPlatformProvider)));
