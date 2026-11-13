import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/glyph_square.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/work_row.dart' show GroupHeader;
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../recent_searches.dart';
import '../search_labels.dart';
import '../search_models.dart';

/// The page size of a search and the most pages the phone reads.
const int searchPageSize = 50;
const int searchMaxPages = 4;

/// How long the field rests before what is typed is searched without a press of the button: a keyword that is acceptable is looked for while
/// the person types, a pause later, and a press of the button or of the search key of the keyboard searches at once.
const Duration searchTypingPause = Duration(milliseconds: 400);

/// MOB-51: search across what the reader may see. The answer is what the server lets this person read: it filters by tenant and by
/// scope before it ranks, so the phone filters nothing and adds nothing, and never shows a total (a number would show how much exists
/// outside the scope). A hit opens the screen of its record, which asks the server again, so a record outside the scope is not found
/// there. The keywords searched for lately are kept in the encrypted store of the person and listed while the field is empty. Results
/// carry titles and extracts, so they are not kept on the device.
Widget buildSearchScreen(BuildContext context, ScreenContext screen) => SearchScreen(initialKeyword: screen.queryParameters['q']);

class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({this.initialKeyword, super.key});

  /// The keyword the address names (`?q=`): a link keeps the search, as on the web. It is searched at once when it is acceptable.
  final String? initialKeyword;

  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> {
  final TextEditingController _text = TextEditingController();
  String? _asked;
  String? _type;
  KeywordProblem? _problem;
  Timer? _pause;

  @override
  void initState() {
    super.initState();
    final String initial = widget.initialKeyword ?? '';
    _text.text = initial;
    if (initial.isNotEmpty && keywordProblem(initial) == null) _asked = initial.trim();
    _text.addListener(_emptied);
  }

  /// An empty field is no search: the results go and the recent keywords come back.
  void _emptied() {
    if (_text.text.trim().isEmpty) _pause?.cancel();
    if (_text.text.trim().isEmpty && (_asked != null || _problem != null)) {
      setState(() {
        _asked = null;
        _problem = null;
        _type = null;
      });
    }
  }

  @override
  void dispose() {
    _pause?.cancel();
    _text.removeListener(_emptied);
    _text.dispose();
    super.dispose();
  }

  /// While typing: an acceptable keyword is searched after a pause. It is not remembered (a half-typed word is not a search the person made);
  /// pressing search or opening a hit remembers it.
  void _typed(String keyword) {
    _pause?.cancel();
    if (keywordProblem(keyword) != null) {
      if (_problem != null) setState(() => _problem = null);
      return;
    }
    _pause = Timer(searchTypingPause, () {
      if (!mounted || _asked == keyword.trim()) return;
      setState(() {
        _problem = null;
        _asked = keyword.trim();
        _type = null;
      });
    });
  }

  void _run(String keyword) {
    _pause?.cancel();
    final KeywordProblem? problem = keywordProblem(keyword);
    setState(() {
      _problem = problem;
      if (problem == null) {
        _asked = keyword.trim();
        _type = null;
      }
    });
    // The history refuses a keyword that is not acceptable, as the search does.
    ref.read(recentSearchesProvider.notifier).remember(keyword);
  }

  void _again(String keyword) {
    _text.text = keyword;
    _run(keyword);
  }

  @override
  Widget build(BuildContext context) {
    final String? asked = _asked;
    final List<String> recent = ref.watch(recentSearchesProvider);
    final MachvonV2Text text = context.v2text;
    final MachvonV2Palette p = context.v2.palette;
    return ScreenFrame(
      title: context.t('mob.srch.title'),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          // The field comes first and takes the focus: the person came here to type.
          Padding(
            padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s4, MachvonV2Space.s16, MachvonV2Space.s8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                TextField(
                  controller: _text,
                  autofocus: widget.initialKeyword == null,
                  textInputAction: TextInputAction.search,
                  autocorrect: false,
                  onSubmitted: _run,
                  onChanged: _typed,
                  decoration: InputDecoration(
                    labelText: context.t('mob.srch.query.label'),
                    helperText: context.t('mob.srch.query.hint'),
                    prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
                    errorText: switch (_problem) {
                      KeywordProblem.tooShort => context.t('mob.srch.query.tooShort'),
                      KeywordProblem.tooLong => context.t('mob.srch.query.tooLong'),
                      null => null,
                    },
                  ),
                ),
                const SizedBox(height: MachvonV2Space.s8),
                FilledButton(onPressed: () => _run(_text.text), child: Text(context.t('mob.srch.submit.action'))),
                const SizedBox(height: MachvonV2Space.s8),
                Text(context.t('mob.srch.scope.note'), style: text.caption.copyWith(color: p.ink2)),
              ],
            ),
          ),
          Expanded(
            child: asked == null
                ? _Recent(recent: recent, onPick: _again, onClear: () => ref.read(recentSearchesProvider.notifier).clear())
                : DataView<SearchResults>(
                    cacheKey: 'search.$asked',
                    keepCopy: false,
                    read: (MachvonApiClient client) => readMerged(client, 'searchGlobal', query: <String, Object?>{'q': asked, 'limit': searchPageSize}, maxPages: searchMaxPages),
                    parse: parseSearchResults,
                    isEmpty: (SearchResults results) => results.hits.isEmpty,
                    activeFilters: <String>[asked],
                    builder: (BuildContext context, Loaded<SearchResults> loaded) => _Results(
                      results: loaded.value,
                      type: _type,
                      onType: (String? type) => setState(() => _type = type),
                      onOpened: () => ref.read(recentSearchesProvider.notifier).remember(asked),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

/// The keywords searched for lately, or the invitation to type one.
class _Recent extends StatelessWidget {
  const _Recent({required this.recent, required this.onPick, required this.onClear});

  final List<String> recent;
  final ValueChanged<String> onPick;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    if (recent.isEmpty) {
      return StateView(kind: StateKind.empty, icon: Icons.search, title: context.t('mob.srch.title'), body: context.t('mob.srch.pick.notice'));
    }
    return ListView(
      children: <Widget>[
        GroupHeader(title: context.t('mob.srch.recent.title'), count: recent.length),
        for (final String keyword in recent)
          TappableRow(
            semanticLabel: context.t('mob.srch.recent.item.aria', <String, Object>{'keyword': keyword}),
            onTap: () => onPick(keyword),
            child: Row(children: <Widget>[const GlyphSquare(icon: Icons.history, tone: GlyphTone.neutral), const SizedBox(width: MachvonV2Space.s12), Expanded(child: Text(keyword, style: context.v2text.body))]),
          ),
        Align(alignment: AlignmentDirectional.centerStart, child: TextButton(onPressed: onClear, child: Text(context.t('mob.srch.recent.clear.action')))),
      ],
    );
  }
}

class _Results extends StatelessWidget {
  const _Results({required this.results, required this.type, required this.onType, required this.onOpened});

  final SearchResults results;
  final String? type;
  final ValueChanged<String?> onType;

  /// A hit was opened: the keyword is a search the person made, so it is remembered.
  final VoidCallback onOpened;

  @override
  Widget build(BuildContext context) {
    final List<String> types = results.types;
    final String? chosen = type != null && types.contains(type) ? type : null;
    final List<SearchHit> shown = results.ofType(chosen);
    return ListView(
      children: <Widget>[
        if (types.length > 1)
          FilterChips<String?>(
            options: <ChipOption<String?>>[
              ChipOption<String?>(value: null, label: context.t('mob.srch.type.all')),
              for (final String kind in types) ChipOption<String?>(value: kind, label: typeLabel(context, kind)),
            ],
            selected: chosen,
            onChanged: onType,
          ),
        Padding(
          padding: const EdgeInsets.all(MachvonV2Space.s16),
          child: Text(context.t('mob.srch.noTotal.note'), style: context.v2text.caption),
        ),
        for (final SearchHit hit in shown) _HitRow(hit: hit, onOpened: onOpened),
        if (results.more) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.srch.more'), style: context.v2text.caption)),
      ],
    );
  }
}

/// The glyph that stands for a kind of record at the start of a hit.
IconData _kindIcon(String entityType) => switch (entityType) {
      'project' => Icons.account_tree_outlined,
      'conversation' => Icons.forum_outlined,
      'issue' => Icons.report_problem_outlined,
      _ => Icons.description_outlined,
    };

class _HitRow extends StatelessWidget {
  const _HitRow({required this.hit, required this.onOpened});

  final SearchHit hit;
  final VoidCallback onOpened;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final ({String screenId, String pathSuffix})? target = openTargetOf(hit);
    final String title = hit.title ?? context.t('mob.srch.hidden.title');
    final String kind = typeLabel(context, hit.entityType);
    final String classification = classificationLabel(context, hit.classification);
    return TappableRow(
      semanticLabel: context.t('mob.srch.hit.aria', <String, Object>{'title': title, 'type': kind, 'classification': classification}),
      onTap: target == null
          ? null
          : () {
              onOpened();
              openScreen(context, target.screenId, pathSuffix: target.pathSuffix, stacked: true);
            },
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          GlyphSquare(icon: _kindIcon(hit.entityType), tone: target == null ? GlyphTone.neutral : GlyphTone.primary),
          const SizedBox(width: MachvonV2Space.s12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: text.bodyStrong),
                if (hit.snippet != null) Text(hit.snippet!, style: text.caption, maxLines: 2, overflow: TextOverflow.ellipsis),
                Padding(
                  padding: const EdgeInsets.only(top: MachvonV2Space.s4),
                  child: Wrap(
                    spacing: MachvonV2Space.s8,
                    runSpacing: MachvonV2Space.s4,
                    children: <Widget>[
                      StatusPill(label: kind),
                      StatusPill(label: classification, warn: hit.classification != Classification.public && hit.classification != Classification.internal),
                    ],
                  ),
                ),
                if (target == null) Text(context.t('mob.srch.hit.noScreen'), style: text.caption),
              ],
            ),
          ),
          if (target != null) const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}
