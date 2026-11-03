import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
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
    _text.removeListener(_emptied);
    _text.dispose();
    super.dispose();
  }

  void _run(String keyword) {
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
    return ScreenFrame(
      title: context.t('mob.srch.title'),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                TextField(
                  controller: _text,
                  textInputAction: TextInputAction.search,
                  autocorrect: false,
                  onSubmitted: _run,
                  decoration: InputDecoration(
                    labelText: context.t('mob.srch.query.label'),
                    helperText: context.t('mob.srch.query.hint'),
                    errorText: switch (_problem) {
                      KeywordProblem.tooShort => context.t('mob.srch.query.tooShort'),
                      KeywordProblem.tooLong => context.t('mob.srch.query.tooLong'),
                      null => null,
                    },
                  ),
                ),
                const SizedBox(height: MachvonSpace.space8),
                FilledButton(onPressed: () => _run(_text.text), child: Text(context.t('mob.srch.submit.action'))),
                const SizedBox(height: MachvonSpace.space8),
                Text(context.t('mob.srch.scope.note'), style: Theme.of(context).textTheme.bodySmall),
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
                    builder: (BuildContext context, Loaded<SearchResults> loaded) => _Results(results: loaded.value, type: _type, onType: (String? type) => setState(() => _type = type)),
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
      return Padding(padding: const EdgeInsets.all(MachvonSpace.space16), child: Text(context.t('mob.srch.pick.notice')));
    }
    return ListView(
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
          child: Semantics(header: true, child: Text(context.t('mob.srch.recent.title'), style: Theme.of(context).textTheme.titleMedium)),
        ),
        for (final String keyword in recent)
          TappableRow(
            semanticLabel: context.t('mob.srch.recent.item.aria', <String, Object>{'keyword': keyword}),
            onTap: () => onPick(keyword),
            child: Row(children: <Widget>[const ExcludeSemantics(child: Icon(Icons.history)), const SizedBox(width: MachvonSpace.space12), Expanded(child: Text(keyword))]),
          ),
        Align(alignment: AlignmentDirectional.centerStart, child: TextButton(onPressed: onClear, child: Text(context.t('mob.srch.recent.clear.action')))),
      ],
    );
  }
}

class _Results extends StatelessWidget {
  const _Results({required this.results, required this.type, required this.onType});

  final SearchResults results;
  final String? type;
  final ValueChanged<String?> onType;

  @override
  Widget build(BuildContext context) {
    final List<String> types = results.types;
    final String? chosen = type != null && types.contains(type) ? type : null;
    final List<SearchHit> shown = results.ofType(chosen);
    return ListView(
      children: <Widget>[
        if (types.length > 1)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
            child: Wrap(
              spacing: MachvonSpace.space8,
              children: <Widget>[
                ChoiceChip(label: Text(context.t('mob.srch.type.all')), selected: chosen == null, onSelected: (_) => onType(null)),
                for (final String kind in types) ChoiceChip(label: Text(typeLabel(context, kind)), selected: chosen == kind, onSelected: (_) => onType(kind)),
              ],
            ),
          ),
        Padding(
          padding: const EdgeInsets.all(MachvonSpace.space16),
          child: Text(context.t('mob.srch.noTotal.note'), style: Theme.of(context).textTheme.bodySmall),
        ),
        for (final SearchHit hit in shown) _HitRow(hit: hit),
        if (results.more) Padding(padding: const EdgeInsets.all(MachvonSpace.space16), child: Text(context.t('mob.srch.more'), style: Theme.of(context).textTheme.bodySmall)),
      ],
    );
  }
}

class _HitRow extends StatelessWidget {
  const _HitRow({required this.hit});

  final SearchHit hit;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ({String screenId, String pathSuffix})? target = openTargetOf(hit);
    final String title = hit.title ?? context.t('mob.srch.hidden.title');
    final String kind = typeLabel(context, hit.entityType);
    final String classification = classificationLabel(context, hit.classification);
    return TappableRow(
      semanticLabel: context.t('mob.srch.hit.aria', <String, Object>{'title': title, 'type': kind, 'classification': classification}),
      onTap: target == null ? null : () => openScreen(context, target.screenId, pathSuffix: target.pathSuffix, stacked: true),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: theme.textTheme.bodyLarge),
                Wrap(spacing: MachvonSpace.space8, children: <Widget>[StatusPill(label: kind), StatusPill(label: classification, warn: hit.classification != Classification.public && hit.classification != Classification.internal)]),
                if (hit.snippet != null) Text(hit.snippet!, style: theme.textTheme.bodySmall),
                if (target == null) Text(context.t('mob.srch.hit.noScreen'), style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          if (target != null) const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}
