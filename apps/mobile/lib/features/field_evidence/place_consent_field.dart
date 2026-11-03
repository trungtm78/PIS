import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../permissions/permission_providers.dart';
import '../permissions/permission_service.dart';
import 'device_sources.dart';
import 'field_place.dart';

/// The position of a record, with the consent that keeps it (BR-MOB-06, NFR-PRIVACY-01). The position of the phone is read only
/// after the person agreed to keep it, the rationale of MOB-06 was shown and the phone allowed it, while the application is in use;
/// a reading that arrives after the consent was taken back is dropped. A phone that refuses, or cannot give a position, leaves the
/// record without one: that is a way, not a failure. The widget holds nothing: it reports the next place through [onChanged], and
/// the screen takes the place and the time out of its photographs when the consent goes (`enforcePhotoConsent`).
class PlaceConsentField extends ConsumerStatefulWidget {
  const PlaceConsentField({
    required this.place,
    required this.onChanged,
    this.enabled = true,
    super.key,
  });

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
      final PermissionOutcome outcome = await requestPermissions(
        context,
        ref,
        <AppPermission>[AppPermission.location],
      );
      if (!mounted) return;
      if (!outcome.isGranted(AppPermission.location)) {
        setState(() => _notice = 'denied');
        return;
      }
      final DevicePosition? position = await ref
          .read(positionSourceProvider)
          .current();
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(context.t('mob.evd.place.consent')),
          subtitle: Text(context.t('mob.evd.place.hint')),
          value: place.consent,
          onChanged: widget.enabled ? _consent : null,
        ),
        Text(
          place.hasDevicePosition
              ? context.t('mob.evd.place.value', <String, Object>{
                  'lat': latitudeText(place.position!),
                  'lng': longitudeText(place.position!),
                  'accuracy': place.position!.accuracyMetres.round(),
                })
              : context.t('mob.evd.place.none'),
        ),
        if (place.isLowAccuracy) Text(context.t('mob.evd.place.low')),
        const SizedBox(height: MachvonSpace.space8),
        OutlinedButton(
          onPressed: widget.enabled && place.consent && !_locating
              ? _locate
              : null,
          child: Text(
            _locating
                ? context.t('mob.evd.place.locating')
                : context.t('mob.evd.place.locate'),
          ),
        ),
        if (_notice != null)
          Semantics(
            liveRegion: true,
            child: Text(
              _notice == 'denied'
                  ? context.t('mob.evd.place.denied')
                  : context.t('mob.evd.place.unavailable'),
            ),
          ),
      ],
    );
  }
}
