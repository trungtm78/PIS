import 'package:flutter/widgets.dart';

import '../../core/edition/edition.dart';
import 'enterprise_home.dart';
import 'enterprise_home_strings.dart';
import 'enterprise_strings.dart';

/// The enterprise edition on the phone: its title and its terminology overlay. Reaches the application only through `lib/app/edition_seam.dart`.
const EditionProfile kEnterpriseEditionProfile = EditionProfile(
  edition: Edition.enterprise,
  appTitle: kEnterpriseProductNameVi,
  overlay: kEnterpriseStrings,
  homeCards: <WidgetBuilder>[buildPeriodStatusCard, buildHpmStatusCard, buildEbsStatusCard],
  homeStrings: kEnterpriseHomeStrings,
);
