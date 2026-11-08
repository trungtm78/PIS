import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The words said about a screen live in narration.json next to this file; the code only assembles them. */
const WORDS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'narration.json'), 'utf8'));
const TEXT = WORDS.text;
const pattern = ({ source, flags }) => new RegExp(source, flags);
const fill = (template, params) => template.replace(/\{(\w+)\}/gu, (_, key) => String(params[key]));

/** The kind of a screen of the catalogue, said the way a person would say it. */
const KIND_NOUN = WORDS.kindNoun;

// What the shell and the screens repeat everywhere: it says nothing about the screen the person is looking at.
const GENERIC = pattern(WORDS.patterns.generic);
/** A label that belongs to one record of the fixture data or to a test, not to the screen. */
const NOT_OF_THE_SCREEN = pattern(WORDS.patterns.notOfTheScreen);

/** The roles of the catalogue are written for engineers; a person is told them in the words the customer uses. */
const ROLE_WORDS = WORDS.roleWords.map(([source, flags, word]) => [new RegExp(source, flags), word]);
const NOT_A_ROLE = pattern(WORDS.patterns.notARole);
const ROLE_SUFFIX = pattern(WORDS.patterns.roleSuffix);
const AND_SPLIT = new RegExp(`, | ${TEXT.and} `, 'u');

/** The roles of a screen as people say them: no codes, no English, no parentheses, at most three of them. */
export function plainRole(role) {
  let text = String(role ?? '').replace(/\([^)]*\)/gu, ' ');
  for (const [rolePattern, word] of ROLE_WORDS) text = text.replace(rolePattern, word);
  const roles = text
    .split(/\s*[;,/]\s*/u)
    .map((part) => part.replace(ROLE_SUFFIX, '').trim())
    .filter((part) => part !== '' && !NOT_A_ROLE.test(part) && !/[_A-Z]{3,}|[a-z][A-Z]/u.test(part));
  return joinList(unique(roles).slice(0, 3));
}

const RULE_WORDS = WORDS.ruleWords.map(([source, flags, word]) => [new RegExp(source, flags), word]);
// What an engineer wrote and a person cannot say: identifiers, arrows, states in capitals, English that has no word in the customer's language.
const TECHNICAL = /[a-z][A-Z]|[A-Za-z]_[A-Za-z]|\b[A-Z]{3,}\b|[A-Z]{2,}-|→|≠|\bAPI\b|\b(Append-only|Merkle|seal|token|prompt|gateway|lineage|adapter|dataset|command|idempotent|log|rules?|quality|contract|revision|audit|attempt|eval|membership|count|ACL|Keycloak|vault|fingerprint|If-Match)\b/u;

/** The rule of a screen in words a customer reads aloud: clauses that only an engineer can say are left out, the rest is translated. */
export function plainRule(rule) {
  const clauses = String(rule ?? '')
    .split(/\s*;\s*|\.\s+/u)
    .map((clause) => RULE_WORDS.reduce((text, [rulePattern, word]) => text.replace(rulePattern, word), clause).trim())
    .filter((clause) => clause !== '' && !TECHNICAL.test(clause));
  return clauses.map((clause) => sentence(clause.charAt(0).toUpperCase() + clause.slice(1))).join(' ');
}

export const fold = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/\u0111/giu, 'd')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();

/** A list the way it is read aloud: "a, b and c" in the words of the customer. */
export function joinList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} ${TEXT.and} ${items[items.length - 1]}`;
}

const sentence = (text) => {
  const trimmed = String(text).trim().replace(/[.;,\s]+$/u, '');
  return trimmed === '' ? '' : `${trimmed}.`;
};

const unique = (items) => [...new Set(items.map((item) => item.trim()).filter((item) => item !== ''))];

/** The fields the design names that the real screen shows, found by their words (without accents or case); the rest the screen does not show. */
export function matchFields(designFields, labels) {
  const haystack = labels.map(fold);
  const shown = [];
  const absent = [];
  for (const field of designFields) {
    // A field written with a bracketed qualifier is looked for by its name alone
    const name = fold(field.replace(/\(.*?\)/gu, ' '));
    if (name === '') continue;
    (haystack.some((label) => label.includes(name) || (label.length >= 4 && name.includes(label))) ? shown : absent).push(field.replace(/\s*\(.*?\)/gu, '').trim());
  }
  return { shown, absent };
}

/** The words the voice says about one screen: what it is, who uses it, the rule, what is on it now and what can be done. */
export function describeScreen(screen, facts, { withRule = true } = {}) {
  const noun = KIND_NOUN[screen.kind] ?? WORDS.defaultKindNoun;
  const role = plainRole(screen.role);
  const parts = [sentence(`${screen.title}`)];
  if (facts.denied) {
    parts.push(sentence(fill(TEXT.denied, { role: plainRole(screen.role) || TEXT.deniedRoleFallback })));
    return { text: parts.join(' '), shown: [], absent: screen.fields ?? [], actions: [] };
  }
  parts.push(sentence(`${fill(TEXT.isA, { noun })}${role === '' ? '' : fill(TEXT.forRole, { role })}`));
  // The rule is the one of the whole group of screens: it is said once, on the first screen, not on every one.
  if (withRule && screen.rule) parts.push(plainRule(screen.rule));
  const { shown, absent } = matchFields(screen.fields ?? [], facts.labels);
  const named = shown.length >= 2 ? shown : unique(facts.labels.filter((label) => !GENERIC.test(label) && !NOT_OF_THE_SCREEN.test(label) && label.length <= 40)).slice(0, 6);
  if (named.length > 0) parts.push(sentence(fill(TEXT.onScreen, { list: joinList(named.slice(0, 8)) })));
  const actions = unique(facts.buttons.filter((button) => !GENERIC.test(button) && !NOT_OF_THE_SCREEN.test(button) && button.length <= 40)).slice(0, 5);
  if (actions.length > 0) parts.push(sentence(fill(TEXT.mainActions, { list: joinList(actions) })));
  if (facts.rows > 0) parts.push(sentence(fill(TEXT.rows, { count: facts.rows })));
  else if (facts.empty) parts.push(sentence(TEXT.empty));
  return { text: parts.join(' '), shown, absent, actions };
}

/** The flow of a tour: one step for each screen of the group, with the words made from the catalogue and from what the real screen showed. */
export function composeTour(chapter, screens, factsById) {
  const roles = unique(screens.flatMap((screen) => plainRole(screen.role).split(AND_SPLIT)));
  const steps = screens.map((screen, index) => {
    const facts = factsById.get(screen.id) ?? { labels: [], buttons: [], rows: 0, empty: false, denied: false };
    const described = describeScreen(screen, facts, { withRule: index === 0 });
    return {
      id: screen.id.toLowerCase(),
      screens: [screen.id],
      heading: screen.title,
      text: described.text,
      note: described.absent.length > 0 && !facts.denied ? fill(TEXT.designNote, { list: joinList(described.absent) }) : '',
    };
  });
  return {
    id: chapter.id,
    group: chapter.groupTitle ?? chapter.module,
    title: chapter.title,
    audience: joinList(roles.slice(0, 4)) || TEXT.defaultAudience,
    outcome: fill(TEXT.outcome, { group: chapter.group }),
    persona: 'owner',
    generated: true,
    steps,
  };
}
