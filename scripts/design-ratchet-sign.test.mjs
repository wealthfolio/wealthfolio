import assert from "node:assert/strict";
import { test } from "node:test";

import { signColors } from "./design-ratchet-sign.mjs";

test("counts success and destructive picked by a sign", () => {
  assert.equal(
    signColors(`<span className={value >= 0 ? "text-success" : "text-destructive"} />`),
    2,
  );
  assert.equal(signColors(`const fill = isGain ? "fill-success" : "fill-destructive";`), 2);
  assert.equal(signColors(`stroke={total < -0.005 ? "var(--destructive)" : "var(--success)"}`), 2);
  assert.equal(
    signColors(`if (tone === "up") return "text-destructive";\nreturn "text-success";`),
    2,
  );
  // GainPercent's shape: the classes are picked first, the sign test comes later.
  const picked = [
    `const gainColor = invertColor ? "text-destructive" : "text-success";`,
    `const badge = "bg-success-subtle text-success-subtle-foreground";`,
    ...Array(3).fill(""),
    `className={displayValue > 0 ? gainColor : "text-foreground"}`,
  ].join("\n");
  assert.equal(signColors(picked), 4);
});

test("counts the treemap's raw ramps", () => {
  assert.equal(
    signColors(`positiveLow: "heatmap-positive-low", negativeLow: "heatmap-negative-low",`),
    2,
  );
});

test("leaves gain and loss roles and lone statuses alone", () => {
  assert.equal(signColors(`<span className={value >= 0 ? "text-gain" : "text-loss"} />`), 0);
  assert.equal(signColors(`{errors.length > 0 && <p className="text-destructive">{error}</p>}`), 0);
  assert.equal(signColors(`const fill = isGain ? "fill-gain" : "var(--loss)";`), 0);
});

test("leaves status pairs without a sign test alone", () => {
  const markers = [
    `if (variant === "buy") return "success";`,
    `case "success": return "text-success";`,
    `case "destructive": return "text-destructive";`,
  ].join("\n");
  assert.equal(signColors(markers), 0);
  // Far apart: more than six lines between the pair and the sign test.
  const apart = [
    `const ok = count >= 0;`,
    ...Array(7).fill(""),
    `ok ? "text-success" : "text-destructive"`,
  ];
  assert.equal(signColors(apart.join("\n")), 0);
});
