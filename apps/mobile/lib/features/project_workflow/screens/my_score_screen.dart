import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/stat_strip.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/work_row.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../pwf_models.dart';
import '../pwf_score_privacy.dart';

/// MOB-81: "Điểm KPI của tôi", read-only. The score of the person for each period, how it was worked out (task by task, with its weight), what was left
/// out and why, the adjustments that were made and the responses that were given. It is only ever the person's own score (the server answers
/// nothing else to this read), it is never kept on the device, and the screen forgets what it holds when the session, the membership or the
/// rights change (R33). The score is a basis for support; the decision belongs to the person who has the authority to take it (BR-PWF-41).
Widget buildMyScoreScreen(BuildContext context, ScreenContext screen) => const PwfMyScoreScreen();

class PwfMyScoreScreen extends ConsumerWidget {
  const PwfMyScoreScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final String scope = ref.watch(pwfScoreScopeProvider);
    return AppScaffold(
      title: context.t('mob.pwf.score.title'),
      body: DataView<PwfMyScores>(
        key: ValueKey<String>(scope),
        cacheKey: 'pwf.score',
        keepCopy: false,
        read: (MachvonApiClient client) => client.getMyStaffScore(query: const <String, Object?>{'limit': 12}),
        parse: parsePwfMyScores,
        asOf: (PwfMyScores scores) => scores.asOf,
        isEmpty: (PwfMyScores scores) => scores.lines.isEmpty,
        builder: (BuildContext context, Loaded<PwfMyScores> loaded) => PwfScoreView(scores: loaded.value),
      ),
    );
  }
}

class PwfScoreView extends StatefulWidget {
  const PwfScoreView({required this.scores, super.key});

  final PwfMyScores scores;

  @override
  State<PwfScoreView> createState() => _PwfScoreViewState();
}

class _PwfScoreViewState extends State<PwfScoreView> {
  int _selected = 0;

  @override
  Widget build(BuildContext context) {
    final List<PwfScoreLine> lines = widget.scores.lines;
    final PwfScoreLine line = lines[_selected.clamp(0, lines.length - 1)];
    final String language = AppStrings.of(context).language;
    final MachvonV2Text text = context.v2text;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        StatusBanner(text: context.t('mob.pwf.score.support'), icon: Icons.info_outline),
        if (lines.length > 1)
          FilterChips<int>(
            options: <ChipOption<int>>[for (int index = 0; index < lines.length; index += 1) ChipOption<int>(value: index, label: '${formatDayShort(lines[index].periodFrom)} - ${formatDayShort(lines[index].periodTo)}')],
            selected: _selected,
            onChanged: (int next) => setState(() => _selected = next),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, MachvonV2Space.s8),
          child: Text(context.t('mob.pwf.score.period', <String, Object>{'from': formatDay(line.periodFrom, language: language), 'to': formatDay(line.periodTo, language: language), 'status': _periodStatus(context, line.periodStatus)}), style: text.captionStrong),
        ),
        StatStrip(
          cells: <StatCell>[
            StatCell(value: line.shownScore == null ? context.t('mob.pwf.score.none') : formatNumber(line.shownScore.toString(), language), label: context.t('mob.pwf.score.label')),
            StatCell(value: _rating(context, line), label: context.t('mob.pwf.score.rating')),
            StatCell(value: '${line.ratedTaskCount}', label: context.t('mob.pwf.score.tasks')),
          ],
        ),
        if (line.state == 'SMALL_SAMPLE') Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf.score.small', <String, Object>{'count': line.ratedTaskCount}), style: text.body)),
        if (line.state == 'NOT_RATED') Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.pwf.score.notRated'), style: text.body)),
        if (line.scoreAdjusted != null && line.scoreComputed != null) InfoRow(label: context.t('mob.pwf.score.computed'), value: formatNumber(line.scoreComputed.toString(), language)),
        if (line.policyCode != null)
          InfoRow(
            label: context.t('mob.pwf.score.basis'),
            value: line.policyVersion == null ? line.policyCode : context.t('mob.pwf.score.basis.value', <String, Object>{'code': line.policyCode!, 'version': line.policyVersion!}),
          ),
        if (line.contributions.isNotEmpty) ...<Widget>[
          GroupHeader(title: context.t('mob.pwf.score.contributions'), count: line.contributions.length),
          for (int index = 0; index < line.contributions.length; index += 1) _contribution(context, line.contributions[index], index > 0, language),
        ],
        if (line.excluded.isNotEmpty) ...<Widget>[
          GroupHeader(title: context.t('mob.pwf.score.excluded'), count: line.excluded.length),
          for (int index = 0; index < line.excluded.length; index += 1) WorkRow(title: line.excluded[index].taskCode, subtitle: line.excluded[index].reason, leading: const Icon(Icons.remove_circle_outline), dividerAbove: index > 0),
        ],
        if (line.adjustments.isNotEmpty) ...<Widget>[
          GroupHeader(title: context.t('mob.pwf.score.adjustments'), count: line.adjustments.length),
          for (int index = 0; index < line.adjustments.length; index += 1)
            WorkRow(
              title: context.t('mob.pwf.score.adjustment', <String, Object>{'points': formatNumber(line.adjustments[index].points.toString(), language, signed: true)}),
              subtitle: '${line.adjustments[index].reason} · ${_adjustmentStatus(context, line.adjustments[index].status)}',
              leading: const Icon(Icons.tune),
              dividerAbove: index > 0,
            ),
        ],
        if (line.responses.isNotEmpty) ...<Widget>[
          GroupHeader(title: context.t('mob.pwf.score.responses'), count: line.responses.length),
          for (int index = 0; index < line.responses.length; index += 1)
            WorkRow(
              title: line.responses[index].body,
              subtitle: <String>[line.responses[index].status == 'HANDLED' ? context.t('mob.pwf.score.response.handled') : context.t('mob.pwf.score.response.open'), if (line.responses[index].conclusion != null) line.responses[index].conclusion!].join(' · '),
              leading: const Icon(Icons.forum_outlined),
              dividerAbove: index > 0,
            ),
        ],
        if (line.canRespond)
          Padding(
            padding: const EdgeInsets.all(MachvonV2Space.s16),
            child: Text(line.responseUntil == null ? context.t('mob.pwf.score.respond') : context.t('mob.pwf.score.respond.until', <String, Object>{'date': formatDay(line.responseUntil!, language: language)}), style: text.caption),
          ),
      ],
    );
  }

  Widget _contribution(BuildContext context, PwfScoreContribution row, bool divider, String language) => WorkRow(
        title: row.name.isEmpty ? row.taskCode : row.name,
        subtitle: context.t('mob.pwf.score.contribution.line', <String, Object>{'code': row.taskCode, 'weight': formatNumber(row.weight.toString(), language), 'share': formatNumber(row.fraction.toString(), language)}),
        trailing: Text(formatNumber(row.score.toString(), language), style: context.v2text.bodyStrong),
        leading: const Icon(Icons.calculate_outlined),
        semanticLabel: context.t('mob.pwf.score.contribution.spoken', <String, Object>{'name': row.name.isEmpty ? row.taskCode : row.name, 'score': formatNumber(row.score.toString(), language), 'weight': formatNumber(row.weight.toString(), language)}),
        dividerAbove: divider,
      );

  String _rating(BuildContext context, PwfScoreLine line) {
    if (line.state != 'RATED') return context.t('mob.pwf.score.rating.none');
    return line.rating ?? context.t('mob.pwf.score.rating.none');
  }

  String _periodStatus(BuildContext context, String status) => switch (status) {
        'OFFICIAL' => context.t('mob.pwf.score.status.official'),
        'LOCKED' => context.t('mob.pwf.score.status.locked'),
        _ => context.t('mob.pwf.score.status.draft'),
      };

  String _adjustmentStatus(BuildContext context, String status) => switch (status) {
        'APPROVED' => context.t('mob.pwf.score.adjustment.approved'),
        'REJECTED' => context.t('mob.pwf.score.adjustment.rejected'),
        _ => context.t('mob.pwf.score.adjustment.requested'),
      };
}
