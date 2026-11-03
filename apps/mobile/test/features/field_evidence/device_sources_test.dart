import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/field_evidence/device_sources.dart';

/// A file that exists and cannot be deleted (the system holds it).
class _Stuck implements File {
  int deletes = 0;

  @override
  bool existsSync() => true;

  @override
  Future<FileSystemEntity> delete({bool recursive = false}) async {
    deletes += 1;
    throw const FileSystemException('in use');
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AC-ST-MOB-041-1 UAT-NFR-TENANCY-07 BR-MOB-06 the gallery is opened without asking for the photo library of the person', () {
    const MethodChannel channel = MethodChannel('plugins.flutter.io/image_picker');
    late List<MethodCall> calls;

    setUp(() {
      calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (MethodCall call) async {
        calls.add(call);
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
    });

    test('the picker of the system is asked for the picture alone, never for the full metadata that makes iOS request the library', () async {
      const ImagePickerPhotoSource source = ImagePickerPhotoSource();

      expect(await source.pickPhoto(), isNull);
      expect(await source.takePhoto(), isNull);

      expect(calls.map((MethodCall call) => call.method), everyElement('pickImage'));
      expect(calls, hasLength(2));
      for (final MethodCall call in calls) {
        expect((call.arguments as Map<Object?, Object?>)['requestFullMetadata'], isFalse, reason: 'on iOS true asks for the whole photo library, which the person never agreed to give');
      }
    });
  });

  group('AC-ST-MOB-041-1 UAT-NFR-TENANCY-07 SEC-03 the picker source gives back the copy the plug-in left in the cache', () {
    late Directory cache;

    setUp(() {
      cache = Directory.systemTemp.createTempSync('machvon-picker-');
      addTearDown(() => cache.deleteSync(recursive: true));
    });

    test('discard deletes the file that was picked; discarding it again, or a file that is not there, is not an error', () async {
      const ImagePickerPhotoSource source = ImagePickerPhotoSource();
      final File picked = File('${cache.path}/IMG_0001.jpg')..writeAsBytesSync(<int>[0xFF, 0xD8, 0xFF, 0xE0]);
      final File neighbour = File('${cache.path}/IMG_0002.jpg')..writeAsBytesSync(<int>[0xFF, 0xD8, 0xFF, 0xE0]);

      await source.discard(picked);
      expect(picked.existsSync(), isFalse);
      expect(neighbour.existsSync(), isTrue, reason: 'only the file that was handed back');

      await source.discard(picked);
      await source.discard(File('${cache.path}/never-there.jpg'));
    });

    test('a copy the system will not let go of is left to the system: the screen does not fail because of it', () async {
      final _Stuck stuck = _Stuck();
      await const ImagePickerPhotoSource().discard(stuck);
      expect(stuck.deletes, 1);
    });
  });
}
