import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import 'map_models.dart';
import 'project_models.dart';

/// The name of a stage of the life cycle of a project. Each key is written out so the string check can see it is in use.
String stageLabel(BuildContext context, ProjectStage stage) {
  switch (stage) {
    case ProjectStage.concept:
      return context.t('mob.prj.stage.concept');
    case ProjectStage.appraisal:
      return context.t('mob.prj.stage.appraisal');
    case ProjectStage.pipeline:
      return context.t('mob.prj.stage.pipeline');
    case ProjectStage.budgeted:
      return context.t('mob.prj.stage.budgeted');
    case ProjectStage.implementation:
      return context.t('mob.prj.stage.implementation');
    case ProjectStage.suspended:
      return context.t('mob.prj.stage.suspended');
    case ProjectStage.completed:
      return context.t('mob.prj.stage.completed');
    case ProjectStage.settled:
      return context.t('mob.prj.stage.settled');
    case ProjectStage.closed:
      return context.t('mob.prj.stage.closed');
    case ProjectStage.rejected:
      return context.t('mob.prj.stage.rejected');
    case ProjectStage.cancelled:
      return context.t('mob.prj.stage.cancelled');
  }
}

/// How the position of a project was fixed, in words: a position typed by a person always says so (BR-MOB-06).
String locationLabel(BuildContext context, LocationSource source) {
  switch (source) {
    case LocationSource.area:
      return context.t('mob.prj.map.location.area');
    case LocationSource.device:
      return context.t('mob.prj.map.location.device');
    case LocationSource.manual:
      return context.t('mob.prj.map.location.manual');
  }
}
