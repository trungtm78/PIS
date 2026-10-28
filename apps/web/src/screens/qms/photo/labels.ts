import type { useTranslation } from '../../../i18n';
import type { DuplicateCheck, ExifCheck, GeofenceCheck, PlaceSource, Problem, Summary, TimeCheck } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function timeLabel(t: Translate, check: TimeCheck): string {
  switch (check) {
    case 'OK':
      return t('qms.photo.time.ok');
    case 'SKEW':
      return t('qms.photo.time.skew');
    case 'MISSING':
      return t('qms.photo.time.missing');
  }
}

export function geofenceLabel(t: Translate, check: GeofenceCheck): string {
  switch (check) {
    case 'INSIDE':
      return t('qms.photo.geofence.inside');
    case 'OUTSIDE':
      return t('qms.photo.geofence.outside');
    case 'LOW_ACCURACY':
      return t('qms.photo.geofence.lowAccuracy');
    case 'MISSING':
      return t('qms.photo.geofence.missing');
  }
}

export function duplicateLabel(t: Translate, check: DuplicateCheck): string {
  switch (check) {
    case 'UNIQUE':
      return t('qms.photo.duplicate.unique');
    case 'DUPLICATE_SAME_SITE':
      return t('qms.photo.duplicate.sameSite');
    case 'DUPLICATE_OTHER_SITE':
      return t('qms.photo.duplicate.otherSite');
  }
}

export function exifLabel(t: Translate, check: ExifCheck): string {
  switch (check) {
    case 'CONSISTENT':
      return t('qms.photo.exif.consistent');
    case 'STRIPPED':
      return t('qms.photo.exif.stripped');
    case 'INCONSISTENT':
      return t('qms.photo.exif.inconsistent');
  }
}

/** The summary is a count of flags to look at, in words that do not say that a photo is true or false. */
export function summaryLabel(t: Translate, summary: Summary): string {
  switch (summary) {
    case 'PASS':
      return t('qms.photo.summary.pass');
    case 'WARN':
      return t('qms.photo.summary.warn');
    case 'FAIL':
      return t('qms.photo.summary.fail');
  }
}

export function sourceLabel(t: Translate, source: PlaceSource): string {
  switch (source) {
    case 'EXIF':
      return t('qms.photo.source.exif');
    case 'DEVICE_AT_CAPTURE':
      return t('qms.photo.source.device');
    case 'MANUAL':
      return t('qms.photo.source.manual');
  }
}

/** What a flag asks the reviewer to look at; a flag the screen does not know is shown by its code. */
export function flagMessage(t: Translate, flag: string): string {
  switch (flag) {
    case 'TIME_SKEW':
      return t('qms.photo.flag.timeSkew');
    case 'TIME_MISSING':
      return t('qms.photo.flag.timeMissing');
    case 'GEOFENCE_OUTSIDE':
      return t('qms.photo.flag.geofenceOutside');
    case 'GEOFENCE_LOW_ACCURACY':
      return t('qms.photo.flag.geofenceLowAccuracy');
    case 'GEOFENCE_MISSING':
      return t('qms.photo.flag.geofenceMissing');
    case 'DUPLICATE_SAME_SITE':
      return t('qms.photo.flag.duplicateSameSite');
    case 'DUPLICATE_OTHER_SITE':
      return t('qms.photo.flag.duplicateOtherSite');
    case 'EXIF_STRIPPED':
      return t('qms.photo.flag.exifStripped');
    case 'EXIF_INCONSISTENT':
      return t('qms.photo.flag.exifInconsistent');
    default:
      return flag;
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'notFound':
      return t('qms.photo.error.notFound');
    case 'denied':
      return t('qms.photo.error.denied');
    case 'session':
      return t('qms.photo.error.session');
    case 'general':
      return t('qms.photo.error.general');
  }
}
