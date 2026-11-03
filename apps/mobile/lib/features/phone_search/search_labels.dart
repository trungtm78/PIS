import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import 'search_models.dart';

/// The name of a kind of record the search knows how to name; any other kind is shown by its own identifier.
String typeLabel(BuildContext context, String type) {
  switch (type) {
    case 'project':
      return context.t('mob.srch.type.project');
    case 'issue':
      return context.t('mob.srch.type.issue');
    case 'conversation':
      return context.t('mob.srch.type.conversation');
    default:
      return type;
  }
}

String classificationLabel(BuildContext context, Classification classification) {
  switch (classification) {
    case Classification.public:
      return context.t('mob.srch.class.public');
    case Classification.internal:
      return context.t('mob.srch.class.internal');
    case Classification.confidential:
      return context.t('mob.srch.class.confidential');
    case Classification.personal:
      return context.t('mob.srch.class.personal');
  }
}
