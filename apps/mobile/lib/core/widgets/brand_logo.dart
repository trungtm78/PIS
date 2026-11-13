import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../di/providers.dart';
import '../edition/edition.dart';
import '../l10n/app_strings.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';

/// The logo of the product in the colours of the edition: the rounded-square app icon (the same master mark as the launcher icon and the web).
/// The image files are written by `tool/generate_launcher_icons.mjs`.
class BrandLogo extends ConsumerWidget {
  const BrandLogo({this.size = 64, super.key});

  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final Edition edition = ref.watch(editionProfileProvider).edition;
    final String asset = edition == Edition.enterprise ? 'assets/brand/logo-enterprise.png' : 'assets/brand/logo-public.png';
    return Semantics(
      image: true,
      label: context.t('mob.signIn.logo.label'),
      child: ExcludeSemantics(
        child: Image.asset(asset, width: size, height: size, filterQuality: FilterQuality.medium),
      ),
    );
  }
}

/// The logo with the tagline of the edition under it, the head of the sign-in screens.
class BrandHeader extends ConsumerWidget {
  const BrandHeader({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bool enterprise = ref.watch(editionProfileProvider).edition == Edition.enterprise;
    final String tagline = enterprise ? context.t('mob.signIn.tagline.enterprise.text') : context.t('mob.signIn.tagline.public.text');
    final MachvonV2Text text = context.v2text;
    final MachvonV2Palette p = context.v2.palette;
    // The logo gives way to the text: at a large text size it shrinks (to a floor) so the head does not push the controls off the screen.
    final double textScale = MediaQuery.textScalerOf(context).scale(1);
    final double logoSize = (56 / (textScale < 1 ? 1 : textScale)).clamp(32.0, 56.0);
    return Row(
      children: <Widget>[
        BrandLogo(size: logoSize),
        const SizedBox(width: MachvonV2Space.s12),
        Expanded(
          child: enterprise
              // The enterprise edition names the product (its launcher name) and says what it is, then the tagline: the logo alone does not name it.
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(context.t('mob.ent.brand.name'), style: text.title.copyWith(color: p.primaryStrong)),
                    Text(context.t('mob.ent.brand.product'), style: text.label),
                    Text(tagline, style: text.caption),
                  ],
                )
              : Text(tagline, style: text.heading),
        ),
      ],
    );
  }
}
