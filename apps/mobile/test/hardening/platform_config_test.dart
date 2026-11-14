import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/app/app_config.dart';

/// The platform files of the application as text. The tests run from `apps/mobile`.
String _read(String path) => File(path).readAsStringSync();

String get _manifest => _read('android/app/src/main/AndroidManifest.xml');
String get _plist => _read('ios/Runner/Info.plist');

/// The values of an attribute (`android:name="x"`) in [xml].
List<String> _attributes(String xml, String name) =>
    RegExp('$name="([^"]*)"').allMatches(xml).map((RegExpMatch m) => m.group(1)!).toList();

/// The permissions a manifest asks for.
Set<String> _permissions(String xml) => RegExp(r'<uses-permission[^>]*android:name="([^"]*)"').allMatches(xml).map((RegExpMatch m) => m.group(1)!).toSet();

/// The elements `<activity|service|receiver|provider ...>` of the application with the attributes they carry.
List<String> _components(String xml) => RegExp(r'<(activity|service|receiver|provider)\b[^>]*>', dotAll: true).allMatches(xml).map((RegExpMatch m) => m.group(0)!).toList();

/// The body of a `buildSettings` block of the Xcode project for one configuration kind.
List<String> _xcodeConfigurations(String project, String name) {
  final RegExp block = RegExp(r'/\* ' + name + r' \*/ = \{\s*isa = XCBuildConfiguration;(.*?)\n\t\t\};', dotAll: true);
  return block.allMatches(project).map((RegExpMatch m) => m.group(1)!).toList();
}

void main() {
  group('TK-MOB-041-1 AC-ST-MOB-041-2 MASVS-NETWORK-1 no clear-text traffic and no weakening of the trust of the platform', () {
    test('Android: clear text is switched off, the application cannot be backed up, and no network security configuration relaxes either', () {
      expect(_manifest, contains('android:usesCleartextTraffic="false"'));
      expect(_manifest, contains('android:allowBackup="false"'));
      expect(_manifest, contains('android:fullBackupContent="false"'));
      expect(_manifest, isNot(contains('networkSecurityConfig')), reason: 'no file that could trust a user certificate or permit clear text');
      final Directory xml = Directory('android/app/src/main/res/xml');
      if (xml.existsSync()) {
        for (final File file in xml.listSync().whereType<File>()) {
          expect(file.readAsStringSync(), isNot(contains('cleartextTrafficPermitted="true"')), reason: file.path);
        }
      }
      for (final String flavour in <String>['debug', 'profile']) {
        final String path = 'android/app/src/$flavour/AndroidManifest.xml';
        if (File(path).existsSync()) expect(_read(path), isNot(contains('usesCleartextTraffic="true"')), reason: path);
      }
    });

    test('Android: the application can reach the network in a release build (INTERNET is in the main manifest, not only in debug and profile)', () {
      expect(_permissions(_manifest), contains('android.permission.INTERNET'));
      expect(_permissions(_read('android/app/src/debug/AndroidManifest.xml')), contains('android.permission.INTERNET'));
    });

    test('iOS: App Transport Security is left at its default, which is https only', () {
      expect(_plist, isNot(contains('NSAppTransportSecurity')));
      expect(_plist, isNot(contains('NSAllowsArbitraryLoads')));
      expect(_plist, isNot(contains('NSAllowsLocalNetworking')));
      expect(_plist, isNot(contains('NSExceptionDomains')));
    });

    test('the API base URL must be https; plain http is for a loopback host of a debug build and nothing else', () {
      expect(() => AppConfig.parse('http://api.example.vn/v1', allowInsecureLoopback: false), throwsFormatException);
      expect(() => AppConfig.parse('http://api.example.vn/v1', allowInsecureLoopback: true), throwsFormatException, reason: 'a debug build still refuses a remote host');
      expect(() => AppConfig.parse('http://localhost:3000/v1', allowInsecureLoopback: false), throwsFormatException, reason: 'a release build refuses loopback');
      expect(AppConfig.parse('http://10.0.2.2:3000/v1', allowInsecureLoopback: true).allowInsecureLoopback, isTrue);
      expect(AppConfig.parse('https://api.example.vn/v1', allowInsecureLoopback: true).allowInsecureLoopback, isFalse, reason: 'the flag only ever covers loopback');
      expect(() => AppConfig.parse('https://user:secret@api.example.vn/v1', allowInsecureLoopback: false), throwsFormatException);
      expect(() => AppConfig.parse('', allowInsecureLoopback: false), throwsFormatException);
      expect(_read('lib/app/app_config.dart'), contains('allowInsecureLoopback: kDebugMode'), reason: 'only a debug build can ever allow it');
    });
  });

  group('TK-MOB-041-1 MASVS-PLATFORM-1 the surface the platform shows to other applications is the smallest the product needs', () {
    test('Android: the only exported components are the launcher activity and the sign-in redirect activity, each with its own filter', () {
      final List<String> exported = _components(_manifest).where((String c) => c.contains('android:exported="true"')).toList();
      expect(exported, hasLength(2));
      expect(exported.map((String c) => RegExp(r'android:name="([^"]*)"').firstMatch(c)!.group(1)), <String?>['.MainActivity', 'com.linusu.flutter_web_auth_2.CallbackActivity']);
      expect(_components(_manifest).where((String c) => !c.contains('android:exported')), isEmpty, reason: 'every component says whether it is exported');
      expect(_components(_manifest).where((String c) => c.startsWith('<service') || c.startsWith('<receiver') || c.startsWith('<provider')), isEmpty);
    });

    test('Android: the redirect scheme is vn.machvon.app and no other custom scheme or web link is declared', () {
      expect(_attributes(_manifest, 'android:scheme'), <String>['vn.machvon.app', 'https'], reason: 'the second is a <queries> entry (the store page), not an intent filter');
      expect(RegExp(r'<intent-filter[^>]*>.*?</intent-filter>', dotAll: true).allMatches(_manifest).where((RegExpMatch m) => m.group(0)!.contains('android:scheme="https"')), isEmpty);
    });

    test('Android: only the permissions of the features are declared, none that reads storage, contacts, audio or the position in the background', () {
      expect(_permissions(_manifest), <String>{
        'android.permission.INTERNET',
        'android.permission.CAMERA',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.USE_BIOMETRIC',
      });
      for (final String flavour in <String>['debug', 'profile']) {
        expect(_permissions(_read('android/app/src/$flavour/AndroidManifest.xml')), <String>{'android.permission.INTERNET'}, reason: flavour);
      }
    });

    test('Android: the manifest does not make the application debuggable or testable, and the release build is never signed with the debug key', () {
      expect(_manifest, isNot(contains('android:debuggable')));
      expect(_manifest, isNot(contains('android:testOnly')));
      final String gradle = _read('android/app/build.gradle.kts');
      expect(gradle, isNot(contains('isDebuggable = true')));
      expect(gradle, isNot(contains('getByName("debug")')), reason: 'no signing with the debug key');
      expect(gradle, contains('if (keyFile.exists()) signingConfig = signingConfigs.getByName("release")'));
      expect(gradle, contains('key.properties'));
      final String gitignore = File('android/.gitignore').existsSync() ? _read('android/.gitignore') : '';
      expect(gitignore, contains('key.properties'), reason: 'the signing secrets are never committed');
      expect(gitignore, contains('*.jks'));
    });

    test('iOS: nothing shares the files of the application and the position is requested while in use only', () {
      expect(_plist, isNot(contains('UIFileSharingEnabled')));
      expect(_plist, isNot(contains('LSSupportsOpeningDocumentsInPlace')));
      expect(_plist, isNot(contains('UIBackgroundModes')));
      expect(_plist, isNot(contains('NSLocationAlwaysAndWhenInUseUsageDescription')));
      expect(_plist, isNot(contains('NSLocationAlwaysUsageDescription')));
      expect(_plist, contains('NSLocationWhenInUseUsageDescription'));
      expect(_plist, contains('NSCameraUsageDescription'));
      expect(_plist, contains('NSFaceIDUsageDescription'));
      expect(_plist, contains('NSPhotoLibraryUsageDescription'), reason: 'the gallery picker is used: the store policy needs the entry, and an iOS that is ever asked for the library must find the text instead of ending the application');
    });

    test('iOS: no entitlement makes the build debuggable by others, and the release configuration is not the debug one', () {
      for (final File file in Directory('ios').listSync(recursive: true).whereType<File>().where((File f) => f.path.endsWith('.entitlements'))) {
        expect(file.readAsStringSync(), isNot(contains('get-task-allow')), reason: file.path);
      }
      final String project = _read('ios/Runner.xcodeproj/project.pbxproj');
      final List<String> release = _xcodeConfigurations(project, 'Release');
      expect(release, isNotEmpty, reason: 'the Release configurations were found');
      for (final String settings in release) {
        expect(settings, isNot(contains('DEBUG=1')));
        expect(settings, isNot(contains('GCC_OPTIMIZATION_LEVEL = 0')));
        expect(settings, isNot(contains('ENABLE_TESTABILITY = YES')));
        expect(settings, isNot(contains('ONLY_ACTIVE_ARCH = YES')));
      }
      final List<String> debug = _xcodeConfigurations(project, 'Debug');
      expect(debug.any((String s) => s.contains('GCC_OPTIMIZATION_LEVEL = 0')), isTrue, reason: 'the check can tell the two apart');
    });
  });

  group('TK-MOB-041-1 MASVS-RESILIENCE-1 no debug facility is left on in a release build', () {
    test('the sources never turn on a debug overlay or a debug-only switch outside a debug guard', () {
      final List<File> sources = Directory('lib').listSync(recursive: true).whereType<File>().where((File f) => f.path.endsWith('.dart')).toList();
      final RegExp overlays = RegExp(r'debugShowMaterialGrid|showSemanticsDebugger|showPerformanceOverlay|debugPaintSizeEnabled|debugPaintBaselinesEnabled|debugRepaintRainbowEnabled|checkerboardRasterCacheImages|debugShowCheckedModeBanner:\s*true');
      for (final File file in sources) {
        expect(overlays.hasMatch(file.readAsStringSync()), isFalse, reason: file.path);
      }
      final Iterable<String> guarded = sources.where((File f) => RegExp(r'\bk(Debug|Profile)Mode\b').hasMatch(f.readAsStringSync())).map((File f) => f.path.replaceAll(r'\', '/'));
      // Two places behave differently in a debug build, each reviewed: the address of the API (a loopback address is allowed), and the window of a protected
      // screen, which a debug build made with MACHVON_ALLOW_SCREENSHOTS lets be captured for a design review (a release build never does: secure_window_test).
      expect(guarded.toList()..sort(), <String>['lib/app/app_config.dart', 'lib/core/security/secure_window.dart'], reason: 'the places that behave differently in a debug build; a new one needs a review');
    });

    test('the CI builds the release iOS application and a debug Android one, and no workflow signs with a key from the repository', () {
      final String workflow = _read('../../.github/workflows/mobile.yml');
      expect(workflow, contains('flutter build ios --release --no-codesign'));
      expect(workflow, isNot(contains('storePassword')));
      expect(workflow, isNot(contains('.jks')));
      expect(workflow, isNot(contains('flutter build apk --release')), reason: 'the release train signs with its own key outside this workflow');
      expect(workflow, isNot(contains('--dart-define=MACHVON_API_BASE_URL=http:')));
    });
  });
}
