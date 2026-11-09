import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'push_config.dart';
import 'push_port.dart';

/// The thin layer over the push plugin. It holds no rule: it turns the calls of the plugin into plain values, so the adapter above it
/// (`DevicePushPlatform`) is tested with a fake gateway and the plugin is the only thing that needs a device.
abstract interface class PushGateway {
  /// Starts the provider with the options of the build. Called once; calling it again changes nothing.
  Future<void> start(PushConfig config);

  /// What the operating system allows now (reads, never asks).
  Future<PushPermission> permission();

  /// The token of the provider, or null when there is none (no permission, no network, no provider).
  Future<String?> token();

  Stream<String> get tokenRefreshes;

  /// The data of a message that arrived while the application is in the foreground.
  Stream<Map<String, Object?>> get foreground;

  /// The data of a message the person tapped while the application was in the background.
  Stream<Map<String, Object?>> get opened;

  /// The data of the message whose tap started the application, once.
  Future<Map<String, Object?>?> launchedBy();

  /// Deletes the token at the provider, so the next one is a new token.
  Future<void> deleteToken();
}

Map<String, Object?> _dataOf(RemoteMessage message) => <String, Object?>{...message.data};

/// The gateway on `firebase_messaging`. The options come from the build (`--dart-define`), so no configuration file is read.
final class FirebasePushGateway implements PushGateway {
  FirebasePushGateway();

  FirebaseMessaging? _messaging;

  FirebaseMessaging get _plugin => _messaging ?? (throw StateError('the push gateway was not started'));

  @override
  Future<void> start(PushConfig config) async {
    if (_messaging != null) return;
    if (Firebase.apps.isEmpty) {
      await Firebase.initializeApp(
        options: FirebaseOptions(apiKey: config.apiKey, appId: config.appId, messagingSenderId: config.senderId, projectId: config.projectId),
      );
    }
    _messaging = FirebaseMessaging.instance;
  }

  @override
  Future<PushPermission> permission() async {
    final NotificationSettings settings = await _plugin.getNotificationSettings();
    switch (settings.authorizationStatus) {
      case AuthorizationStatus.authorized:
        return PushPermission.granted;
      case AuthorizationStatus.provisional:
        return PushPermission.provisional;
      case AuthorizationStatus.denied:
        return PushPermission.denied;
      case AuthorizationStatus.notDetermined:
        return PushPermission.unknown;
    }
  }

  @override
  Future<String?> token() async {
    try {
      return await _plugin.getToken();
    } on FirebaseException {
      // No token yet (the APNs token of iOS is not there, no network): the registration is made again at the next start or refresh.
      return null;
    }
  }

  @override
  Stream<String> get tokenRefreshes => _plugin.onTokenRefresh;

  @override
  Stream<Map<String, Object?>> get foreground => FirebaseMessaging.onMessage.map(_dataOf);

  @override
  Stream<Map<String, Object?>> get opened => FirebaseMessaging.onMessageOpenedApp.map(_dataOf);

  @override
  Future<Map<String, Object?>?> launchedBy() async {
    final RemoteMessage? message = await _plugin.getInitialMessage();
    return message == null ? null : _dataOf(message);
  }

  @override
  Future<void> deleteToken() async {
    try {
      await _plugin.deleteToken();
    } on FirebaseException {
      // The token stays at the provider; the server already revoked the registration, so nothing is sent to it.
    }
  }
}

/// The gateway of the build; tests override it with a fake.
final Provider<PushGateway> pushGatewayProvider = Provider<PushGateway>((Ref ref) => FirebasePushGateway());
