import { FormControl, FormItem, FormLabel } from "@wealthfolio/ui/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@wealthfolio/ui/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface ChartPaletteSelectorProps {
  value?: string;
  onChange: (value: string) => void;
  className?: string;
}

const SAGE_SWATCH_COLORS = ["#355c4c", "#7e9f8c", "#cbba8c", "#c08a5f", "#9a7e92"];
const AMBER_SWATCH_COLORS = [
  "hsl(25 92% 72%)",
  "hsl(24 81% 61%)",
  "hsl(23 70% 51%)",
  "hsl(23 73% 46%)",
  "hsl(22 80% 41%)",
];
const NEWSPAPER_SWATCH_COLORS = [
  "hsl(51 21% 88%)",
  "hsl(50 14% 83%)",
  "hsl(55 10% 79%)",
  "hsl(47 4% 61%)",
  "hsl(40 3% 20%)",
];
const CYBERPUNK_SWATCH_COLORS = ["#1c6c66", "#205ea6", "#735eb5", "#b74583", "#3aa99f"];

function PaletteSwatch({ colors }: { colors: string[] }) {
  return (
    <div className="flex items-center gap-1">
      {colors.map((color, index) => (
        <div
          key={index}
          className="h-5 w-5 rounded-full sm:h-6 sm:w-6"
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}

export function ChartPaletteSelector({ value, onChange, className }: ChartPaletteSelectorProps) {
  const { t } = useTranslation();
  return (
    <RadioGroup
      onValueChange={onChange}
      value={value}
      className={cn("grid grid-cols-4 gap-2 md:gap-4", className)}
    >
      <FormItem>
        <FormLabel className="[&:has([data-state=checked])>div]:border-primary cursor-pointer">
          <FormControl>
            <RadioGroupItem value="sage" className="sr-only" />
          </FormControl>
          <div className="border-muted hover:border-accent flex items-center justify-center rounded-md border-2 p-4">
            <PaletteSwatch colors={SAGE_SWATCH_COLORS} />
          </div>
          <span className="block w-full p-1 text-center text-xs font-normal sm:p-1.5 sm:text-sm">
            {t("common:component.chart_palette_sage_label")}
          </span>
        </FormLabel>
      </FormItem>
      <FormItem>
        <FormLabel className="[&:has([data-state=checked])>div]:border-primary cursor-pointer">
          <FormControl>
            <RadioGroupItem value="amber" className="sr-only" />
          </FormControl>
          <div className="border-muted hover:border-accent flex items-center justify-center rounded-md border-2 p-4">
            <PaletteSwatch colors={AMBER_SWATCH_COLORS} />
          </div>
          <span className="block w-full p-1 text-center text-xs font-normal sm:p-1.5 sm:text-sm">
            {t("common:component.chart_palette_amber_label")}
          </span>
        </FormLabel>
      </FormItem>
      <FormItem>
        <FormLabel className="[&:has([data-state=checked])>div]:border-primary cursor-pointer">
          <FormControl>
            <RadioGroupItem value="newspaper" className="sr-only" />
          </FormControl>
          <div className="border-muted hover:border-accent newspaper-swatch-texture relative flex items-center justify-center overflow-hidden rounded-md border-2 bg-white p-4">
            <PaletteSwatch colors={NEWSPAPER_SWATCH_COLORS} />
          </div>
          <span className="block w-full p-1 text-center text-xs font-normal sm:p-1.5 sm:text-sm">
            {t("common:component.chart_palette_newspaper_label")}
          </span>
        </FormLabel>
      </FormItem>
      <FormItem>
        <FormLabel className="[&:has([data-state=checked])>div]:border-primary cursor-pointer">
          <FormControl>
            <RadioGroupItem value="cyberpunk" className="sr-only" />
          </FormControl>
          <div className="cyberpunk-swatch-glow border-muted hover:border-accent flex items-center justify-center rounded-md border-2 bg-black p-4">
            <PaletteSwatch colors={CYBERPUNK_SWATCH_COLORS} />
          </div>
          <span className="block w-full p-1 text-center text-xs font-normal sm:p-1.5 sm:text-sm">
            {t("common:component.chart_palette_cyberpunk_label")}
          </span>
        </FormLabel>
      </FormItem>
    </RadioGroup>
  );
}
