import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../di/providers.dart';
import '../edition/edition.dart';
import '../l10n/app_strings.dart';

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
      child: ExcludeSemantics(child: Image.asset(asset, width: size, height: size, filterQuality: FilterQuality.medium)),
    );
  }
}

/// The logo with the tagline of the edition under it, the head of the sign-in screens.
class BrandHeader extends ConsumerWidget {
  const BrandHeader({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final Edition edition = ref.watch(editionProfileProvider).edition;
    final String tagline = edition == Edition.enterprise ? context.t('mob.signIn.tagline.enterprise.text') : context.t('mob.signIn.tagline.public.text');
    return Row(
      children: <Widget>[
        const BrandLogo(size: 56),
        const SizedBox(width: 12),
        Expanded(child: Text(tagline, style: Theme.of(context).textTheme.titleSmall)),
      ],
    );
  }
}
