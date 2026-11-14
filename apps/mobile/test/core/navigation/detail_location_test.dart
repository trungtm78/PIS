import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/route_policy.dart';

void main() {
  group('a location that shows one record is a detail screen: the five tabs are hidden there', () {
    test('a record named by the path, or by a record parameter of the query (an incoming letter is /approval/doc-23?doc=<id>)', () {
      expect(isDetailLocation(const <String, String>{'taskId': 't-1'}, const <String, String>{}), isTrue);
      expect(isDetailLocation(const <String, String>{}, const <String, String>{'doc': 'letter-1'}), isTrue);
    });

    test('a list is not one, whatever filters its address carries, and an empty record parameter names nothing', () {
      expect(isDetailLocation(const <String, String>{}, const <String, String>{}), isFalse);
      expect(isDetailLocation(const <String, String>{}, const <String, String>{'tab': 'work', 'status': 'ASSIGNED'}), isFalse);
      expect(isDetailLocation(const <String, String>{}, const <String, String>{'doc': ''}), isFalse);
    });
  });
}
