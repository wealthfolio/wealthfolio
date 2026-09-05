import { Badge } from "./badge";
import { Button } from "./button";
import { cn } from "../../lib/utils";
import { Icons } from "./icons";
import * as React from "react";

type InputProps = React.ComponentProps<"input">;

type InputTagsProps = Omit<InputProps, "value" | "onChange"> & {
  value: string[];
  onChange: React.Dispatch<React.SetStateAction<string[]>>;
};

const InputTags = React.forwardRef<HTMLInputElement, InputTagsProps>(
  ({ className, value, onChange, ...props }, ref) => {
    const [pendingDataPoint, setPendingDataPoint] = React.useState("");

    React.useEffect(() => {
      if (pendingDataPoint.includes(",")) {
        const newDataPoints = new Set([...value, ...pendingDataPoint.split(",").map((chunk) => chunk.trim())]);
        onChange(Array.from(newDataPoints));
        setPendingDataPoint("");
      }
    }, [pendingDataPoint, onChange, value]);

    const addPendingDataPoint = () => {
      if (pendingDataPoint) {
        const newDataPoints = new Set([...value, pendingDataPoint]);
        onChange(Array.from(newDataPoints));
        setPendingDataPoint("");
      }
    };

    return (
      <div
        className={cn(
          // caveat: :has() variant requires tailwind v3.4 or above: https://tailwindcss.com/blog/tailwindcss-v3-4#new-has-variant
          "border-input dark:bg-input/30 bg-input-bg min-h-input-height shadow-xs flex w-full flex-wrap gap-2 rounded-md border px-3 py-1 text-base outline-none transition-[color,box-shadow] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          "has-focus-visible:border-ring has-focus-visible:ring-ring/50 has-focus-visible:ring-[3px]",
          className,
        )}
      >
        {value.map((item: string) => (
          <Badge key={item} variant="secondary" className="!rounded-md text-xs">
            {item}
            <Button
              variant="ghost"
              size="icon"
              className="ml-2 h-3 w-3"
              onClick={() => {
                onChange(value.filter((i: string) => i !== item));
              }}
            >
              <Icons.X className="w-3" />
            </Button>
          </Badge>
        ))}
        <input
          className="flex-1 outline-none placeholder:text-neutral-500 dark:placeholder:text-neutral-400"
          value={pendingDataPoint}
          onChange={(e) => setPendingDataPoint(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;

            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addPendingDataPoint();
            } else if (e.key === "Backspace" && pendingDataPoint.length === 0 && value.length > 0) {
              e.preventDefault();
              onChange(value.slice(0, -1));
            }
          }}
          {...props}
          ref={ref}
        />
      </div>
    );
  },
);

InputTags.displayName = "InputTags";

export { InputTags };
