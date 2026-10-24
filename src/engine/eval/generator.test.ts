import { describe, expect, it } from "vitest";
import { luhn } from "../detect";
import { generateCases, TEMPLATE_NAMES } from "./generator";

describe("générateur de cas synthétiques", () => {
  it("redonne le même jeu pour une même graine, un autre pour une autre graine", () => {
    expect(generateCases(7)).toEqual(generateCases(7));
    expect(generateCases(7).map((item) => item.text)).not.toEqual(generateCases(8).map((item) => item.text));
  });

  it("utilise chaque gabarit et produit des identifiants uniques", () => {
    const cases = generateCases(1, TEMPLATE_NAMES.length * 2);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    expect(new Set(cases.map((item) => item.id.split("-").slice(2).join("-")))).toEqual(new Set(TEMPLATE_NAMES));
  });

  it("annote uniquement des fragments présents mot pour mot dans le texte", () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const item of generateCases(seed)) {
        for (const fragment of [...item.mask.map((entry) => entry.value), ...item.keep, ...item.intent]) {
          expect(item.text, item.id).toContain(fragment);
        }
      }
    }
  });

  it("produit des cartes et des IBAN à clé valide", () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const item of generateCases(seed)) {
        if (item.id.endsWith("bank-card")) expect(luhn(item.mask[0].value.replace(/\s/g, ""))).toBe(true);
        if (item.id.endsWith("bank-iban")) {
          const compact = item.mask[0].value.replace(/\s/g, "");
          const numeric = (compact.slice(4) + compact.slice(0, 4)).replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
          expect(BigInt(numeric) % 97n).toBe(1n);
        }
      }
    }
  });
});
