// Counts success and destructive colours picked by a number's sign, for the design
// ratchet (design-ratchet.mjs); kept apart so its matching can be tested.
// Gains and losses of a price or value use the gain and loss roles (text-gain,
// bg-loss-subtle, fill-gain, var(--loss)), which the Gain and loss colours setting
// swaps for markets where red means up; success and destructive stay for status. A
// success or destructive colour counts when the other one and a sign test (a
// comparison with zero, Math.sign, positive or negative, isGain, isLoss, isUp,
// isDown, "up" or "down") sit within six lines of it. Status pairs with a sign test
// (budgets, goals, spending) count too; they are recorded, and only a new one fails.
// So does every reference to the treemap's --heatmap-positive-* and
// --heatmap-negative-* ramps, which only globals.css reads, behind the swap.
const statusColor =
  /(?<![\w-])(?:(?:text|bg|fill|stroke|border|ring|from|to|via|decoration|outline)-(success|destructive)(?:-subtle(?:-foreground|-border)?)?(?:\/\d+)?(?![\w-])|var\(--(success|destructive)(?:-subtle(?:-foreground|-border)?)?\))/g;
const signTest =
  /[<>]=?\s*-?0(?:\.\d+)?(?![\w.])|(?<![\w.])-?0(?:\.\d+)?\s*[<>]|Math\.sign|positive|negative|\bis(?:Gain|Loss|Up|Down)\b|"(?:up|down)"/i;
const heatmapRamp = /heatmap-(?:positive|negative)-/g;
const reach = 6;

export function signColors(source) {
  const lines = source.split("\n");
  const colors = lines.map((line) => [...line.matchAll(statusColor)].map((m) => m[1] ?? m[2]));
  let count = [...source.matchAll(heatmapRamp)].length;
  lines.forEach((_, index) => {
    const start = Math.max(0, index - reach);
    const end = index + reach + 1;
    const nearby = colors.slice(start, end).flat();
    const signed = signTest.test(lines.slice(start, end).join("\n"));
    for (const color of colors[index]) {
      const other = color === "success" ? "destructive" : "success";
      if (signed && nearby.includes(other)) count += 1;
    }
  });
  return count;
}
