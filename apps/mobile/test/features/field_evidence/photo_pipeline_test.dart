import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:machvon_mobile/core/offline/attachments/attachment_policy.dart';
import 'package:machvon_mobile/features/field_evidence/annotation.dart';
import 'package:machvon_mobile/features/field_evidence/jpeg_metadata.dart';
import 'package:machvon_mobile/features/field_evidence/photo_pipeline.dart';
import 'package:machvon_mobile/features/field_evidence/png_metadata.dart';

import 'exif_fixtures.dart';

class _Work {
  _Work() : directory = Directory.systemTemp.createTempSync('machvon-photo-') {
    addTearDown(() => directory.deleteSync(recursive: true));
  }

  final Directory directory;
  int _next = 0;

  Directory get out => Directory('${directory.path}/out');

  File file(String name, List<int> bytes) => File('${directory.path}/$name')..writeAsBytesSync(bytes);

  String id() => 'p${_next++}';

  Future<PreparedPhoto> prepare(File source, {required bool keep, AnnotationSet marks = AnnotationSet.empty, EvidenceLimits limits = const EvidenceLimits()}) =>
      preparePhoto(source: source, directory: out, keepPlaceAndTime: keep, annotations: marks, limits: limits, newId: id);
}

AnnotationSet _redLine() => const AnnotationSet().add(
      const Stroke(color: AnnotationColor.red, width: 0.02, points: <AnnotationPoint>[AnnotationPoint(0.1, 0.5), AnnotationPoint(0.9, 0.5)]),
    );

Matcher _refusedWith(String code) => throwsA(isA<AttachmentRefused>().having((AttachmentRefused e) => e.code, 'code', code));

void main() {
  group('AC-ST-MOB-014-2 UAT-AC367 BR-MOB-06 the place and the time of a photograph leave only with the consent', () {
    test('without the consent the file that is uploaded says neither where nor when, and the picture is not recompressed', () async {
      final _Work work = _Work();
      final Uint8List source = geotaggedJpeg(orientation: 1);
      final PreparedPhoto prepared = await work.prepare(work.file('gate.jpg', source), keep: false);

      final Uint8List sent = File(prepared.path).readAsBytesSync();
      expect(readJpegMetadata(sent).carriesPlaceOrTime, isFalse);
      expect(readJpegMetadata(sent).hasExif, isFalse);
      expect(prepared.sourceHadPlaceOrTime, isTrue, reason: 'the screen can tell the person that the photograph carried a place');
      expect(prepared.keepsPlaceOrTime, isFalse);
      expect(prepared.recompressed, isFalse);
      expect(prepared.annotated, isFalse);
      expect(prepared.mime, 'image/jpeg');
      expect(prepared.bytes, sent.length);
      expect(prepared.originalPath, isNull, reason: 'nothing was changed in the picture, so there is no second copy to keep');
    });

    test('with the consent the file is sent as it was taken, with the place and the time it says', () async {
      final _Work work = _Work();
      final Uint8List source = geotaggedJpeg();
      final PreparedPhoto prepared = await work.prepare(work.file('gate.jpg', source), keep: true);

      expect(File(prepared.path).readAsBytesSync(), source);
      expect(prepared.keepsPlaceOrTime, isTrue);
      expect(prepared.sourceHadPlaceOrTime, isTrue);
    });

    test('a photograph that says nothing of where or when is sent as it is, whatever the consent', () async {
      final _Work work = _Work();
      final Uint8List source = plainJpeg();
      for (final bool keep in <bool>[false, true]) {
        final PreparedPhoto prepared = await work.prepare(work.file('plain$keep.jpg', source), keep: keep);
        expect(File(prepared.path).readAsBytesSync(), source, reason: 'consent $keep');
        expect(prepared.sourceHadPlaceOrTime, isFalse);
        expect(prepared.keepsPlaceOrTime, isFalse);
      }
    });

    test('a PNG loses its text blocks and its time unless the person consented', () async {
      final _Work work = _Work();
      final Uint8List source = pngWithText();
      expect(pngCarriesMetadata(source), isTrue);
      final PreparedPhoto without = await work.prepare(work.file('a.png', source), keep: false);
      expect(pngCarriesMetadata(File(without.path).readAsBytesSync()), isFalse);
      expect(without.mime, 'image/png');
      expect(img.decodePng(File(without.path).readAsBytesSync()), isNotNull);
      final PreparedPhoto kept = await work.prepare(work.file('b.png', source), keep: true);
      expect(File(kept.path).readAsBytesSync(), source);
    });
  });

  group('AC-ST-MOB-014-4 UAT-PLAN-38 an oversize or wrong-type image is compressed or refused with a reason before any upload', () {
    test('a script renamed to .jpg, a PDF and an empty file are refused with FILE_TYPE_NOT_ALLOWED and nothing is written', () async {
      final _Work work = _Work();
      final Map<String, List<int>> refused = <String, List<int>>{
        'run.jpg': <int>[0x4D, 0x5A, 0x90, 0x00, 0x03], // an executable
        'plan.pdf': '%PDF-1.7 plan'.codeUnits,
        'empty.jpg': <int>[],
        'text.jpg': 'GIF89a not a photograph'.codeUnits,
      };
      for (final MapEntry<String, List<int>> entry in refused.entries) {
        await expectLater(work.prepare(work.file(entry.key, entry.value), keep: false), _refusedWith('FILE_TYPE_NOT_ALLOWED'), reason: entry.key);
      }
      expect(work.out.existsSync(), isFalse, reason: 'no file was written for a refused photograph');
    });

    test('a file larger than the server takes is refused with FILE_TOO_LARGE, and a file that is not there with FILE_NOT_FOUND', () async {
      final _Work work = _Work();
      final File huge = File('${work.directory.path}/huge.jpg');
      final RandomAccessFile writer = huge.openSync(mode: FileMode.write)..writeFromSync(<int>[0xFF, 0xD8, 0xFF, 0xE0]);
      writer
        ..setPositionSync(kMaxAttachmentBytes)
        ..writeByteSync(0)
        ..closeSync();
      await expectLater(work.prepare(huge, keep: false), _refusedWith('FILE_TOO_LARGE'));
      await expectLater(work.prepare(File('${work.directory.path}/gone.jpg'), keep: false), _refusedWith('FILE_NOT_FOUND'));
    });

    test('a JPEG over 10 MiB is compressed under the transport size and 2048 px, and the original is kept per the retention policy', () async {
      final _Work work = _Work();
      final Uint8List big = withBlocks(noisyJpeg(width: 3200, height: 2400, quality: 100), <Uint8List>[exifSegment(orientation: 1, takenAt: '2026:11:03 08:15:00', gps: true)]);
      expect(big.length, greaterThan(10 * 1024 * 1024), reason: 'the fixture is the oversize photograph of the plan');

      final PreparedPhoto prepared = await work.prepare(work.file('wall.jpg', big), keep: false);

      expect(prepared.recompressed, isTrue);
      expect(prepared.bytes, lessThanOrEqualTo(1024 * 1024));
      final img.Image? sent = img.decodeJpg(File(prepared.path).readAsBytesSync());
      expect(sent, isNotNull);
      expect(sent!.width <= 2048 && sent.height <= 2048, isTrue);
      expect(readJpegMetadata(File(prepared.path).readAsBytesSync()).carriesPlaceOrTime, isFalse);
      // Retention: the photograph as it was taken is kept, and it does not say where or when either (the person did not consent).
      final Uint8List original = File(prepared.originalPath!).readAsBytesSync();
      expect(original.length, greaterThan(10 * 1024 * 1024));
      expect(readJpegMetadata(original).carriesPlaceOrTime, isFalse);
      expect(img.decodeJpg(original)!.width, 3200);
    }, timeout: const Timeout(Duration(minutes: 4)));

    test('the original is not kept when the retention policy does not ask for it', () async {
      final _Work work = _Work();
      final Uint8List big = noisyJpeg(width: 1600, height: 1200, quality: 100);
      expect(big.length, greaterThan(1024 * 1024));
      final PreparedPhoto prepared = await work.prepare(work.file('wall.jpg', big), keep: false, limits: const EvidenceLimits(retainOriginals: false));
      expect(prepared.recompressed, isTrue);
      expect(prepared.originalPath, isNull);
    });

    test('a large photograph keeps its place and time through the compression only with the consent', () async {
      final _Work work = _Work();
      final Uint8List big = withBlocks(noisyJpeg(width: 1600, height: 1200, quality: 100), <Uint8List>[exifSegment(takenAt: '2026:11:03 08:15:00', gps: true)]);
      final PreparedPhoto kept = await work.prepare(work.file('a.jpg', big), keep: true);
      final JpegMetadata keptMeta = readJpegMetadata(File(kept.path).readAsBytesSync());
      expect(keptMeta.hasGps && keptMeta.hasTime, isTrue);
      expect(kept.keepsPlaceOrTime, isTrue);
      final PreparedPhoto dropped = await work.prepare(work.file('b.jpg', big), keep: false);
      expect(readJpegMetadata(File(dropped.path).readAsBytesSync()).carriesPlaceOrTime, isFalse);
      expect(dropped.keepsPlaceOrTime, isFalse);
    }, timeout: const Timeout(Duration(minutes: 3)));

    test('a PNG over the policy size becomes a JPEG that fits; a PNG within it stays a PNG', () async {
      final _Work work = _Work();
      final Uint8List png = pngWithText(width: 400, height: 300);
      final PreparedPhoto small = await work.prepare(work.file('s.png', png), keep: false);
      expect(small.mime, 'image/png');
      final PreparedPhoto big = await work.prepare(work.file('b.png', png), keep: false, limits: const EvidenceLimits(maxUploadBytes: 100));
      expect(big.mime, 'image/jpeg');
      expect(big.recompressed, isTrue);
      expect(big.path.endsWith('.jpg'), isTrue);
      expect(img.decodeJpg(File(big.path).readAsBytesSync()), isNotNull);
    });

    test('a file that starts like a JPEG but cannot be read is IMAGE_UNREADABLE when the picture has to be redrawn', () async {
      final _Work work = _Work();
      final File damaged = work.file('damaged.jpg', <int>[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x01, 0x02, 0xFF, 0xDA, 0x00]);
      await expectLater(work.prepare(damaged, keep: false, marks: _redLine()), _refusedWith('IMAGE_UNREADABLE'));
    });
  });

  group('AC-ST-MOB-014-2 UAT-AC367 a damaged picture is never made uploadable, also when it needs no new compression', () {
    test('a JPEG and a PNG that are cut short are IMAGE_UNREADABLE with or without the consent, and nothing is written', () async {
      final Uint8List jpeg = geotaggedJpeg();
      final Uint8List png = pngWithText();
      final Map<String, Uint8List> damaged = <String, Uint8List>{
        'jpeg cut in the scan': Uint8List.sublistView(jpeg, 0, jpeg.length - 60),
        'jpeg cut near its start': Uint8List.sublistView(jpeg, 0, jpeg.indexOf(0xDA) + 14),
        'png cut in the data': Uint8List.sublistView(png, 0, 60),
        'png without its end chunk': Uint8List.sublistView(png, 0, png.length - 12),
      };
      for (final MapEntry<String, Uint8List> entry in damaged.entries) {
        for (final bool keep in <bool>[false, true]) {
          final _Work work = _Work();
          final File file = work.file('damaged.bin', entry.value);
          await expectLater(work.prepare(file, keep: keep), _refusedWith('IMAGE_UNREADABLE'), reason: '${entry.key}, keep $keep');
          expect(work.out.existsSync() && work.out.listSync().isNotEmpty, isFalse, reason: '${entry.key}: no file is created');
        }
      }
    });

    test('a PNG that is whole but whose data the decoder throws on (a bad chunk checksum, damaged compressed data) is IMAGE_UNREADABLE, never an unhandled exception, with or without the consent', () async {
      final Uint8List png = pngWithText();
      final int idat = String.fromCharCodes(png).indexOf('IDAT');
      final Uint8List badChecksum = Uint8List.fromList(png);
      final int dataEnd = idat + 4 + ((png[idat - 4] << 24) | (png[idat - 3] << 16) | (png[idat - 2] << 8) | png[idat - 1]);
      badChecksum[dataEnd] ^= 0xFF;
      final Uint8List badData = Uint8List.fromList(png);
      for (int i = idat + 6; i < dataEnd; i += 1) {
        badData[i] ^= 0xA5;
      }
      final Map<String, Uint8List> damaged = <String, Uint8List>{'png with a bad chunk checksum': badChecksum, 'png with damaged compressed data': badData};
      for (final MapEntry<String, Uint8List> entry in damaged.entries) {
        for (final bool keep in <bool>[false, true]) {
          final _Work work = _Work();
          await expectLater(work.prepare(work.file('damaged.png', entry.value), keep: keep), _refusedWith('IMAGE_UNREADABLE'), reason: '${entry.key}, keep $keep');
          expect(work.out.existsSync() && work.out.listSync().isNotEmpty, isFalse, reason: '${entry.key}: no file is created');
        }
      }
    });

    test('a picture that reads is still sent with its own encoded bytes, not a new compression', () async {
      final _Work work = _Work();
      final Uint8List source = plainJpeg();
      final PreparedPhoto prepared = await work.prepare(work.file('ok.jpg', source), keep: true);
      expect(prepared.recompressed, isFalse);
      expect(File(prepared.path).readAsBytesSync(), source);
      final Uint8List png = pngWithText();
      final PreparedPhoto kept = await work.prepare(work.file('ok.png', png), keep: true);
      expect(File(kept.path).readAsBytesSync(), png);
    });
  });

  group('AC-ST-MOB-014-4 UI-MOB-29 the marks of the person are drawn into the picture that is sent', () {
    test('the line lands where it was drawn, in the colour chosen, and the original keeps its pixels', () async {
      final _Work work = _Work();
      final Uint8List source = plainJpeg(width: 200, height: 100);
      final PreparedPhoto prepared = await work.prepare(work.file('wall.jpg', source), keep: false, marks: _redLine());

      expect(prepared.annotated, isTrue);
      final img.Image sent = img.decodeJpg(File(prepared.path).readAsBytesSync())!;
      final img.Pixel on = sent.getPixel(100, 50);
      expect(on.r > 200 && on.g < 90 && on.b < 90, isTrue, reason: 'red on the line, was ${on.r},${on.g},${on.b}');
      final img.Pixel off = sent.getPixel(100, 10);
      expect(off.r < 200 || off.g > 90, isTrue, reason: 'nothing drawn away from the line');
      final img.Image original = img.decodeJpg(File(prepared.originalPath!).readAsBytesSync())!;
      final img.Pixel under = original.getPixel(100, 50);
      expect(under.r > 200 && under.g < 90 && under.b < 90, isFalse, reason: 'the photograph as it was taken has no marks');
    });

    test('the orientation is applied before the marks, so they land on what the person saw, and the file no longer needs it', () async {
      final _Work work = _Work();
      final Uint8List sideways = geotaggedJpeg(orientation: 6);
      final PreparedPhoto prepared = await work.prepare(work.file('s.jpg', sideways), keep: false, marks: _redLine());
      final img.Image sent = img.decodeJpg(File(prepared.path).readAsBytesSync())!;
      expect((sent.width, sent.height), (12, 16), reason: 'the stored 16x12 picture is shown 12x16');
      expect(readJpegMetadata(File(prepared.path).readAsBytesSync()).orientation, isNull);
    });

    test('marks and the caption survive a round trip through the draft, and a mark that cannot be read is left out', () {
      final AnnotationSet set = _redLine().withCaption('Cracked wall at the gate');
      final AnnotationSet back = AnnotationSet.fromJson(set.toJson());
      expect(back.caption, 'Cracked wall at the gate');
      expect(back.strokes.single.toJson(), set.strokes.single.toJson());
      final AnnotationSet damaged = AnnotationSet.fromJson(<String, Object?>{
        'caption': 5,
        'strokes': <Object?>['x', <String, Object?>{'color': 'red', 'width': 0.01, 'points': <Object?>[]}, set.strokes.single.toJson()],
      });
      expect(damaged.strokes, hasLength(1));
      expect(damaged.caption, '');
      expect(AnnotationSet.fromJson('nothing').isEmpty, isTrue);
    });

    test('undo and redo walk the strokes, a new stroke ends the redo, clear keeps the caption, and the caption has a limit', () {
      const Stroke a = Stroke(color: AnnotationColor.red, width: 0.01, points: <AnnotationPoint>[AnnotationPoint(0, 0)]);
      const Stroke b = Stroke(color: AnnotationColor.blue, width: 0.01, points: <AnnotationPoint>[AnnotationPoint(1, 1)]);
      AnnotationSet set = const AnnotationSet().add(a).add(b);
      set = set.undo();
      expect(set.strokes, <Stroke>[a]);
      expect(set.canRedo, isTrue);
      expect(set.redoStroke().strokes, <Stroke>[a, b]);
      expect(set.add(b).canRedo, isFalse);
      expect(const AnnotationSet().undo().isEmpty, isTrue);
      expect(const AnnotationSet().redoStroke().isEmpty, isTrue);
      expect(set.withCaption('x').clear().caption, 'x');
      expect(const AnnotationSet().withCaption('x' * 900).caption.length, AnnotationSet.captionMax);
      expect(AnnotationColor.parse('nothing'), AnnotationColor.red);
    });
  });
}
