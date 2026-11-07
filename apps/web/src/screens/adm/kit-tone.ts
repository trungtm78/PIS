import type { Tone } from '../../ui';

/**
 * The tone of the kit's status pill for a class of the prototype's pill (`pill`, `pill green`, `pill warn`, `pill red`, `pill gray`, `pill blue`): the screens keep
 * their own rules for which state is which colour and only draw the result with the kit. The plain pill is the good state.
 */
export function toneOfPill(pillClass: string): Tone {
  const words = pillClass.split(/\s+/);
  if (words.includes('red')) return 'danger';
  if (words.includes('warn')) return 'warning';
  if (words.includes('gray')) return 'neutral';
  if (words.includes('blue')) return 'info';
  return 'success';
}
