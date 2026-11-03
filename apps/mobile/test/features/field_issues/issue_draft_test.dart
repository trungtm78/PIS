import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/field_evidence/annotation.dart';
import 'package:machvon_mobile/features/field_evidence/field_place.dart';
import 'package:machvon_mobile/features/field_issues/issue_comments.dart';
import 'package:machvon_mobile/features/field_issues/issue_draft.dart';
import 'package:machvon_mobile/features/field_issues/issue_follow_up.dart';
import 'package:machvon_mobile/features/field_issues/issue_lookups.dart';
import 'package:machvon_mobile/features/permissions/permission_service.dart';

import 'field_world.dart';

const String _label = 'Vị trí nhập tay';

IssueDraft _complete({FieldPlace place = FieldPlace.none, List<IssuePhoto> photos = const <IssuePhoto>[]}) => const IssueDraft(
      clientOperationId: 'a0000000-0000-4000-8000-000000000001',
      projectId: 'p-1',
      ownerUnitId: 'u-1',
      categoryVersionId: 'c-1',
      severity: 'HIGH',
      title: '  Sạt lở taluy km3 ',
      description: ' Đất đá đổ ra mặt đường. ',
    ).copyWith(place: place, photos: photos);

const DevicePosition _position = DevicePosition(latitude: 10.8, longitude: 106.7, accuracyMetres: 12.345);

void main() {
  group('AC-ST-MOB-014-1 UAT-AC355 the place of a report and the consent that keeps it', () {
    test('a position of the phone cannot be held without the consent, and withdrawing the consent drops it', () {
      expect(() => FieldPlace.none.withDevicePosition(_position), throwsStateError);
      final FieldPlace held = FieldPlace.none.withConsent(true).withDevicePosition(_position);
      expect(held.hasDevicePosition, isTrue);
      expect(held.source, PlaceSource.device);
      final FieldPlace withdrawn = held.withConsent(false);
      expect(withdrawn.hasDevicePosition, isFalse);
      expect(withdrawn.hasPlace, isFalse);
      expect(withdrawn.consent, isFalse);
    });

    test('a place typed by hand stays labelled as typed by hand, whatever the consent does', () {
      final FieldPlace typed = FieldPlace.none.withManual(ManualLocation.tryParse('Cổng phía nam')!);
      expect(typed.source, PlaceSource.manual);
      expect(typed.withConsent(true).source, PlaceSource.manual);
      expect(typed.withConsent(true).withConsent(false).manualText, 'Cổng phía nam');
      expect(typed.clearPlace().hasPlace, isFalse);
      final FieldPlace overDevice = FieldPlace.none.withConsent(true).withDevicePosition(_position).withManual(ManualLocation.tryParse('Cổng phía nam')!);
      expect(overDevice.source, PlaceSource.manual);
      expect(overDevice.hasDevicePosition, isFalse, reason: 'a typed place replaces a measured one; the two are never mixed');
    });

    test('an accuracy above 50 metres is a poor position', () {
      FieldPlace at(double accuracy) => FieldPlace.none.withConsent(true).withDevicePosition(DevicePosition(latitude: 1, longitude: 1, accuracyMetres: accuracy));
      expect(at(50).isLowAccuracy, isFalse);
      expect(at(50.5).isLowAccuracy, isTrue);
      expect(FieldPlace.none.isLowAccuracy, isFalse);
    });

    test('the place is stored and read back, and a stored position without the consent is not trusted', () {
      final FieldPlace held = FieldPlace.none.withConsent(true).withDevicePosition(_position);
      final FieldPlace back = FieldPlace.fromJson(held.toJson());
      expect(back.position!.latitude, 10.8);
      expect(back.consent, isTrue);
      final Map<String, Object?> damaged = <String, Object?>{...held.toJson(), 'consent': false};
      expect(FieldPlace.fromJson(damaged).hasDevicePosition, isFalse);
      expect(FieldPlace.fromJson(damaged).consent, isFalse);
      expect(FieldPlace.fromJson(FieldPlace.none.withManual(ManualLocation.tryParse('Cổng phía nam')!).toJson()).manualText, 'Cổng phía nam');
      expect(FieldPlace.fromJson('nothing').source, PlaceSource.none);
      expect(FieldPlace.fromJson(<String, Object?>{'source': 'device', 'consent': true}).source, PlaceSource.none, reason: 'no coordinates');
    });

    test('the coordinates are written the way the server reads them', () {
      expect(latitudeText(_position), '10.800000');
      expect(longitudeText(_position), '106.700000');
      expect(accuracyText(_position), '12.35');
    });
  });

  group('AC-ST-MOB-014-1 AC-ST-MOB-014-3 UAT-AC355 the command that carries a report', () {
    test('without a position the body says geo_consent false and has no coordinates', () {
      final Map<String, Object?> body = issuePayload(_complete(), manualPlaceLabel: _label);
      expect(body['geo_consent'], isFalse);
      expect(body.keys, isNot(containsAll(<String>['geo_lat', 'geo_lng', 'geo_accuracy_m'])));
      expect(body['title'], 'Sạt lở taluy km3');
      expect(body['description'], 'Đất đá đổ ra mặt đường.');
      expect(body['client_operation_id'], 'a0000000-0000-4000-8000-000000000001');
      expect(body['project_id'], 'p-1');
      expect(body['owner_unit_id'], 'u-1');
      expect(body['category_version_id'], 'c-1');
      expect(body['severity'], 'HIGH');
    });

    test('with the consent but no position (permission refused) it still says geo_consent false', () {
      expect(issuePayload(_complete(place: FieldPlace.none.withConsent(true)), manualPlaceLabel: _label)['geo_consent'], isFalse);
    });

    test('a position of the phone travels with the consent, as text in the shape the server reads', () {
      final Map<String, Object?> body = issuePayload(_complete(place: FieldPlace.none.withConsent(true).withDevicePosition(_position)), manualPlaceLabel: _label);
      expect(body['geo_consent'], isTrue);
      expect(body['geo_lat'], '10.800000');
      expect(body['geo_lng'], '106.700000');
      expect(body['geo_accuracy_m'], '12.35');
    });

    test('a place typed by hand goes into the description under its source label, never as coordinates', () {
      final FieldPlace typed = FieldPlace.none.withManual(ManualLocation.tryParse('10.8000, 106.7000')!);
      final Map<String, Object?> body = issuePayload(_complete(place: typed), manualPlaceLabel: _label);
      expect(body['description'], 'Đất đá đổ ra mặt đường.\n\nVị trí nhập tay: 10.8000, 106.7000');
      expect(body['geo_consent'], isFalse);
      expect(body.containsKey('geo_lat'), isFalse, reason: 'coordinates typed by hand would pass for a measurement');
    });

    test('the same draft always gives the same body, so a repeated send is the same command', () {
      expect(issuePayload(_complete(), manualPlaceLabel: _label), issuePayload(_complete(), manualPlaceLabel: _label));
    });
  });

  group('UI-MOB-28 the rules of the form', () {
    test('every required field is named when it is missing, and nothing is named when all is in order', () {
      expect(checkIssue(_complete(), manualPlaceLabel: _label), isEmpty);
      final Map<String, IssueProblem> empty = checkIssue(const IssueDraft(clientOperationId: 'x'), manualPlaceLabel: _label);
      expect(empty.keys, unorderedEquals(<String>['project', 'unit', 'category', 'title', 'description']));
      expect(empty.values.toSet(), <IssueProblem>{IssueProblem.required});
    });

    test('the title is at most 200 characters and the description at most 2000, counted with the place typed by hand', () {
      expect(checkIssue(_complete().copyWith(title: 'x' * 200), manualPlaceLabel: _label), isEmpty);
      expect(checkIssue(_complete().copyWith(title: 'x' * 201), manualPlaceLabel: _label)['title'], IssueProblem.tooLong);
      expect(checkIssue(_complete().copyWith(description: 'x' * 2000), manualPlaceLabel: _label), isEmpty);
      expect(checkIssue(_complete().copyWith(description: 'x' * 2001), manualPlaceLabel: _label)['description'], IssueProblem.tooLong);
      final FieldPlace typed = FieldPlace.none.withManual(ManualLocation.tryParse('Cổng phía nam')!);
      final String words = 'x' * (2000 - '\n\n$_label: Cổng phía nam'.length);
      expect(checkIssue(_complete(place: typed).copyWith(description: words), manualPlaceLabel: _label), isEmpty);
      expect(checkIssue(_complete(place: typed).copyWith(description: '${words}x'), manualPlaceLabel: _label)['description'], IssueProblem.tooLong);
    });

    test('a title of only blanks is no title', () {
      expect(checkIssue(_complete().copyWith(title: '   '), manualPlaceLabel: _label)['title'], IssueProblem.required);
    });

    test('a draft is stored and read back whole, a damaged photograph is left out, and a draft without an identity is not one', () {
      final IssueDraft draft = _complete(
        place: FieldPlace.none.withConsent(true).withDevicePosition(_position),
        photos: <IssuePhoto>[
          const IssuePhoto(id: 'ph-1', path: '/a.jpg', mime: 'image/jpeg', bytes: 10, originalPath: '/o.jpg', sourceHadPlaceOrTime: true, keepsPlaceOrTime: true, uploadId: 'up-1').withAnnotations(
            const AnnotationSet().withCaption('Vết nứt'),
          ),
        ],
      );
      final IssueDraft back = IssueDraft.fromJson(draft.toJson())!;
      expect(back.toJson(), draft.toJson());
      expect(back.photos.single.annotations.caption, 'Vết nứt');
      expect(back.photos.single.uploadId, 'up-1');
      final Map<String, Object?> damaged = <String, Object?>{
        ...draft.toJson(),
        'photos': <Object?>['nothing', draft.photos.single.toJson()],
        'severity': 'ENORMOUS',
      };
      final IssueDraft read = IssueDraft.fromJson(damaged)!;
      expect(read.photos, hasLength(1));
      expect(read.severity, 'MEDIUM');
      expect(IssueDraft.fromJson(<String, Object?>{'title': 'x'}), isNull);
    });
  });

  group('UI-MOB-30 the check before sending', () {
    FieldCheck line(List<FieldCheck> checks, String id) => checks.singleWhere((FieldCheck check) => check.id == id);

    test('a complete report without a photograph or a place may be sent, with two notes', () {
      final List<FieldCheck> checks = fieldChecklist(_complete(), manualPlaceLabel: _label);
      expect(canSend(checks), isTrue);
      expect(line(checks, 'photo').status, CheckStatus.warning);
      expect(line(checks, 'place').status, CheckStatus.warning);
      expect(line(checks, 'chosen').status, CheckStatus.ok);
      expect(line(checks, 'details').status, CheckStatus.ok);
    });

    test('missing details or choices block the send', () {
      expect(canSend(fieldChecklist(_complete().copyWith(title: ''), manualPlaceLabel: _label)), isFalse);
      expect(canSend(fieldChecklist(_complete().copyWith(projectId: ''), manualPlaceLabel: _label)), isFalse);
      expect(line(fieldChecklist(_complete().copyWith(projectId: ''), manualPlaceLabel: _label), 'chosen').status, CheckStatus.missing);
    });

    test('a photograph and a place make their lines done; a poor position stays a note', () {
      const IssuePhoto photo = IssuePhoto(id: 'ph-1', path: '/a.jpg', mime: 'image/jpeg', bytes: 10);
      final List<FieldCheck> good = fieldChecklist(_complete(place: FieldPlace.none.withConsent(true).withDevicePosition(_position), photos: <IssuePhoto>[photo]), manualPlaceLabel: _label);
      expect(line(good, 'photo').status, CheckStatus.ok);
      expect(line(good, 'place').status, CheckStatus.ok);
      final FieldPlace poor = FieldPlace.none.withConsent(true).withDevicePosition(const DevicePosition(latitude: 1, longitude: 1, accuracyMetres: 80));
      expect(line(fieldChecklist(_complete(place: poor), manualPlaceLabel: _label), 'place').status, CheckStatus.warning);
      final FieldPlace typed = FieldPlace.none.withManual(ManualLocation.tryParse('Cổng phía nam')!);
      expect(line(fieldChecklist(_complete(place: typed), manualPlaceLabel: _label), 'place').status, CheckStatus.ok);
    });

    test('a photograph that still says where, without the consent, blocks the send', () {
      const IssuePhoto leaking = IssuePhoto(id: 'ph-1', path: '/a.jpg', mime: 'image/jpeg', bytes: 10, sourceHadPlaceOrTime: true, keepsPlaceOrTime: true);
      final List<FieldCheck> without = fieldChecklist(_complete(photos: <IssuePhoto>[leaking]), manualPlaceLabel: _label);
      expect(line(without, 'metadata').status, CheckStatus.missing);
      expect(canSend(without), isFalse);
      final List<FieldCheck> consenting = fieldChecklist(_complete(place: FieldPlace.none.withConsent(true), photos: <IssuePhoto>[leaking]), manualPlaceLabel: _label);
      expect(canSend(consenting), isTrue);
    });
  });

  group('AC-ST-MOB-014-3 UI-MOB-28 the lists the form offers and the issue it follows', () {
    test('the lookups keep the rows that have what a choice needs and the categories in force only', () {
      final IssueLookups lookups = parseIssueLookups(<String, Object?>{
        'projects': <Object?>[
          <String, Object?>{'id': 'p-1', 'code': 'PRJ-1', 'name': 'Đường A'},
          <String, Object?>{'id': 'p-2', 'code': 'PRJ-2'},
          <String, Object?>{'id': 'p-3'},
          'nothing',
        ],
        'units': <Object?>[<String, Object?>{'id': 'u-1', 'code': 'CDT'}],
        'categories': <Object?>[
          <String, Object?>{'version_id': 'c-1', 'business_key': 'A', 'label': 'Mặt bằng', 'status': 'EFFECTIVE'},
          <String, Object?>{'version_id': 'c-2', 'business_key': 'B', 'status': 'EFFECTIVE'},
          <String, Object?>{'version_id': 'c-3', 'business_key': 'C', 'status': 'RETIRED'},
        ],
      })!;
      expect(lookups.projects.map((Choice c) => c.label), <String>['PRJ-1 · Đường A', 'PRJ-2']);
      expect(lookups.units.single.label, 'CDT');
      expect(lookups.categories.map((Choice c) => c.label), <String>['A · Mặt bằng', 'B']);
      expect(lookups.isEmpty, isFalse);
      expect(parseIssueLookups(<String, Object?>{'projects': <Object?>[], 'units': <Object?>[], 'categories': <Object?>[]})!.isEmpty, isTrue);
      expect(parseIssueLookups(<String, Object?>{'projects': 'x'}), isNull);
      expect(parseIssueLookups('x'), isNull);
    });

    test('an issue without what makes it citable is refused as a whole', () {
      final Map<String, Object?> good = issueView('iss-1');
      expect(parseIssueFollowUp(good)!.code, 'ISS-0001');
      for (final String missing in <String>['id', 'code', 'title', 'status', 'severity', 'opened_at', 'response_due_at', 'due_at', 'version']) {
        expect(parseIssueFollowUp(<String, Object?>{...good}..remove(missing)), isNull, reason: missing);
      }
      expect(parseIssueFollowUp(<String, Object?>{...good, 'status': 'SOMETHING'}), isNull);
      expect(parseIssueFollowUp('x'), isNull);
    });

    test('the timeline keeps the events it knows, and a reader who may not see the notes gets none', () {
      final IssueFollowUp issue = parseIssueFollowUp(issueView('iss-1', events: <Object?>[
        issueEvent('e-1', 'CREATED'),
        <String, Object?>{'id': 'e-2', 'kind': 'SOMETHING_NEW', 'created_at': '2026-11-03T02:00:00Z'},
        issueEvent('e-3', 'COMMENTED', note: 'Đã cử xe'),
      ]))!;
      expect(issue.events.map((IssueEvent e) => e.id), <String>['e-1', 'e-3']);
      expect(issue.events.first.note, isNull);
      expect(issue.acceptsComments, isTrue);
      expect(parseIssueFollowUp(issueView('iss-1', status: 'CLOSED'))!.acceptsComments, isFalse);
    });
  });

  group('UI-MOB-31 the words of a comment', () {
    test('a comment is written and at most 2000 characters', () {
      expect(checkComment('  '), CommentFormProblem.required);
      expect(checkComment('x' * 2000), isNull);
      expect(checkComment('x' * 2001), CommentFormProblem.tooLong);
      expect(checkComment(' Đã báo '), isNull);
    });

    test('a refusal of the server is told in the words of the screen', () {
      expect(commentProblemOf('ISSUE_STATE_INVALID'), CommentProblem.closed);
      expect(commentProblemOf('VALIDATION_FAILED'), CommentProblem.validation);
      expect(commentProblemOf('FIELD_NOT_ALLOWED'), CommentProblem.validation);
      expect(commentProblemOf('SCOPE_DENIED'), CommentProblem.denied);
      expect(commentProblemOf('RESOURCE_NOT_FOUND'), CommentProblem.notFound);
      expect(commentProblemOf('SESSION_EXPIRED'), CommentProblem.sessionEnded);
      expect(commentProblemOf('SOMETHING'), CommentProblem.general);
    });
  });
}
