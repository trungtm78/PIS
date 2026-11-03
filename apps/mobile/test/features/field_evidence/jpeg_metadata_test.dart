import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:machvon_mobile/features/field_evidence/jpeg_metadata.dart';

import 'exif_fixtures.dart';

void main() {
  group('AC-ST-MOB-014-2 UAT-AC367 reading what a photograph says about where and when', () {
    test('finds the position, the time and the orientation in both byte orders', () {
      for (final bool little in <bool>[false, true]) {
        final JpegMetadata found = readJpegMetadata(geotaggedJpeg(orientation: 6, little: little));
        expect(found.hasExif, isTrue, reason: 'little endian $little');
        expect(found.hasGps, isTrue, reason: 'little endian $little');
        expect(found.hasTime, isTrue, reason: 'little endian $little');
        expect(found.orientation, 6);
        expect(found.carriesPlaceOrTime, isTrue);
      }
    });

    test('a block with the time only is not a position, and a block with the orientation only says neither', () {
      final JpegMetadata timeOnly = readJpegMetadata(withBlocks(plainJpeg(), <Uint8List>[exifSegment(takenAt: '2026:11:03 08:15:00')]));
      expect(timeOnly.hasTime, isTrue);
      expect(timeOnly.hasGps, isFalse);
      final JpegMetadata orientationOnly = readJpegMetadata(withBlocks(plainJpeg(), <Uint8List>[exifSegment(orientation: 3)]));
      expect(orientationOnly.hasExif, isTrue);
      expect(orientationOnly.carriesPlaceOrTime, isFalse);
      expect(orientationOnly.orientation, 3);
    });

    test('a plain file, a file that is not a JPEG and a block that lies about its size have no metadata and never throw', () {
      expect(readJpegMetadata(plainJpeg()).hasExif, isFalse);
      expect(readJpegMetadata(Uint8List.fromList(<int>[1, 2, 3])).hasExif, isFalse);
      expect(readJpegMetadata(Uint8List(0)).hasExif, isFalse);
      final Uint8List cut = geotaggedJpeg();
      for (final int length in <int>[10, 24, 40, 60, 90]) {
        expect(() => readJpegMetadata(Uint8List.sublistView(cut, 0, length)), returnsNormally);
      }
      // A directory that points far outside the block reads as nothing found.
      final Uint8List liar = Uint8List.fromList(geotaggedJpeg());
      final int tiff = liar.indexOf(0x4D, 10);
      liar[tiff + 7] = 0xFF;
      expect(() => readJpegMetadata(liar), returnsNormally);
    });
  });

  group('AC-ST-MOB-014-2 UAT-AC367 BR-MOB-06 stripping the place and the time before the upload', () {
    test('removes the position and the time, and every other block that can carry them, and keeps the picture', () {
      final Uint8List original = withBlocks(geotaggedJpeg(), <Uint8List>[
        segment(0xE1, 'http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta/>'.codeUnits),
        segment(0xED, 'Photoshop 3.0\u0000 IPTC'.codeUnits),
        segment(0xE5, 'vendor maker note'.codeUnits),
        segment(0xFE, 'taken at the south gate'.codeUnits),
      ]);
      expect(readJpegMetadata(original).hasGps, isTrue);

      final Uint8List stripped = stripJpegMetadata(original, keepOrientation: false);

      final JpegMetadata after = readJpegMetadata(stripped);
      expect(after.hasExif, isFalse);
      expect(after.carriesPlaceOrTime, isFalse);
      final String text = String.fromCharCodes(stripped);
      for (final String leak in <String>['xmpmeta', 'Photoshop', 'maker note', 'south gate']) {
        expect(text.contains(leak), isFalse, reason: leak);
      }
      expect(stripped.length, lessThan(original.length));
      final img.Image? picture = img.decodeJpg(stripped);
      expect(picture, isNotNull, reason: 'the picture still decodes');
      expect(picture!.width, 16);
      expect(picture.height, 12);
      // The scan is copied byte for byte: no new compression.
      expect(stripped.sublist(stripped.length - 64), original.sublist(original.length - 64));
    });

    test('keeps the orientation alone, so a sideways picture still shows upright, and says nothing of where or when', () {
      final JpegMetadata after = readJpegMetadata(stripJpegMetadata(geotaggedJpeg(orientation: 6)));
      expect(after.hasExif, isTrue);
      expect(after.orientation, 6);
      expect(after.carriesPlaceOrTime, isFalse);
      expect(readJpegMetadata(stripJpegMetadata(geotaggedJpeg(orientation: 1))).hasExif, isFalse, reason: 'upright needs no block');
      expect(img.decodeJpg(stripJpegMetadata(geotaggedJpeg(orientation: 8))), isNotNull);
    });

    test('a file that is not a JPEG that parses is handed back as it came', () {
      final Uint8List other = Uint8List.fromList(<int>[0x89, 0x50, 0x4E, 0x47]);
      expect(identical(stripJpegMetadata(other), other), isTrue);
    });
  });
}
