import type { EntityType, SensitiveEntity } from "./detect";

/** Sortie de `pipeline("token-classification")` avec `aggregation_strategy: "simple"`. */
export type NerGroup = { entity_group: string; score: number; word: string };

export type TextChunk = { text: string; offset: number };

const LABELS: Record<string, EntityType> = {
  PER: "PERSON",
  ORG: "ORGANIZATION",
  LOC: "LOCATION",
};

export const NER_MIN_SCORE = 0.7;

/**
 * Découpe un texte long en morceaux d'au plus `maxChars` caractères, de
 * préférence sur une fin de phrase : le modèle tronque au-delà de 512 jetons.
 */
export function splitForNer(text: string, maxChars = 1000): TextChunk[] {
  const chunks: TextChunk[] = [];
  let offset = 0;

  while (offset < text.length) {
    let end = Math.min(offset + maxChars, text.length);
    if (end < text.length) {
      const window = text.slice(offset, end);
      const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"), window.lastIndexOf("? "), window.lastIndexOf("! "));
      const space = window.lastIndexOf(" ");
      if (cut > maxChars / 2) end = offset + cut + 1;
      else if (space > maxChars / 2) end = offset + space;
    }
    chunks.push({ text: text.slice(offset, end), offset });
    offset = end;
  }

  return chunks;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Le pipeline ne fournit pas les positions des entités, seulement le mot
 * décodé (dont les espaces peuvent différer du texte : « Jean - Pierre »).
 * On le retrouve dans le texte, dans l'ordre, en ignorant les espaces.
 */
export function locateNerGroups(chunk: TextChunk, groups: readonly NerGroup[]): SensitiveEntity[] {
  const entities: SensitiveEntity[] = [];
  let cursor = 0;

  for (const group of groups) {
    const type = LABELS[group.entity_group];
    const compact = group.word.replace(/\s+/g, "");
    if (!type || group.score < NER_MIN_SCORE || compact.length < 2 || compact.includes("[UNK]")) {
      continue;
    }

    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${[...compact].map(escapeRegExp).join("\\s*")}(?![\\p{L}\\p{N}])`,
      "giu"
    );

    pattern.lastIndex = cursor;
    let match = pattern.exec(chunk.text);
    if (!match) {
      pattern.lastIndex = 0;
      match = pattern.exec(chunk.text);
    }
    if (!match) continue;

    cursor = match.index + match[0].length;
    entities.push({
      type,
      value: match[0],
      start: chunk.offset + match.index,
      end: chunk.offset + cursor,
      source: "ner",
      score: group.score,
    });
  }

  return entities;
}
