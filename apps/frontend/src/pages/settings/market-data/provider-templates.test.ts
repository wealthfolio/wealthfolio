import { describe, expect, it } from "vitest";

import { HISTORICAL_TEMPLATES, LATEST_TEMPLATES } from "./provider-templates";

describe("provider templates", () => {
  it("send a JSON request body exactly when they post", () => {
    for (const template of [...LATEST_TEMPLATES, ...HISTORICAL_TEMPLATES]) {
      expect(template.body !== undefined, template.name).toBe(template.method === "POST");
      if (template.body !== undefined) {
        expect(template.format, template.name).toBe("json");
        expect(() => JSON.parse(template.body ?? ""), template.name).not.toThrow();
      }
    }
  });
});
