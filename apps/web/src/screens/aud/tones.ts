import type { RecommendationStatus } from './conclusion/model';
import type { EngagementStatus } from './model';

/** The tone of the pill of a status; the pill always carries the words, the tone is a second cue and never the only one. */
export type AudTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export function engagementTone(status: EngagementStatus): AudTone {
  switch (status) {
    case 'PLANNED':
      return 'neutral';
    case 'ONGOING':
    case 'FOLLOW_UP':
      return 'info';
    case 'AWAITING_CONCLUSION':
      return 'warning';
    case 'CLOSED':
      return 'success';
    case 'CANCELLED':
      return 'neutral';
  }
}

export function recommendationTone(status: RecommendationStatus): AudTone {
  switch (status) {
    case 'OPEN':
    case 'ASSIGNED':
    case 'IN_PROGRESS':
      return 'info';
    case 'PENDING_VERIFICATION':
    case 'DISPUTED':
      return 'warning';
    case 'CLOSED':
      return 'success';
    case 'CANCELLED':
      return 'neutral';
  }
}
