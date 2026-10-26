import { ProfileAvatar } from "@/features/profiles/profile-avatar";
import type { ReactNode } from "react";
import "@/features/profiles/profile-shell.css";
import { useTranslation } from "react-i18next";
import { useProfile } from "@/features/profiles/profile-context";
import { openingProfileHint } from "@/features/profiles/startup-hint";

interface StartupScreenProps {
  profile?: { name: string; avatarId: string } | null;
  message?: string;
  error?: string;
  children?: ReactNode;
}

/** This fallback must render even before translation resources are ready. */
export function StartupScreen({ profile, message, error, children }: StartupScreenProps) {
  const { t } = useTranslation("common", { useSuspense: false });
  const context = useProfile();
  const identity = profile === undefined ? (context?.profile ?? openingProfileHint()) : profile;
  const label =
    message ??
    (error
      ? t("profiles.startupFailed", { defaultValue: "Couldn’t open Wealthfolio" })
      : identity
        ? t("profiles.openingProfile", { name: identity.name, defaultValue: "Opening {{name}}…" })
        : t("profiles.opening", { defaultValue: "Opening Wealthfolio…" }));
  return (
    <main
      className={
        identity
          ? "profile-boot-screen profile-lock-screen"
          : "flex min-h-dvh flex-col items-center justify-center gap-6 bg-[#100f0f] px-6 py-16 text-center text-[#fffcf0]"
      }
    >
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-8" />
      {identity && !error ? (
        <span className="profile-lock-avatar profile-opening-placeholder" aria-hidden="true" />
      ) : identity ? (
        <span>
          <span className="profile-lock-avatar">
            <ProfileAvatar
              id={identity.avatarId}
              animated={false}
              className="profile-boot-avatar size-20 rounded-full [&_.profile-abstract-sculpture]:scale-90"
            />
          </span>
        </span>
      ) : (
        <img
          src="/logo-gold.png"
          alt="Wealthfolio"
          className={`size-20 object-contain ${error ? "" : "splash-logo-pulse"}`}
        />
      )}
      <div className={error ? "w-full max-w-sm space-y-2 text-center" : "contents"}>
        <p
          role="status"
          className={
            error
              ? "text-lg font-semibold text-balance break-words"
              : "profile-loading-status sr-only"
          }
        >
          {label}
        </p>
        {error && (
          <p
            role="alert"
            className="text-muted-foreground text-sm leading-relaxed text-pretty break-words"
          >
            {error}
          </p>
        )}
      </div>
      {children && <div className="flex flex-wrap justify-center gap-3">{children}</div>}
    </main>
  );
}
