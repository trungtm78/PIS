import 'package:flutter/widgets.dart';

import '../l10n/string_table.dart';
import 'edition_brand.g.dart';

/// The product edition of this build (ENT-0, R20): the public investment system or the enterprise construction investment software.
/// The same code line builds both; `--dart-define=MACHVON_EDITION=enterprise` selects the second, nothing set means public.
enum Edition { public, enterprise }

/// The edition a `--dart-define=MACHVON_EDITION` value names. Nothing (or blank) is public; any other value than an edition fails at start with a
/// [FormatException] that names the variable and not the value, so a build never runs as an edition nobody chose.
Edition parseEdition(String raw) {
  final String value = raw.trim();
  if (value.isEmpty) return Edition.public;
  for (final Edition edition in Edition.values) {
    if (edition.name == value) return edition;
  }
  throw const FormatException(
    'MACHVON_EDITION must be one of public, enterprise',
  );
}

/// What the phone says as an edition: the title of the application (the task switcher, the system's app list) and the terminology overlay.
///
/// The overlay replaces words of the base strings (the name of the product in the sign-in and welcome texts, ...); it never adds a key (the
/// catalogue checks that), so the base strings stay the reference of both languages. The public edition has no overlay.
final class EditionProfile {
  const EditionProfile({
    required this.edition,
    required this.appTitle,
    this.overlay,
    this.homeHeader,
    this.homeCards = const <WidgetBuilder>[],
    this.homeStrings,
  });

  final Edition edition;

  /// The title of the application, as the web names the product in Vietnamese (the phone has always titled the application in Vietnamese).
  final String appTitle;

  final StringTable? overlay;

  /// The line the edition draws at the top of the home screens: the product and the organisation of the session. The public edition has none.
  final WidgetBuilder? homeHeader;

  /// Cards the edition adds to the home screens (read only), in order. The public edition has none.
  final List<WidgetBuilder> homeCards;

  /// The words of [homeCards]: new keys of the edition, in both languages (the overlay above only replaces base keys).
  final StringTable? homeStrings;
}

/// The public edition: the name the application has always had, and no overlay.
const EditionProfile kPublicEditionProfile = EditionProfile(
  edition: Edition.public,
  appTitle: kPublicProductNameVi,
);
