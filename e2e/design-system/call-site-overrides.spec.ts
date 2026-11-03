import { expect, test, type Page } from "@playwright/test";
import { buttonVariants } from "../../packages/ui/src/components/ui/button-variants";
import { cn } from "../../packages/ui/src/lib/utils";
import { modes, openGallery, themes } from "./gallery";

// Themes restyle components only through tokens, and their rules sit in
// @layer base, so a call site's own classes always win. Each case gives a gallery
// control the class list the app would render and checks the computed colour.
// The first is the addon store's Details button (bg-white/90 text-black; black is
// Flexoki's #100f0f here). The outline case failed in dark mode before the
// tokens: the variant's dark:bg-input/30 stayed beside the call site's background.
// Class lists as the app builds them: the real variants merged with the call
// site's classes by cn (tailwind-merge).
const button = (variant: "secondary" | "outline", className: string) =>
  cn(buttonVariants({ variant, size: "sm" }), className);

const cases = [
  {
    name: "secondary button with its own background and text (addon store Details)",
    control: (page: Page) => page.getByRole("button", { name: "Open dialog", exact: true }),
    variant: "secondary",
    className: () => button("secondary", "bg-white/90 text-black hover:bg-white"),
    expected: { backgroundColor: "rgba(255, 255, 255, 0.9)", color: "rgb(16, 15, 15)" },
  },
  {
    name: "outline button with its own background",
    control: (page: Page) => page.getByRole("button", { name: "Open dialog", exact: true }),
    variant: "outline",
    className: () => button("outline", "bg-white/90"),
    expected: { backgroundColor: "rgba(255, 255, 255, 0.9)" },
  },
  {
    name: "field with its own border",
    control: (page: Page) => page.getByRole("textbox", { name: "Account name" }),
    // The input's own classes merged with the call site's, as Input does.
    className: (current: string) => cn(current, "border-destructive"),
    expected: { borderTopColor: "var(--destructive)" },
  },
];

for (const theme of themes) {
  for (const mode of modes) {
    test(`a call site's own colours win, ${theme}, ${mode}`, async ({ page }) => {
      await openGallery(page, { mode, theme });
      // Read settled colours, not a transition's midpoint.
      await page.addStyleTag({ content: "*, *::before { transition: none !important; }" });
      for (const { name, control, variant, className, expected } of cases) {
        const element = control(page);
        const current = await element.evaluate((node) => node.className);
        // A plain Button: data-slot="button" and data-variant from its prop.
        await element.evaluate(
          (node, { value, variant }) => {
            node.className = value;
            if (variant) {
              node.setAttribute("data-slot", "button");
              node.setAttribute("data-variant", variant);
            }
          },
          { value: className(current), variant },
        );
        // Both sides as sRGB pixels, so any colour syntax (Tailwind mixes opacity
        // in oklab) compares by what is drawn.
        const [actual, wanted] = await element.evaluate(
          (node, expected) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d", { willReadFrequently: true })!;
            const probe = document.createElement("div");
            document.body.append(probe);
            const pixel = (color: string) => {
              probe.style.color = color;
              context.clearRect(0, 0, 1, 1);
              context.fillStyle = getComputedStyle(probe).color;
              context.fillRect(0, 0, 1, 1);
              return Array.from(context.getImageData(0, 0, 1, 1).data);
            };
            const style = getComputedStyle(node);
            const keys = Object.keys(expected) as (keyof typeof expected)[];
            const result = [
              keys.map((key) => pixel(style[key as keyof CSSStyleDeclaration] as string)),
              keys.map((key) => pixel(expected[key])),
            ];
            probe.remove();
            return result;
          },
          expected as Record<string, string>,
        );
        actual.forEach((channels, index) =>
          channels.forEach((value, channel) =>
            expect(Math.abs(value - wanted[index][channel]), name).toBeLessThanOrEqual(1),
          ),
        );
      }
    });
  }
}
