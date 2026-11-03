import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import '../../spike/sha256.dart';

void main() {
  group('sha256 (FIPS 180-4 test vectors, computed independently with Node)', () {
    test('empty input, one block, a padding boundary and a multi-block input', () {
      expect(sha256Hex(<int>[]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      expect(sha256Hex(ascii.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect(
        sha256Hex(ascii.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      );
      expect(sha256Hex(ascii.encode('a' * 1000)), '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    });
  });
}
