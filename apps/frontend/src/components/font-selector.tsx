import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface FontSelectorProps {
  value?: string;
  onChange: (value: string) => void;
  className?: string;
}

const fonts = [
  {
    value: "font-sans",
    labelKey: "component.font_sans",
    preview: "Aa",
  },
  {
    value: "font-serif",
    labelKey: "component.font_serif",
    preview: "Aa",
  },
  {
    value: "font-mono",
    labelKey: "component.font_mono",
    preview: "Aa",
  },
];

export function FontSelector({ value, onChange, className }: FontSelectorProps) {
  const { t } = useTranslation();
  return (
    <div className={cn("grid grid-cols-3 gap-2 md:gap-4", className)}>
      {fonts.map((font) => (
        <button
          key={font.value}
          type="button"
          onClick={() => onChange(font.value)}
          className={cn(
            "hover:bg-accent/50 relative flex flex-col items-center justify-center rounded-lg border-2 p-3 transition-all duration-200 sm:p-4",
            value === font.value
              ? "border-primary bg-accent/30"
              : "border-muted hover:border-accent",
          )}
        >
          <div className={cn("mb-1 text-xl font-medium sm:text-2xl", font.value)}>
            {font.preview}
          </div>
          <div className="text-xs font-medium sm:text-sm">{t(`common:${font.labelKey}`)}</div>
          {value === font.value && (
            <div className="bg-primary absolute right-2 top-2 h-1.5 w-1.5 rounded-full" />
          )}
        </button>
      ))}
    </div>
  );
}
