import 'package:flutter_riverpod/flutter_riverpod.dart';

const String _modeDefine = String.fromEnvironment('MACHVON_PUSH');
const String _apiKeyDefine = String.fromEnvironment('MACHVON_FCM_API_KEY');
const String _appIdDefine = String.fromEnvironment('MACHVON_FCM_APP_ID');
const String _senderIdDefine = String.fromEnvironment('MACHVON_FCM_SENDER_ID');
const String _projectIdDefine = String.fromEnvironment('MACHVON_FCM_PROJECT_ID');

/// The push provider a build is made for.
enum PushMode { none, fcm }

/// The push configuration of a build, taken from `--dart-define` values only: nothing of it is committed, and neither
/// `google-services.json` nor `GoogleService-Info.plist` is needed (the options are handed to `Firebase.initializeApp` in code).
///
///  * `MACHVON_PUSH=fcm` asks for the device adapter (FCM on Android, APNs through FCM on iOS); nothing set, or `none`, is the null adapter;
///  * `MACHVON_FCM_API_KEY`, `MACHVON_FCM_APP_ID`, `MACHVON_FCM_SENDER_ID`, `MACHVON_FCM_PROJECT_ID` are the four options of the Firebase project.
///
/// A build that asks for `fcm` but misses an option does not fail and does not push: it runs on the null adapter and [missing] names the
/// variables, so the build passes without the keys and the gap is visible. A value other than `none` or `fcm` fails at start, as the edition does.
final class PushConfig {
  const PushConfig({this.mode = PushMode.none, this.apiKey = '', this.appId = '', this.senderId = '', this.projectId = ''});

  factory PushConfig.fromEnvironment() => PushConfig.parse(mode: _modeDefine, apiKey: _apiKeyDefine, appId: _appIdDefine, senderId: _senderIdDefine, projectId: _projectIdDefine);

  factory PushConfig.parse({String mode = '', String apiKey = '', String appId = '', String senderId = '', String projectId = ''}) {
    final String value = mode.trim().toLowerCase();
    final PushMode parsed;
    if (value.isEmpty || value == 'none') {
      parsed = PushMode.none;
    } else if (value == 'fcm') {
      parsed = PushMode.fcm;
    } else {
      throw const FormatException('MACHVON_PUSH must be one of none, fcm');
    }
    return PushConfig(mode: parsed, apiKey: apiKey.trim(), appId: appId.trim(), senderId: senderId.trim(), projectId: projectId.trim());
  }

  final PushMode mode;
  final String apiKey;
  final String appId;
  final String senderId;
  final String projectId;

  /// The names of the variables that `fcm` needs and the build did not set.
  List<String> get missing => <String>[
        if (apiKey.isEmpty) 'MACHVON_FCM_API_KEY',
        if (appId.isEmpty) 'MACHVON_FCM_APP_ID',
        if (senderId.isEmpty) 'MACHVON_FCM_SENDER_ID',
        if (projectId.isEmpty) 'MACHVON_FCM_PROJECT_ID',
      ];

  /// Whether the device adapter is used: asked for, and complete.
  bool get enabled => mode == PushMode.fcm && missing.isEmpty;
}

/// The configuration of this build; tests override it.
final Provider<PushConfig> pushConfigProvider = Provider<PushConfig>((Ref ref) => PushConfig.fromEnvironment());
