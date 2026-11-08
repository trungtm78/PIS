import 'package:flutter/material.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/theme/machvon_semantic.dart';
import '../../core/widgets/status_pill.dart';
import 'vendor_models.dart';

/// The word of a tier.
String tierWord(BuildContext context, VendorTier tier) {
  switch (tier) {
    case VendorTier.low:
      return context.t('mob.vnd.tier.low');
    case VendorTier.medium:
      return context.t('mob.vnd.tier.medium');
    case VendorTier.high:
      return context.t('mob.vnd.tier.high');
    case VendorTier.critical:
      return context.t('mob.vnd.tier.critical');
  }
}

/// A tier as an icon and a word on a soft ground; never the colour alone.
class TierPill extends StatelessWidget {
  const TierPill({required this.tier, super.key});

  final VendorTier tier;

  @override
  Widget build(BuildContext context) {
    switch (tier) {
      case VendorTier.low:
        return StatusPill(label: tierWord(context, tier), tone: MachvonTone.success, icon: Icons.check_circle_outline);
      case VendorTier.medium:
        return StatusPill(label: tierWord(context, tier), tone: MachvonTone.info, icon: Icons.info_outline);
      case VendorTier.high:
        return StatusPill(label: tierWord(context, tier), tone: MachvonTone.warning, icon: Icons.warning_amber_rounded);
      case VendorTier.critical:
        return StatusPill(label: tierWord(context, tier), tone: MachvonTone.danger, icon: Icons.report_outlined);
    }
  }
}

/// The word of a factor of the grade; a factor this phone does not know is shown with its code, never hidden.
String factorWord(BuildContext context, String factor) {
  switch (factor) {
    case 'PROFILE_GAP':
      return context.t('mob.vnd.factor.profileGap');
    case 'RESTRICTION':
      return context.t('mob.vnd.factor.restriction');
    case 'REPUTATION_EVENTS':
      return context.t('mob.vnd.factor.reputationEvents');
    case 'QUALIFICATION_LAPSE':
      return context.t('mob.vnd.factor.qualificationLapse');
    case 'PAYEE_ALERT':
      return context.t('mob.vnd.factor.payeeAlert');
    case 'POOR_PERFORMANCE':
      return context.t('mob.vnd.factor.poorPerformance');
    case 'FINANCE_BELOW':
      return context.t('mob.vnd.factor.financeBelow');
    case 'LOAD_OVER':
      return context.t('mob.vnd.factor.loadOver');
    case 'OPEN_FINDINGS':
      return context.t('mob.vnd.factor.openFindings');
    case 'SUBCONTRACT_BREACH':
      return context.t('mob.vnd.factor.subcontractBreach');
    case 'SECURITY_FORFEIT':
      return context.t('mob.vnd.factor.securityForfeit');
    default:
      return factor;
  }
}

/// The name of a reading under a factor.
String readingName(BuildContext context, String key) {
  switch (key) {
    case 'coverage_pct':
      return context.t('mob.vnd.reading.coverage');
    case 'in_force':
      return context.t('mob.vnd.reading.inForce');
    case 'past':
      return context.t('mob.vnd.reading.past');
    case 'posted':
      return context.t('mob.vnd.reading.posted');
    case 'lapsed':
      return context.t('mob.vnd.reading.lapsed');
    case 'alerts':
      return context.t('mob.vnd.reading.alerts');
    case 'consecutive_poor':
      return context.t('mob.vnd.reading.consecutivePoor');
    case 'finance':
      return context.t('mob.vnd.reading.finance');
    case 'load':
      return context.t('mob.vnd.reading.load');
    case 'open_strong':
      return context.t('mob.vnd.reading.openStrong');
    case 'breaches':
      return context.t('mob.vnd.reading.breaches');
    case 'forfeits':
      return context.t('mob.vnd.reading.forfeits');
    default:
      return key;
  }
}

/// The value of a reading: a status is put into words, a number stays as the server wrote it.
String readingValue(BuildContext context, String value) {
  switch (value) {
    case 'MEETS':
      return context.t('mob.vnd.reading.meets');
    case 'BELOW':
      return context.t('mob.vnd.reading.below');
    case 'INSUFFICIENT_DATA':
      return context.t('mob.vnd.reading.insufficient');
    case 'WITHIN':
      return context.t('mob.vnd.reading.within');
    case 'OVER':
      return context.t('mob.vnd.reading.over');
    case 'NO_DATA':
      return context.t('mob.vnd.reading.noData');
    default:
      return value;
  }
}

String stateWord(BuildContext context, String state) {
  switch (state) {
    case 'PROPOSED':
      return context.t('mob.vnd.state.proposed');
    case 'CONFIRMED':
      return context.t('mob.vnd.state.confirmed');
    case 'SUPERSEDED':
      return context.t('mob.vnd.state.superseded');
    case 'REJECTED':
      return context.t('mob.vnd.state.rejected');
    default:
      return state;
  }
}

String ratingWord(BuildContext context, VendorRating rating) {
  switch (rating) {
    case VendorRating.excellent:
      return context.t('mob.vnd.rating.excellent');
    case VendorRating.good:
      return context.t('mob.vnd.rating.good');
    case VendorRating.fair:
      return context.t('mob.vnd.rating.fair');
    case VendorRating.poor:
      return context.t('mob.vnd.rating.poor');
  }
}

/// A rating as an icon and a word.
class RatingPill extends StatelessWidget {
  const RatingPill({required this.rating, super.key});

  final VendorRating rating;

  @override
  Widget build(BuildContext context) {
    switch (rating) {
      case VendorRating.excellent:
      case VendorRating.good:
        return StatusPill(label: ratingWord(context, rating), tone: MachvonTone.success, icon: Icons.check_circle_outline);
      case VendorRating.fair:
        return StatusPill(label: ratingWord(context, rating), tone: MachvonTone.info, icon: Icons.info_outline);
      case VendorRating.poor:
        return StatusPill(label: ratingWord(context, rating), tone: MachvonTone.danger, icon: Icons.report_outlined);
    }
  }
}

/// The clock of the posting of a rating in words; a value this phone does not know is shown as the server sent it.
String publicationClockWord(BuildContext context, String clock) {
  switch (clock) {
    case 'ON_TIME':
      return context.t('mob.vnd.clock.onTime');
    case 'DUE_SOON':
      return context.t('mob.vnd.clock.dueSoon');
    case 'OVERDUE':
      return context.t('mob.vnd.clock.overdue');
    case 'MET':
      return context.t('mob.vnd.clock.met');
    case 'MET_LATE':
      return context.t('mob.vnd.clock.metLate');
    default:
      return clock;
  }
}

/// Whether a posting clock is in trouble (late or about to be): such a line is also marked with a shape.
bool publicationClockLate(String clock) => clock == 'OVERDUE' || clock == 'MET_LATE' || clock == 'DUE_SOON';

String responseReviewWord(BuildContext context, String review) {
  switch (review) {
    case 'NOT_ANSWERED':
      return context.t('mob.vnd.review.notAnswered');
    case 'WITHIN_REVIEW':
      return context.t('mob.vnd.review.withinReview');
    case 'DUE_SOON':
      return context.t('mob.vnd.review.dueSoon');
    case 'OVERDUE':
      return context.t('mob.vnd.review.overdue');
    case 'CLOSED':
      return context.t('mob.vnd.review.closed');
    default:
      return review;
  }
}
