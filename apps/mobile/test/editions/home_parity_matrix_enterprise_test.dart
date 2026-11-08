import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/editions/enterprise/enterprise_profile.dart';
import 'package:machvon_mobile/editions/enterprise/enterprise_strings.dart';

import 'home_parity_matrix.dart';

// This test names the enterprise folder, so its name ends in `enterprise_test.dart`: the edition check lets only such tests, the seam and the folder itself do so.
void main() {
  defineHomeParityMatrix(kEnterpriseEditionProfile);

  test('R20 the terminology overlay of the enterprise edition holds none of the keys of the sections the matrix covers', () {
    final Iterable<String> keys = <String>[...kEnterpriseStrings.vi.keys, ...kEnterpriseStrings.en.keys];
    expect(keys.where(isHomeParityKey), isEmpty);
  });
}
