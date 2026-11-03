import { AVATAR_ATLASES } from "./avatar-catalog";
import type { CSSProperties } from "react";
import { cn } from "@wealthfolio/ui/lib/utils";

import type { Persona } from "./avatar-catalog";

export function PersonaAvatar({ persona, className }: { persona: Persona; className?: string }) {
  const pixel = persona.row === 2;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative mx-auto block aspect-square w-20 max-w-full overflow-hidden rounded-2xl",

        persona.row === 1 && "profile-sketch-avatar",
        pixel && "[image-rendering:pixelated]",
        className,
      )}
      style={
        {
          backgroundImage:
            persona.row < 2 ? `url(${AVATAR_ATLASES.vintage})` : `url(${AVATAR_ATLASES.personas})`,
          // The generated two-row atlas has a slightly taller sketch row.
          backgroundSize:
            persona.row === 0 ? "400% 207.73%" : persona.row === 1 ? "400% 192.83%" : "400% 400%",
          backgroundPosition: `${(persona.column * 100) / 3}% ${persona.row < 2 ? persona.row * 100 : (persona.row * 100) / 3}%`,
          "--sculpture-eye-delay": `${persona.column * 0.03 + persona.row * 0.03}s`,
          "--pixel-eye-delay": `${persona.column * 0.03}s`,
          "--pixel-eye-color": "#352c2c",
        } as CSSProperties
      }
    >
      {persona.eyes.map(([x, y, width, height], index) => (
        <span
          key={index}
          className={
            pixel
              ? "profile-pixel-eye-position absolute h-[9%] w-[6%]"
              : "profile-sculpture-eye-position absolute"
          }
          style={{
            left: `${x}%`,
            top: `${y}%`,
            width: `${width}%`,
            height: `${height}%`,
            transform: `translate(-50%, -50%) rotate(${persona.tilt ?? 0}deg)`,
          }}
        >
          {pixel ? (
            <span className="profile-pixel-gaze block size-full">
              <span className="profile-pixel-blink block size-full">
                <span className="profile-pixel-eye block size-full" />
              </span>
            </span>
          ) : (
            <span className="profile-sculpture-eye block size-full overflow-hidden rounded-full">
              <span className="profile-sculpture-pupil relative top-[21%] left-[28%] block h-[60%] w-[47%] rounded-full" />
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
