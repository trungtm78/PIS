import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../release/app_info.dart';
import '../session/auth/secure_store.dart';
import 'push_config.dart';
import 'push_gateway.dart';
import 'push_port.dart';

/// The key under which the identity of this installation is kept in the secure store.
const String kInstallIdKey = 'push.install_id';

final RegExp _notificationId = RegExp(r'^[A-Za-z0-9_-]{16,64}$');

/// What a push carries for the phone: the id of the notification, nothing else. The server sends no title, no amount and no name in the
/// payload (they would sit on a lock screen and in the logs of the provider); the notification is read again from the server under the
/// permission of the moment. Any other key of the data is ignored, and an id that is not a plain token is no payload.
final class PushPayload {
  const PushPayload(this.notificationId);

  /// The key of the id in the data of a push.
  static const String idKey = 'nid';

  final String notificationId;

  static PushPayload? parse(Map<String, Object?> data) {
    final Object? raw = data[idKey];
    if (raw is! String || !_notificationId.hasMatch(raw)) return null;
    return PushPayload(raw);
  }

  /// The opaque deep link the router resolves (`/r/<id>`, BR-MOB-04): the link guard then checks the session and the tenant.
  String get location => '/r/$notificationId';
}

/// What arrives from the push provider while the application runs, as payloads.
abstract interface class PushInbound {
  /// A push that arrived while the application is in the foreground.
  Stream<PushPayload> get received;

  /// A push the person tapped while the application was in the background.
  Stream<PushPayload> get opened;

  /// The push whose tap started the application, once; null when it was started otherwise.
  Future<PushPayload?> launchedBy();
}

/// No push: nothing arrives.
final class NoPushInbound implements PushInbound {
  const NoPushInbound();

  @override
  Stream<PushPayload> get received => const Stream<PushPayload>.empty();

  @override
  Stream<PushPayload> get opened => const Stream<PushPayload>.empty();

  @override
  Future<PushPayload?> launchedBy() async => null;
}

/// What happened to a push on this device, for the delivery receipt.
enum PushReceiptEvent { delivered, opened }

/// The receipt of a push, as a port: the server learns that a notification reached or was opened on a device (lane ENT-3c plugs the call of
/// the receipt operation into it). Port only here: the default does nothing, and a failing receipt must never break the push.
abstract interface class PushReceiptPort {
  Future<void> acknowledge(String notificationId, PushReceiptEvent event);
}

final class NoPushReceipts implements PushReceiptPort {
  const NoPushReceipts();

  @override
  Future<void> acknowledge(String notificationId, PushReceiptEvent event) async {}
}

final Provider<PushReceiptPort> pushReceiptPortProvider = Provider<PushReceiptPort>((Ref ref) => const NoPushReceipts());

/// The identity of an installation: 32 random characters from the system generator, made once and kept in the secure store. It is not the
/// token and not a hardware id, so a reinstall is a new installation.
String newInstallId([Random? random]) {
  final Random generator = random ?? Random.secure();
  const String alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return List<String>.generate(32, (int _) => alphabet[generator.nextInt(alphabet.length)]).join();
}

/// The device adapter of the push port: the token and the permission from the gateway, an identity kept in the secure store, the version of
/// the application, and the payloads of the messages.
final class DevicePushPlatform implements PushPlatform, PushInbound {
  DevicePushPlatform({
    required PushGateway gateway,
    required PushConfig config,
    required SecureValueStore store,
    Future<AppInfo> Function()? info,
    String? platformName,
  })  : _gateway = gateway,
        _config = config,
        _store = store,
        _info = info ?? (() => const PlatformAppInfoSource().read()),
        _platformName = platformName;

  final PushGateway _gateway;
  final PushConfig _config;
  final SecureValueStore _store;
  final Future<AppInfo> Function() _info;
  final String? _platformName;
  Future<void>? _started;
  AppInfo? _loaded;
  String? _installId;

  /// Starts the provider once; false when it could not start (a wrong option, no play services): the adapter then behaves as the null adapter.
  Future<bool> _ready() async {
    try {
      await (_started ??= _gateway.start(_config));
      return true;
    } on Object {
      _started = null;
      return false;
    }
  }

  @override
  String get platform => _platformName ?? (defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android');

  /// The version the application reported, once [installId] has been read (the registration reads it first).
  @override
  String get appVersion => _loaded?.full ?? '0.0.0';

  @override
  Future<String> installId() async {
    _loaded ??= await _info();
    final String? known = _installId ?? await _store.read(kInstallIdKey);
    if (known != null && known.length >= 16) return _installId = known;
    final String made = newInstallId();
    await _store.write(kInstallIdKey, made);
    return _installId = made;
  }

  @override
  Future<PushPermission> permission() async {
    if (!await _ready()) return PushPermission.unknown;
    return _gateway.permission();
  }

  @override
  Future<String?> token() async {
    if (!await _ready()) return null;
    final PushPermission state = await _gateway.permission();
    if (state != PushPermission.granted && state != PushPermission.provisional) return null;
    return _gateway.token();
  }

  /// Refreshes of the token. The stream is opened when it is first listened to, after the provider has started.
  @override
  Stream<String> get tokenRefreshes => _afterStart<String>(() => _gateway.tokenRefreshes);

  /// The stream of the gateway, opened once the provider has started; empty when it could not start. Built from a future and not from an
  /// `async*` body, so that cancelling a listener ends it at once instead of waiting for the next message.
  Stream<T> _afterStart<T>(Stream<T> Function() source) => Stream<bool>.fromFuture(_ready()).asyncExpand((bool started) => started ? source() : Stream<T>.empty());

  @override
  Future<void> forgetToken() async {
    if (!await _ready()) return;
    await _gateway.deleteToken();
  }

  Stream<PushPayload> _payloads(Stream<Map<String, Object?>> Function() source) =>
      _afterStart<Map<String, Object?>>(source).map(PushPayload.parse).where((PushPayload? payload) => payload != null).cast<PushPayload>();

  @override
  Stream<PushPayload> get received => _payloads(() => _gateway.foreground);

  @override
  Stream<PushPayload> get opened => _payloads(() => _gateway.opened);

  @override
  Future<PushPayload?> launchedBy() async {
    if (!await _ready()) return null;
    final Map<String, Object?>? data = await _gateway.launchedBy();
    return data == null ? null : PushPayload.parse(data);
  }

  void dispose() {}
}
