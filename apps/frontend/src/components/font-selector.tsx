import { cn } from "@/lib/utils";

interface FontSelectorProps {
  value?: string;
  onChange: (value: string) => void;
  className?: string;
  labels?: Partial<Record<(typeof fonts)[number]["value"], string>>;
}

const fonts = [
  {
    value: "font-sans",
    label: "Sans",
    preview: "Aa",
  },
  {
    value: "font-serif",
    label: "Serif",
    preview: "Aa",
  },
  {
    value: "font-mono",
    label: "Mono",
    preview: "Aa",
  },
];

export function FontSelector({ value, onChange, className, labels }: FontSelectorProps) {
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
          <div className="text-xs font-medium sm:text-sm">{labels?.[font.value] ?? font.label}</div>
          {value === font.value && (
            <div className="bg-primary absolute right-2 top-2 h-1.5 w-1.5 rounded-full" />
          )}
        </button>
      ))}
    </div>
  );
}
