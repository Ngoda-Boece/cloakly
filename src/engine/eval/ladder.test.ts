import { describe, expect, it } from "vitest";
import { generateLadder } from "./ladder";

describe("série de questions de difficulté croissante", () => {
  it("compte 25 questions, 5 par niveau, dans l'ordre de difficulté", () => {
    const ladder = generateLadder(1);
    expect(ladder).toHaveLength(25);
    expect(ladder.map((item) => item.level)).toEqual([1, 2, 3, 4, 5].flatMap((level) => Array(5).fill(level)));
    expect(new Set(ladder.map((item) => item.id)).size).toBe(25);
  });

  it("est reproductible pour une graine et change avec la graine", () => {
    expect(generateLadder(3)).toEqual(generateLadder(3));
    expect(generateLadder(3).map((item) => item.text)).not.toEqual(generateLadder(4).map((item) => item.text));
  });

  it("annote uniquement des fragments présents mot pour mot", () => {
    for (let seed = 1; seed <= 30; seed++) {
      for (const item of generateLadder(seed)) {
        for (const fragment of [...item.mask.map((entry) => entry.value), ...item.keep, ...item.intent]) {
          expect(item.text, item.id).toContain(fragment);
        }
      }
    }
  });
});
