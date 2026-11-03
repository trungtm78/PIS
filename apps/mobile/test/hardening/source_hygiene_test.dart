import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/security/device_integrity.dart';
import 'package:machvon_mobile/features/release/telemetry.dart';

import '../features/session/support/world.dart';

List<File> _sources(String directory) =>
    Directory(directory).listSync(recursive: true).whereType<File>().where((File f) => f.path.endsWith('.dart')).toList();

String _name(File file) => file.path.replaceAll(r'\', '/');

/// A call or a reference that writes to a log, the console or an error stream.
final RegExp _logging = RegExp(
  r'(^|[^A-Za-z0-9_.])(print|debugPrint|debugPrintStack|log)\(|dart:developer|developer\.log|\bstdout\b|\bstderr\b|\bLogger\b|\bdebugPrintSynchronously\b|package:logging',
  multiLine: true,
);

/// The lines of a source file that are code: no line comment, no doc comment.
String _code(File file) => file.readAsLinesSync().where((String l) => !l.trimLeft().startsWith('//')).join('\n');

void main() {
  final List<File> lib = _sources('lib');

  group('TK-MOB-041-1 AC-ST-MOB-041-1 MASVS-STORAGE-2 nothing sensitive reaches a log', () {
    test('no source writes to a log, the console or an error stream (a token cannot reach what is never written)', () {
      final List<String> offenders = <String>[for (final File f in lib) if (_logging.hasMatch(_code(f))) _name(f)];
      expect(offenders, isEmpty);
    });

    test('no dependency of the application is a logging, analytics or crash-report package (telemetry is the one port, and it is dropped by shape)', () {
      final String pubspec = File('pubspec.yaml').readAsStringSync();
      for (final String name in <String>['logger:', 'logging:', 'sentry', 'firebase_crashlytics', 'firebase_analytics', 'amplitude', 'mixpanel', 'appsflyer', 'flutter_dotenv']) {
        expect(pubspec, isNot(contains(name)), reason: name);
      }
    });

    test('the telemetry keeps what has a number, a version or a stable code as its shape and drops a token, an address or a name', () {
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final TelemetryService service = TelemetryService(sink: sink, tenantId: () => 'tenant-a');
      expect(
        service.record('app.crash', <String, Object>{
          'error_type': 'Bearer eyJhbGciOiJFUzI1NiJ9.payload.signature',
          'reason_code': 'nguyen.van.a@example.vn',
          'screen_id': 'Nguyễn Văn A',
          'app_version': '1.0.0',
          'token': 'abc',
          'email': 'a@b.c',
        }),
        isTrue,
      );
      expect(sink.events.single.attributes, <String, Object>{'app_version': '1.0.0'});
      expect(service.dropped, 5);
      expect(service.record('user.opened_secret', <String, Object>{}), isFalse, reason: 'an event outside the list is not sent');
      expect(sink.events.single.toJson().keys.toSet(), <String>{'name', 'tenant_id', 'app_version'});
    });

    test('the reason codes of the integrity policy have the shape the telemetry accepts, so a modified phone can be counted without describing it', () {
      final BufferedTelemetrySink sink = BufferedTelemetrySink();
      final TelemetryService service = TelemetryService(sink: sink, tenantId: () => null);
      for (final String reason in <String>[kReasonRooted, kReasonJailbroken, kReasonDebugger, kReasonHooking, kReasonEmulator, kReasonUnknown]) {
        service.record('release.blocked', <String, Object>{'reason_code': reason});
      }
      expect(sink.events.map((TelemetryEvent e) => e.attributes['reason_code']), <String>[
        kReasonRooted,
        kReasonJailbroken,
        kReasonDebugger,
        kReasonHooking,
        kReasonEmulator,
        kReasonUnknown,
      ]);
      expect(sink.events.every((TelemetryEvent e) => e.tenantId == kNoTenant), isTrue);
      expect(service.dropped, 0);
    });
  });

  group('TK-MOB-041-1 AC-ST-MOB-041-1 MASVS-STORAGE-1 the Keychain and the Keystore are the only place a secret is kept', () {
    test('flutter_secure_storage is imported by the two adapters and nothing else, and both keep the item on this device after the first unlock', () {
      final List<String> users = <String>[for (final File f in lib) if (f.readAsStringSync().contains('package:flutter_secure_storage')) _name(f)]..sort();
      expect(users, <String>['lib/core/offline/store/database_key.dart', 'lib/features/session/auth/secure_store.dart']);
      for (final String path in users) {
        expect(File(path).readAsStringSync(), contains('KeychainAccessibility.first_unlock_this_device'), reason: path);
        expect(File(path).readAsStringSync(), isNot(contains('KeychainAccessibility.unlocked')), reason: '$path: no item that follows a backup to another phone');
      }
    });

    test('no other persistence package is a dependency: no shared preferences, no key-value or document store, no second database', () {
      final String pubspec = File('pubspec.yaml').readAsStringSync();
      for (final String name in <String>['shared_preferences', 'hive', 'isar', 'sqflite', 'drift', 'get_storage', 'objectbox', 'realm', 'sembast', 'localstorage', 'cookie_jar']) {
        expect(pubspec, isNot(contains('$name:')), reason: name);
      }
      for (final File f in lib) {
        expect(f.readAsStringSync(), isNot(contains('SharedPreferences')), reason: _name(f));
      }
    });

    test('the sources that write a file are the three that handle a photo or a prepared upload, and none of them touches a token', () {
      final RegExp writes = RegExp(r'writeAsBytes|writeAsString|writeAsBytesSync|writeAsStringSync|openWrite|\.copy\(|\.copySync\(');
      final List<String> writers = <String>[for (final File f in lib) if (writes.hasMatch(_code(f))) _name(f)]..sort();
      expect(writers, <String>[
        'lib/core/offline/attachments/attachment_uploader.dart',
        'lib/features/field_evidence/evidence_photos.dart',
        'lib/features/field_evidence/photo_pipeline.dart',
      ], reason: 'a new file writer needs a review of what it puts in the clear (see finding SEC-03)');
      for (final String path in writers) {
        expect(File(path).readAsStringSync(), isNot(matches(RegExp(r'refreshToken|idToken|accessToken|\bbearer\b', caseSensitive: false))), reason: path);
      }
    });

    test('no secret is written into the sources or the dependency file', () {
      final RegExp secret = RegExp(r'client_secret|clientSecret|-----BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.|\bpassword\s*[:=]\s*[\x27"][^\x27"]+[\x27"]', caseSensitive: false);
      for (final File f in <File>[...lib, File('pubspec.yaml')]) {
        expect(secret.hasMatch(f.readAsStringSync()), isFalse, reason: _name(f));
      }
    });

    test('after a sign-in the Keychain holds the refresh token and the context, and no identity token or tenant token (those stay in memory)', () async {
      final World world = World();
      await world.service().signIn(kOidcConfig);
      expect(world.store.data.keys, contains('session.v1'));
      final String stored = world.store.data.values.join('\n');
      expect(stored, isNot(contains('tenant-token-')), reason: 'the tenant token is kept in memory only');
      expect(RegExp(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.').hasMatch(stored), isFalse, reason: 'no JWT, so no identity token, in the Keychain');
      expect(stored, contains('refresh'), reason: 'the refresh token is there, because that is what the Keychain is for');
    });
  });

  group('TK-MOB-041-1 AC-ST-MOB-041-2 MASVS-NETWORK-1 every connection the application opens is one of three, each https only and without redirects', () {
    test('dart:io HttpClient is created in the transport, the chunk transport and the document fetcher, and nowhere else', () {
      final List<String> sites = <String>[for (final File f in lib) if (RegExp(r'HttpClient\b').hasMatch(_code(f))) _name(f)]..sort();
      expect(sites, <String>[
        'lib/core/api/dart_io_transport.dart',
        'lib/core/offline/attachments/chunk_transport.dart',
        'lib/features/document_signing/document_fetcher.dart',
      ], reason: 'a certificate pinning policy has to be applied to each of these (decision D-SEC-02); a fourth site must be added to the list on purpose');
      for (final String path in sites) {
        expect(File(path).readAsStringSync(), contains('followRedirects = false'), reason: '$path follows no redirect');
      }
    });

    test('no code accepts a certificate the platform rejected, and a certificate callback exists only beside the pinning policy', () {
      for (final File f in lib) {
        final String text = _code(f);
        expect(text, isNot(contains('badCertificateCallback = (')), reason: _name(f));
        if (text.contains('badCertificateCallback')) {
          expect(text, contains('pinning_policy.dart'), reason: '${_name(f)} uses a certificate callback without the policy');
        }
        expect(text, isNot(contains('HttpOverrides')), reason: _name(f));
        expect(text, isNot(contains('allowLegacyUnsafeRenegotiation')), reason: _name(f));
        expect(text, isNot(contains('withTrustedRoots: false')), reason: '${_name(f)}: an own trust store is the pinning change, not a side effect');
      }
    });

    test('the transport that carries the bearer token refuses http and redirects in its own source', () {
      final String transport = File('lib/core/api/dart_io_transport.dart').readAsStringSync();
      expect(transport, contains("call.url.scheme != 'https'"));
      expect(transport, contains('followRedirects = false'));
      expect(transport, contains('maxResponseBytes'));
    });

    test('no screen embeds a web view, which would carry the session into a page of someone else', () {
      expect(File('pubspec.yaml').readAsStringSync(), isNot(contains('webview')));
      for (final File f in lib) {
        expect(f.readAsStringSync(), isNot(contains('WebView')), reason: _name(f));
      }
    });
  });

  group('TK-MOB-041-1 the checks above can be red', () {
    test('the logging rule recognises the calls it forbids', () {
      expect(_logging.hasMatch("  print('x');"), isTrue);
      expect(_logging.hasMatch('  debugPrint(token);'), isTrue);
      expect(_logging.hasMatch('  log(message);'), isTrue);
      expect(_logging.hasMatch('  builder: (c) => AlertDialog('), isFalse);
      expect(_logging.hasMatch('  final blog(x)'), isFalse);
    });
  });
}
