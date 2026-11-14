import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/project_workflow/pwf_home_card.dart';

void main() {
  group('the block "my tasks by deadline" of the home screen', () {
    test('reads the counts of the three colours from the answer of /me/project-tasks', () {
      final PwfHomeCounts? counts = parsePwfHomeCounts(<String, Object?>{
        'items': <Object?>[],
        'counts_by_band': <String, Object?>{'RED': 4, 'YELLOW': 1, 'GREEN': 6, 'NONE': 20, 'UNKNOWN': 0},
      });
      expect(counts, (red: 4, yellow: 1, green: 6));
    });

    test('a colour the answer leaves out counts nothing, and a count that is not a number is not trusted', () {
      expect(parsePwfHomeCounts(<String, Object?>{'counts_by_band': <String, Object?>{'RED': '3'}}), (red: 0, yellow: 0, green: 0));
    });

    test('an answer with no counts (an older server) gives nothing to draw', () {
      expect(parsePwfHomeCounts(<String, Object?>{'items': <Object?>[]}), isNull);
      expect(parsePwfHomeCounts(null), isNull);
      expect(parsePwfHomeCounts(<Object?>[]), isNull);
    });
  });
}
