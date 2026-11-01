import { AVATAR_ATLASES } from "./avatar-catalog";
import {
  LINE_PORTRAITS,
  PERSONA_AVATARS,
  ANIMATED_CLAY,
  ANIMATED_PIXEL,
  ANIMATED_SKETCH,
  ABSTRACT_SCULPTURES,
} from "./avatar-catalog";
export { DEFAULT_PROFILE_AVATAR, PROFILE_AVATARS, PROFILE_AVATAR_GROUPS } from "./avatar-catalog";
import type { CSSProperties } from "react";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import "./profile-avatar.css";
import { LinePortraitAvatar } from "./line-portrait-avatars";
import { PersonaAvatar } from "./persona-avatars";
import { cn } from "@wealthfolio/ui/lib/utils";

export function ProfileAvatar({
  id,
  className,
  animated = true,
}: {
  id: string;
  className?: string;
  animated?: boolean;
}) {
  return <AvatarArtwork id={id} className={cn(className, !animated && "profile-avatar-static")} />;
}

function AvatarArtwork({ id, className }: { id: string; className?: string }) {
  const portrait = LINE_PORTRAITS.find((candidate) => candidate.id === id);
  if (portrait) return <LinePortraitAvatar portrait={portrait} className={className} />;
  const persona = PERSONA_AVATARS.find((candidate) => candidate.id === id);
  if (persona) return <PersonaAvatar persona={persona} className={className} />;
  const sketch = ANIMATED_SKETCH[id];
  if (sketch) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "profile-sketch-avatar relative mx-auto block aspect-square w-20 max-w-full overflow-hidden rounded-2xl",
          className,
        )}
        style={
          {
            backgroundImage: `url(${AVATAR_ATLASES.sketch})`,
            backgroundSize: "400% 400%",
            backgroundPosition: `${(sketch.cell * 100) / 3}% ${100 / 3}%`,
            "--sculpture-eye-delay": `${sketch.cell * 0.03}s`,
          } as CSSProperties
        }
      >
        {sketch.eyes.map(([x, y, width, height], index) => (
          <span
            key={index}
            className="profile-sculpture-eye-position absolute"
            style={{
              left: `${x}%`,
              top: `${y}%`,
              width: `${width}%`,
              height: `${height}%`,
              transform: `translate(-50%, -50%) rotate(${sketch.tilt}deg)`,
            }}
          >
            <span className="profile-sculpture-eye block size-full overflow-hidden rounded-full">
              <span className="profile-sculpture-pupil relative top-[21%] left-[28%] block h-[60%] w-[47%] rounded-full" />
            </span>
          </span>
        ))}
      </span>
    );
  }
  const pixel = ANIMATED_PIXEL[id];
  if (pixel) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "relative mx-auto block aspect-square w-20 max-w-full overflow-hidden rounded-2xl [image-rendering:pixelated]",
          className,
        )}
        style={
          {
            backgroundImage: `url(${AVATAR_ATLASES.pixel})`,
            backgroundSize: "400% 400%",
            backgroundPosition: `${(pixel.cell * 100) / 3}% ${200 / 3}%`,
            "--pixel-eye-color": pixel.color,
            "--pixel-eye-delay": `${pixel.cell * 0.03}s`,
          } as CSSProperties
        }
      >
        {pixel.eyes.map(([x, y], index) => (
          <span
            key={index}
            className="profile-pixel-eye-position absolute h-[9%] w-[6%]"
            style={{ left: `${x}%`, top: `${y}%` }}
          >
            <span className="profile-pixel-gaze block size-full">
              <span className="profile-pixel-blink block size-full">
                <span className="profile-pixel-eye block size-full" />
              </span>
            </span>
          </span>
        ))}
      </span>
    );
  }
  const clay = ANIMATED_CLAY[id];
  if (clay) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          `profile-clay-${clay.cell} relative mx-auto block aspect-square w-20 max-w-full overflow-hidden rounded-2xl`,
          className,
        )}
        style={
          {
            backgroundImage: `url(${AVATAR_ATLASES.clay})`,
            backgroundSize: "400% 400%",
            backgroundPosition: `${(clay.cell * 100) / 3}% 0%`,
            "--sculpture-eye-delay": `${clay.cell * 0.03}s`,
          } as CSSProperties
        }
      >
        {clay.eyes.map(([x, y, width, height], index) => (
          <span
            key={index}
            className="profile-sculpture-eye-position absolute"
            style={{
              left: `${x}%`,
              top: `${y}%`,
              width: `${width}%`,
              height: `${height}%`,
              transform: `translate(-50%, -50%) rotate(${clay.tilt}deg)`,
            }}
          >
            <span className="profile-sculpture-eye block size-full overflow-hidden rounded-full">
              <span className="profile-sculpture-pupil relative top-[21%] left-[28%] block h-[60%] w-[47%] rounded-full" />
            </span>
          </span>
        ))}
      </span>
    );
  }
  const sculpture = ABSTRACT_SCULPTURES[id];
  if (sculpture) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "mx-auto block aspect-square w-20 max-w-full overflow-hidden rounded-2xl",
          className,
        )}
        style={{ backgroundColor: sculpture.color }}
      >
        <span
          className="profile-abstract-sculpture relative block size-full"
          style={
            {
              backgroundImage: `url(${AVATAR_ATLASES.abstract})`,
              backgroundSize: "200% 200%",
              backgroundPosition: `${(sculpture.cell % 2) * 100}% ${Math.floor(sculpture.cell / 2) * 100}%`,
              animationDelay: `${sculpture.cell * -1.2}s`,
              clipPath: sculpture.cell < 2 ? "inset(0 0 2% 0)" : undefined,
              "--sculpture-eye-delay": `${sculpture.cell * 0.03}s`,
              "--sculpture-x": `${sculpture.offset[0]}%`,
              "--sculpture-y": `${sculpture.offset[1]}%`,
            } as CSSProperties
          }
        >
          {/* Only the small face region is used; the original transparent silhouette stays intact. */}
          <span
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${AVATAR_ATLASES.patches})`,
              backgroundSize: "200% 200%",
              backgroundPosition: `${(sculpture.cell % 2) * 100}% ${Math.floor(sculpture.cell / 2) * 100}%`,
              clipPath: sculpture.patch,
            }}
          />
          {sculpture.eyes.map(([x, y, width, height], index) => (
            <span
              key={index}
              className="profile-sculpture-eye-position absolute"
              style={{ left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%` }}
            >
              <span className="profile-sculpture-eye block size-full overflow-hidden rounded-full">
                <span className="profile-sculpture-pupil relative top-[21%] left-[28%] block h-[60%] w-[47%] rounded-full" />
              </span>
            </span>
          ))}
        </span>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-muted text-muted-foreground relative mx-auto flex aspect-square w-20 max-w-full items-center justify-center overflow-hidden rounded-full",
        className,
      )}
    >
      <UserIcon weight="duotone" className="size-3/5" />
    </span>
  );
}
