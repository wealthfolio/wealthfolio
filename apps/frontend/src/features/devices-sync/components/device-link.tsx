// DeviceLink
// Two devices joined by a row of dots: the dots breathe while the devices
// connect and flow toward the receiving device while data moves.
// Decorative only; the step's title says what is happening.
// =======================================================================

import { cn } from "@/lib/utils";
import { Icons } from "@wealthfolio/ui";
import { useIsMobile } from "@wealthfolio/ui/hooks";

const DOT_COUNT = 5;

function DeviceTile({ phone, current }: { phone: boolean; current: boolean }) {
  const Icon = phone ? Icons.Smartphone : Icons.Laptop;
  return (
    <div
      className={cn(
        "flex size-16 shrink-0 items-center justify-center rounded-2xl border",
        current ? "bg-background border-primary/25 shadow-sm" : "bg-muted/60 border-transparent",
      )}
    >
      <Icon className={cn("size-7", current ? "text-foreground" : "text-muted-foreground")} />
    </div>
  );
}

interface DeviceLinkProps {
  /** The device the data comes from; it is drawn on the left. */
  source: "this" | "other";
  /** Data is moving; otherwise the devices are still connecting. */
  flowing?: boolean;
}

export function DeviceLink({ source, flowing = false }: DeviceLinkProps) {
  // Phone-sized screens draw this device as a phone.
  const isMobile = useIsMobile();
  // The other device is usually the complementary kind (a phone for a laptop).
  const thisDevice = { phone: isMobile, current: true };
  const otherDevice = { phone: !isMobile, current: false };
  const [left, right] = source === "this" ? [thisDevice, otherDevice] : [otherDevice, thisDevice];

  return (
    <div className="flex items-center justify-center gap-4" aria-hidden>
      <DeviceTile {...left} />
      <div className="flex w-24 items-center justify-between px-1">
        {Array.from({ length: DOT_COUNT }, (_, index) => (
          <span
            key={index}
            className="bg-primary size-1.5 rounded-full opacity-20 motion-safe:animate-[device-link-pulse_1.1s_ease-in-out_infinite]"
            style={{
              animationDuration: flowing ? "1.1s" : "1.8s",
              animationDelay: flowing ? `${index * 0.14}s` : "0s",
            }}
          />
        ))}
      </div>
      <DeviceTile {...right} />
    </div>
  );
}
