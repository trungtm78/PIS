import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/notice_panel.dart';
import '../permissions/permission_providers.dart';
import '../permissions/permission_service.dart';
import 'device_sources.dart';
import 'field_place.dart';
import 'place_format.dart';

/// The position of a record, with the consent that keeps it (BR-MOB-06, NFR-PRIVACY-01). The position of the phone is read only
/// after the person agreed to keep it, the rationale of MOB-06 was shown and the phone allowed it, while the application is in use;
/// a reading that arrives after the consent was taken back is dropped. A phone that refuses, or cannot give a position, leaves the
/// record without one: that is a way, not a failure. The widget holds nothing: it reports the next place through [onChanged], and
/// the screen takes the place and the time out of its photographs when the consent goes (`enforcePhotoConsent`).
///
/// The consent is a switch with its words, the place is one line that always says where it came from, a poor accuracy and a refusal
/// are notices with their words, and the one action is a 48 high button that is locked until the consent is given.
class PlaceConsentField extends ConsumerStatefulWidget {
  const PlaceConsentField({required this.place, required this.onChanged, this.enabled = true, super.key});

  final FieldPlace place;
  final ValueChanged<FieldPlace> onChanged;
  final bool enabled;

  @override
  ConsumerState<PlaceConsentField> createState() => _PlaceConsentFieldState();
}

class _PlaceConsentFieldState extends ConsumerState<PlaceConsentField> {
  bool _locating = false;
  String? _notice;
  int _generation = 0;

  void _consent(bool given) {
    // Taking the consent back cancels a reading that is on its way.
    _generation += 1;
    setState(() => _notice = null);
    widget.onChanged(widget.place.withConsent(given));
  }

  Future<void> _locate() async {
    if (_locating || !widget.place.consent) return;
    final int generation = ++_generation;
    setState(() {
      _locating = true;
      _notice = null;
    });
    try {
      final PermissionOutcome outcome = await requestPermissions(context, ref, <AppPermission>[AppPermission.location]);
      if (!mounted) return;
      if (!outcome.isGranted(AppPermission.location)) {
        setState(() => _notice = 'denied');
        return;
      }
      final DevicePosition? position = await ref.read(positionSourceProvider).current();
      if (!mounted) return;
      if (position == null) {
        setState(() => _notice = 'unavailable');
      } else if (generation == _generation && widget.place.consent) {
        widget.onChanged(widget.place.withDevicePosition(position));
      }
    } finally {
      if (mounted) setState(() => _locating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final FieldPlace place = widget.place;
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(context.t('mob.evd.place.consent'), style: text.bodyStrong),
          subtitle: Text(context.t('mob.evd.place.hint'), style: text.caption.copyWith(color: v2.palette.ink2)),
          value: place.consent,
          onChanged: widget.enabled ? _consent : null,
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
          child: Text(
            place.hasDevicePosition
                ? context.t('mob.evd.place.value', <String, Object>{
                    'lat': coordinateLabel(context, latitudeText(place.position!)),
                    'lng': coordinateLabel(context, longitudeText(place.position!)),
                    'accuracy': metresLabel(context, place.position!.accuracyMetres),
                  })
                : context.t('mob.evd.place.none'),
            style: text.body,
          ),
        ),
        if (place.isLowAccuracy) NoticePanel(tone: NoticeTone.warning, title: context.t('mob.evd.place.low'), margin: const EdgeInsets.only(bottom: MachvonV2Space.s8)),
        OutlinedButton(
          onPressed: widget.enabled && place.consent && !_locating ? _locate : null,
          child: Text(_locating ? context.t('mob.evd.place.locating') : context.t('mob.evd.place.locate')),
        ),
        if (_notice != null)
          NoticePanel(
            title: _notice == 'denied' ? context.t('mob.evd.place.denied') : context.t('mob.evd.place.unavailable'),
            margin: const EdgeInsets.only(top: MachvonV2Space.s8),
          ),
      ],
    );
  }
}
