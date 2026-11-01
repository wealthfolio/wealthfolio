import { useTranslation } from "react-i18next";
import { useState } from "react";
import { PROFILE_AVATAR_GROUPS, ProfileAvatar } from "./profile-avatar";

export function ProfileAvatarPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation("common");
  const [style, setStyle] = useState("All");
  const groups = [
    { name: "All", avatars: PROFILE_AVATAR_GROUPS.flatMap((group) => group.avatars) },
    ...PROFILE_AVATAR_GROUPS,
  ];
  const labels: Record<string, string> = {
    All: t("profiles.avatarAll"),
    Sketch: t("profiles.avatarSketch"),
    Line: t("profiles.avatarLine"),
    "Pixel art": t("profiles.avatarPixel"),
    "3D": t("profiles.avatar3d"),
    Abstract: t("profiles.avatarAbstract"),
  };
  const group = groups.find((group) => group.name === style)!;
  return (
    <div className="space-y-3">
      <div role="group" aria-label={t("profiles.avatarStyle")} className="flex flex-wrap gap-1">
        {groups.map((item) => (
          <button
            key={labels[item.name]}
            type="button"
            aria-pressed={style === item.name}
            onClick={() => setStyle(item.name)}
            className={`focus-visible:ring-ring rounded-full px-3 py-1.5 text-xs focus-visible:ring-2 ${style === item.name ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground bg-white/20 dark:bg-white/5"}`}
          >
            {labels[item.name]}
          </button>
        ))}
      </div>
      <div
        role="group"
        aria-label={t("profiles.avatarGroup", { style: labels[style] })}
        className="grid w-full grid-cols-4 gap-3 !overflow-visible pt-4 pb-8 sm:grid-cols-8 sm:gap-2"
      >
        {group.avatars.map((id) => (
          <button
            type="button"
            key={id}
            aria-label={(() => {
              const category = PROFILE_AVATAR_GROUPS.find((entry) => entry.avatars.includes(id))!;
              return t("profiles.avatarLabel", {
                style: labels[category.name],
                number: category.avatars.indexOf(id) + 1,
              });
            })()}
            aria-pressed={value === id}
            onClick={() => onChange(id)}
            className="focus-visible:ring-ring flex min-w-0 justify-center !overflow-visible rounded-full p-0 hover:brightness-105 focus-visible:ring-2 sm:p-1"
          >
            <span
              className={`profile-lock-avatar w-full [--avatar-rim:3px] sm:w-auto ${value === id ? "drop-shadow-[0_0_7px_#c09a5bb3] dark:drop-shadow-[0_0_8px_#e2bd75b3]" : ""}`}
            >
              <ProfileAvatar
                id={id}
                className="h-auto w-full rounded-full sm:size-14 [&_.profile-abstract-sculpture]:scale-90"
              />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
