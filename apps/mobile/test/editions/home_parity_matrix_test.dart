import 'package:machvon_mobile/core/edition/edition.dart';

import 'home_parity_matrix.dart';

/// The public edition: the profile every build has when `MACHVON_EDITION` is not set.
void main() => defineHomeParityMatrix(kPublicEditionProfile);
