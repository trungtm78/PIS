import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

/// One sample response for each operation, written by the contract generator from the same openapi.json as the classes under test.
Map<String, Object?> _fixtures() {
  final String text = File('test/fixtures/responses.fixtures.json').readAsStringSync();
  return (jsonDecode(text) as Map<String, Object?>);
}

Object? _copy(Object? value) => jsonDecode(jsonEncode(value));

void main() {
  test('AC-ST-KERNEL-030-2: the generated Dart client reads and writes back 100 percent of the fixture responses', () {
    final Map<String, Object?> fixtures = _fixtures();
    expect(fixtures.length, greaterThan(800));
    expect(fixtures.keys.toSet(), responseDecoders.keys.toSet(), reason: 'every operation that answers with JSON has a decoder and a fixture');
    final List<String> failed = <String>[];
    for (final MapEntry<String, Object?> entry in fixtures.entries) {
      try {
        final Object? decoded = responseDecoders[entry.key]!(_copy(entry.value), entry.key);
        final Object? written = decoded is ResponseModel ? decoded.toJson() : decoded;
        if (jsonEncode(_sorted(written)) != jsonEncode(_sorted(entry.value))) failed.add('${entry.key}: written back differently');
      } on ContractMismatch catch (mismatch) {
        failed.add('${entry.key}: $mismatch');
      }
    }
    expect(failed, isEmpty, reason: '${fixtures.length - failed.length} of ${fixtures.length} operations round-trip');
  });

  test('AC-ST-KERNEL-030-2: a response whose field was renamed fails and the failure names the field', () {
    final Object? commandResult = _copy(_fixtures()['suspendMembership']);
    expect(commandResult, isA<Map<String, Object?>>());
    final Map<String, Object?> renamed = <String, Object?>{...(commandResult! as Map<String, Object?>)};
    renamed['resource_ver'] = renamed.remove('resource_version');
    expect(
      () => responseDecoders['suspendMembership']!(renamed, 'suspendMembership'),
      throwsA(isA<ContractMismatch>().having((ContractMismatch error) => error.path, 'path', endsWith('.resource_version')).having((ContractMismatch error) => error.problem, 'problem', 'is missing')),
    );
  });

  test('AC-ST-KERNEL-030-2: a field of another type is refused with its path, a list reports the index, and a body that is not an object is refused', () {
    final Map<String, Object?> page = (_copy(_fixtures()['listAllocationExtensions'])! as Map<String, Object?>);
    final List<Object?> items = page['items']! as List<Object?>;
    expect(items, isNotEmpty);
    final Map<String, Object?> first = items.first! as Map<String, Object?>;
    final String numeric = first.entries.firstWhere((MapEntry<String, Object?> entry) => entry.value is int).key;
    first[numeric] = 'not a number';
    expect(
      () => responseDecoders['listAllocationExtensions']!(page, 'listAllocationExtensions'),
      throwsA(isA<ContractMismatch>().having((ContractMismatch error) => error.path, 'path', contains('items[0].$numeric')).having((ContractMismatch error) => error.problem, 'problem', 'is not an integer')),
    );
    expect(() => responseDecoders['suspendMembership']!(<Object?>[], 'suspendMembership'), throwsA(isA<ContractMismatch>().having((ContractMismatch error) => error.problem, 'problem', 'is not an object')));
  });

  test('AC-ST-KERNEL-030-2: a closed object refuses a field the contract does not name, and says which', () {
    final Map<String, Object?> page = (_copy(_fixtures()['listAllocationExtensions'])! as Map<String, Object?>);
    page['surprise'] = true;
    expect(
      () => responseDecoders['listAllocationExtensions']!(page, 'listAllocationExtensions'),
      throwsA(isA<ContractMismatch>().having((ContractMismatch error) => error.path, 'path', endsWith('.surprise')).having((ContractMismatch error) => error.problem, 'problem', 'is not in the contract')),
    );
  });

  test('AC-ST-KERNEL-030-2: members the contract does not name are kept, so that writing the response back gives what was read', () {
    final Map<String, Object?> commandResult = <String, Object?>{...(_copy(_fixtures()['suspendMembership'])! as Map<String, Object?>), 'added_later': 7};
    final Object? decoded = responseDecoders['suspendMembership']!(commandResult, 'suspendMembership');
    expect((decoded! as ResponseModel).toJson()['added_later'], 7);
  });
}

/// The same JSON with the members of every object in key order, so that two writings of one object compare equal.
Object? _sorted(Object? value) {
  if (value is Map) {
    final List<String> keys = value.keys.map((Object? key) => key.toString()).toList()..sort();
    return <String, Object?>{for (final String key in keys) key: _sorted(value[key])};
  }
  if (value is List) return value.map(_sorted).toList();
  return value;
}
