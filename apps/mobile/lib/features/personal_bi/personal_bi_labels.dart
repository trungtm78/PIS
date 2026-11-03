import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import 'bi_query_service.dart';
import 'query_models.dart';

/// The dimensions a figure of the disbursement data can be cut by, in the order the screen offers them (the web BI-09).
const List<String> drillDimensions = <String>['unit', 'fund_source', 'project', 'budget_level', 'bucket'];

String badgeLabel(BuildContext context, QualityBadge badge) {
  switch (badge) {
    case QualityBadge.notAssessed:
      return context.t('mob.pbi.badge.notAssessed');
    case QualityBadge.passed:
      return context.t('mob.pbi.badge.passed');
    case QualityBadge.warning:
      return context.t('mob.pbi.badge.warning');
    case QualityBadge.failed:
      return context.t('mob.pbi.badge.failed');
    case QualityBadge.stale:
      return context.t('mob.pbi.badge.stale');
  }
}

/// The name of a dimension; one the application does not know is shown by its code.
String dimensionLabel(BuildContext context, String dimension) {
  switch (dimension) {
    case 'unit':
      return context.t('mob.pbi.dimension.unit');
    case 'fund_source':
      return context.t('mob.pbi.dimension.fundSource');
    case 'project':
      return context.t('mob.pbi.dimension.project');
    case 'budget_level':
      return context.t('mob.pbi.dimension.budgetLevel');
    case 'bucket':
      return context.t('mob.pbi.dimension.bucket');
    default:
      return dimension;
  }
}

/// A figure as it is written in the language of the interface; a figure that is missing says why and is never 0.
String figureLabel(BuildContext context, Figure figure, String unit) => figureText(
      figure,
      unit: unit,
      language: AppStrings.of(context).language,
      noData: context.t('mob.pbi.figure.noData'),
      notApplicable: context.t('mob.pbi.figure.notApplicable'),
      restricted: context.t('mob.pbi.figure.restricted'),
      notYetReported: context.t('mob.pbi.figure.notYetReported'),
    );

String queryProblemText(BuildContext context, QueryProblem problem) {
  switch (problem) {
    case QueryProblem.running:
      return context.t('mob.pbi.refused.running');
    case QueryProblem.changed:
      return context.t('mob.pbi.refused.changed');
    case QueryProblem.timeout:
      return context.t('mob.pbi.refused.timeout');
    case QueryProblem.policy:
      return context.t('mob.pbi.refused.policy');
    case QueryProblem.dimension:
      return context.t('mob.pbi.refused.dimension');
    case QueryProblem.metric:
      return context.t('mob.pbi.refused.metric');
    case QueryProblem.snapshot:
      return context.t('mob.pbi.refused.snapshot');
    case QueryProblem.scope:
      return context.t('mob.pbi.refused.scope');
    case QueryProblem.token:
      return context.t('mob.pbi.refused.token');
    case QueryProblem.expired:
      return context.t('mob.pbi.refused.expired');
    case QueryProblem.invalid:
      return context.t('mob.pbi.refused.invalid');
    case QueryProblem.session:
      return context.t('mob.pbi.refused.session');
    case QueryProblem.general:
      return context.t('mob.pbi.refused.general');
  }
}

String drillCheckText(BuildContext context, DrillCheck check, {required String cell, required String total}) {
  switch (check) {
    case DrillCheck.agrees:
      return context.t('mob.pbi.drill.check.agrees', <String, Object>{'value': cell});
    case DrillCheck.differs:
      return context.t('mob.pbi.drill.check.differs', <String, Object>{'cell': cell, 'total': total});
    case DrillCheck.otherSnapshot:
      return context.t('mob.pbi.drill.check.otherSnapshot');
    case DrillCheck.notComparable:
      return context.t('mob.pbi.drill.check.notComparable');
  }
}
