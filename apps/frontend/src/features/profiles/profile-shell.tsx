import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DATABASE_STATE_CHANGED } from "../../adapters/tauri/events";
import { profileErrorMessage } from "./error-messages";
import { clearProfilePreferences } from "@/hooks/use-persistent-state";
import { DeleteProfileDialog } from "./delete-profile-dialog";
import { StartupScreen } from "@/components/startup-screen";
import { reloadApplication } from "@/lib/reload-application";
import { clearOpeningProfile, rememberOpeningProfile } from "./startup-hint";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { isNativeAuthPending } from "./auth-bridge";
import { isWeb, listenPortfolioUpdateStart } from "@/adapters";
import { Button, Icons, Input, Label } from "@wealthfolio/ui";
import { PasswordInput } from "@wealthfolio/ui/components/ui/password-input";
import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import {
  profileCommand,
  profileChangesChannel,
  type ProfileState,
  type ProfileSummary,
} from "./api";
import { DEFAULT_PROFILE_AVATAR, ProfileAvatar } from "./profile-avatar";
import { ProfileAvatarPicker } from "./profile-avatar-picker";
import { ProfileStartupRecovery } from "./profile-startup-recovery";
import "./profile-shell.css";
import { ProfileContext } from "./profile-context";
import {
  installProfileSession,
  profileScope,
  revokeProfileSession,
  type ProfileSession,
} from "./session";

const PROFILE_SELECTION_MS = 180;
const MIN_PASSWORD_LENGTH = 4;
const MAX_PASSWORD_LENGTH = 128;
const PASSWORD_LENGTH_ERROR = "PROFILE_PASSWORD_LENGTH";
// Idle expiry reaches an untouched screen only by the server ending the event
// stream. Hold it open for every admitted route, not just AppLayout ones.
const keepEventStreamOpen = () => undefined;

export function ProfileShell({ children }: { children: ReactNode }) {
  const queries = useQueryClient();
  const reducedMotion = useReducedMotion();
  const { t } = useTranslation("common", { useSuspense: false });
  type Phase = "loading" | "closing" | "opening" | "locked" | "active" | "deleting";
  const [phase, updatePhase] = useState<Phase>("loading");
  const phaseRef = useRef<Phase>("loading");
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    updatePhase(next);
  }, []);
  const intent = useRef<"lock" | "switch">("lock");
  const epoch = useRef(0);
  const working = useRef(false);
  const currentProfile = useRef<ProfileSummary | undefined>(undefined);
  const refreshRef = useRef<(() => void) | undefined>(undefined);
  const needsClose = useRef(false);
  const [closeFailed, setCloseFailed] = useState(false);
  const [state, setState] = useState<ProfileState>();
  const [selected, setSelected] = useState<ProfileSummary>();
  const heading = useRef<HTMLHeadingElement>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmationInvalid, setConfirmationInvalid] = useState(false);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const [passwordInvalid, setPasswordInvalid] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const [proof, setProof] = useState("");
  const [passwordManagement, setPasswordManagement] = useState(false);
  const [removePassword, setRemovePassword] = useState(false);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(DEFAULT_PROFILE_AVATAR);
  const [mode, setMode] = useState<"choose" | "create" | "unlock" | "manage" | "recover">("choose");
  const [error, setError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deletion = useRef<{ profileId: string; confirmation: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<string>();
  const [copiedRecovery, setCopiedRecovery] = useState<string>();
  const [covered, setCovered] = useState(false);
  const sessionScope = state?.session?.scopeId;
  const [authPending, setAuthPending] = useState(isNativeAuthPending);
  const lock = useCallback(
    async (preserveAuth = false, nextIntent: "lock" | "switch" = "lock") => {
      if (working.current) return;
      working.current = true;
      intent.current = nextIntent;
      epoch.current += 1;
      setCloseFailed(false);
      setError("");
      setBusy(true);
      setPhase("closing");
      setCovered(true);
      setSelected(currentProfile.current);
      setPassword("");
      setConfirmPassword("");
      setConfirmationInvalid(false);
      revokeProfileSession();
      try {
        await profileCommand("lock_profile", { preserveAuth });
        needsClose.current = false;
        setState((old) => (old ? { ...old, session: null } : old));
        setMode("choose");
        setPhase("locked");
        return true;
      } catch (e) {
        setError(String(e));
        setCloseFailed(true);
      } finally {
        working.current = false;
        setBusy(false);
      }
    },
    [setPhase],
  );
  useEffect(() => {
    const update = () => setAuthPending(isNativeAuthPending());
    window.addEventListener("wealthfolio:auth-pending", update);
    return () => window.removeEventListener("wealthfolio:auth-pending", update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let refreshPending = false;
    const refresh = async () => {
      if (cancelled) return;
      if (inFlight) {
        refreshPending = true;
        return;
      }
      if (
        working.current ||
        phaseRef.current === "opening" ||
        phaseRef.current === "closing" ||
        phaseRef.current === "deleting"
      )
        return;
      inFlight = true;
      const requestEpoch = epoch.current;
      try {
        const next = await profileCommand<ProfileState>("get_profile_state");
        if (cancelled || requestEpoch !== epoch.current || working.current) return;
        const previous = currentProfile.current;
        if (previous && !next.profiles.some((profile) => profile.id === previous.id)) {
          intent.current = "switch";
          if (!next.pendingDeletions?.some((profile) => profile.id === previous.id))
            clearProfilePreferences(previous.id);
        }
        if (next.startupError) {
          setState(next);
          setPhase("loading");
        } else if (next.session) {
          const profile = next.profiles.find((p) => p.id === next.session?.profileId);
          if (profile) rememberOpeningProfile(profile);
          if (!installProfileSession(next.session, profile?.isLegacy)) return;
          if (isWeb) void listenPortfolioUpdateStart(keepEventStreamOpen).catch(() => undefined);
          currentProfile.current = profile;
          setState(next);
          setCovered(false);
          setPhase("active");
          clearOpeningProfile();
        } else if (next.starting) {
          setState(next);
          setPhase("loading");
        } else {
          // Join native teardown before offering another activation. A replacement
          // recovery grant above must reload without being revoked again.
          if (needsClose.current || phaseRef.current === "active") {
            needsClose.current = false;
            setState(next);
            if (!isWeb) {
              await lock(true, intent.current);
              return;
            }
            // Web has no teardown to join, and the server already has no session.
            // Locking it again could revoke a session another tab just opened.
            revokeProfileSession();
            needsClose.current = false;
            setSelected(currentProfile.current);
            setPassword("");
            setConfirmPassword("");
            setConfirmationInvalid(false);
            setMode("choose");
          }
          setState(next);
          setCovered(true);
          setPhase("locked");
          if (
            !currentProfile.current &&
            next.profiles.length === 1 &&
            intent.current !== "switch"
          ) {
            currentProfile.current = next.profiles[0];
            setSelected(next.profiles[0]);
            setMode("choose");
          }
        }
      } catch (e) {
        if (!cancelled && requestEpoch === epoch.current) {
          if (isWeb && phaseRef.current === "active") await lock();
          else setError(String(e));
        }
      } finally {
        inFlight = false;
        if (refreshPending && !cancelled) {
          refreshPending = false;
          void refresh();
        }
      }
    };
    refreshRef.current = () => void refresh();
    // Other tabs announce profile mutations; the event stream drops on revocation
    // or idle expiry. Becoming visible reconciles frozen or suspended tabs.
    const visibleRefresh = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const wake = () => void refresh();
    const profileChanged = (event: MessageEvent) => {
      if (event.data === "changed") void refresh();
    };
    profileChangesChannel?.addEventListener("message", profileChanged);
    const webEvents = [
      [document, "visibilitychange", visibleRefresh],
      [window, "online", wake],
      [window, "offline", wake],
      [window, "wealthfolio:event-stream-error", wake],
    ] as const;
    if (isWeb)
      for (const [target, name, handler] of webEvents) target.addEventListener(name, handler);
    const locked = () => {
      epoch.current += 1;
      void queries.cancelQueries();
      queries.clear();
      setCovered(true);
      if (!working.current) {
        needsClose.current = true;
        setPhase("loading");
        setSelected(currentProfile.current);
        setMode("choose");
        void refresh();
      }
    };
    window.addEventListener("wealthfolio:profile-locked", locked);
    const unlisteners: (() => void)[] = [];
    if (!isWeb)
      void import("@tauri-apps/api/event")
        .then(async ({ listen }) => {
          for (const [event, handler] of [
            ["profile-session-changed", revokeProfileSession],
            ["app:ready", () => void refresh()],
            // Rebuilds can revoke the scoped database reader while maintenance
            // is running. The shell survives that reader and renews admission.
            [DATABASE_STATE_CHANGED, () => void refresh()],
          ] as const) {
            const unlisten = await listen(event, handler);
            if (cancelled) {
              unlisten();
              return;
            }
            unlisteners.push(unlisten);
          }
          // Subscribe before reading so startup or lock changes cannot be missed.
          void refresh();
        })
        .catch((cause) => {
          if (cancelled) return;
          // A state read cannot replace the missing lock listener. Keep the
          // shell closed until a reload can register all subscriptions again.
          cancelled = true;
          unlisteners.splice(0).forEach((unlisten) => unlisten());
          refreshRef.current = () => reloadApplication();
          setError(String(cause));
        });
    else void refresh();
    return () => {
      cancelled = true;
      profileChangesChannel?.removeEventListener("message", profileChanged);
      if (isWeb)
        for (const [target, name, handler] of webEvents) target.removeEventListener(name, handler);
      unlisteners.forEach((unlisten) => unlisten());
      window.removeEventListener("wealthfolio:profile-locked", locked);
    };
  }, [queries, lock, setPhase]);

  useEffect(() => {
    if (!sessionScope || covered) return;
    let last = 0;
    const activity = (event: Event) => {
      if (!event.isTrusted || Date.now() - last < 15000) return;
      last = Date.now();
      void profileCommand("profile_activity", { scopeId: profileScope() }, true).catch(() =>
        revokeProfileSession(),
      );
    };
    for (const event of ["pointerdown", "keydown", "touchstart", "wheel"])
      window.addEventListener(event, activity, { passive: true });
    return () => {
      for (const event of ["pointerdown", "keydown", "touchstart", "wheel"])
        window.removeEventListener(event, activity);
    };
  }, [sessionScope, covered, lock]);

  useEffect(() => {
    if (
      phase === "locked" &&
      (mode === "choose" || (mode === "unlock" && !selected?.lockEnabled))
    ) {
      heading.current?.focus();
    }
  }, [phase, mode, selected?.lockEnabled]);

  useEffect(() => {
    if (passwordInvalid && !busy) {
      passwordInput.current?.focus();
      passwordInput.current?.select();
    }
  }, [passwordInvalid, busy]);

  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    epoch.current += 1;
    setBusy(true);
    setError("");
    setPasswordInvalid(false);
    try {
      await action();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
      setPhase("locked");
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function select(profile: ProfileSummary) {
    if (working.current) return;
    if (profile.id !== currentProfile.current?.id) intent.current = "switch";
    setSelected(profile);
    setPasswordInvalid(false);
    setPassword("");
    setConfirmPassword("");
    setConfirmationInvalid(false);
    setProof("");
    setError("");
    setMode("unlock");
    if (!profile.lockEnabled) {
      void run(() => unlock(profile.id, ""));
    }
  }
  async function unlock(id: string, unlockProof = password, createdProfile?: ProfileSummary) {
    const target =
      createdProfile ?? (selected?.id === id ? selected : state?.profiles.find((p) => p.id === id));
    if (target) setSelected(target);
    // Finish moving the avatar before loading replaces this screen.
    if (mode !== "create" && !reducedMotion)
      await new Promise((resolve) => setTimeout(resolve, PROFILE_SELECTION_MS));
    try {
      await profileCommand<ProfileSession>("unlock_profile", {
        profileId: id,
        proof: unlockProof || null,
      });
    } catch (error) {
      // The stored lock is authoritative; a migrated registry may have an old hint.
      const invalidPassword = String(error).includes("PROFILE_PASSWORD_INVALID");
      if (target && (String(error).includes("PROFILE_LOCKED") || invalidPassword)) {
        setSelected({ ...target, lockEnabled: true });
        setState((current) =>
          current
            ? {
                ...current,
                profiles: current.profiles.map((profile) =>
                  profile.id === id ? { ...profile, lockEnabled: true } : profile,
                ),
              }
            : current,
        );
        setMode("unlock");
        setPasswordInvalid(invalidPassword);
        return;
      }
      throw error;
    }
    if (target) rememberOpeningProfile(target);
    setPhase("opening");
    // A fresh JS world is required even when reopening the same profile.
    reloadApplication({ dashboard: intent.current === "switch" });
  }
  async function deleteProfile(
    confirmation: string,
    proof: string,
    retry = false,
    target = selected,
  ) {
    if (!target || working.current) return;
    setSelected(target);
    working.current = true;
    epoch.current += 1;
    setBusy(true);
    setError("");
    setDeleteOpen(false);
    setPhase("deleting");
    deletion.current = { profileId: target.id, confirmation };
    try {
      await profileCommand("delete_profile", { ...deletion.current, proof }, !retry);
      clearProfilePreferences(target.id);
      setDeleteOpen(false);
      revokeProfileSession();
      await queries.cancelQueries();
      queries.clear();
      clearOpeningProfile();
      const next = await profileCommand<ProfileState>("get_profile_state");
      deletion.current = undefined;
      currentProfile.current = undefined;
      setSelected(undefined);
      intent.current = "switch";
      needsClose.current = false;
      setState(next);
      setCovered(true);
      setMode("choose");
      setPhase("locked");
    } catch (cause) {
      setError(String(cause).replace(/^Error:\s*/, ""));
      // Validation errors leave the profile intact and allow correction.
      const next = await profileCommand<ProfileState>("get_profile_state").catch(() => undefined);
      if (next) setState(next);
      if (next?.profiles.some((profile) => profile.id === target.id)) {
        setDeleteOpen(true);
        setPhase("active");
      } else {
        setDeleteOpen(false);
        revokeProfileSession();
        setPhase("deleting");
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  if (phase === "deleting")
    return (
      <StartupScreen
        profile={selected}
        message={t("profiles.deletingProfile")}
        error={error ? profileErrorMessage(error, t) : undefined}
      >
        <Button
          disabled={busy}
          onClick={() => {
            const pending = deletion.current;
            if (pending) void deleteProfile(pending.confirmation, "", true);
          }}
        >
          {busy ? t("profiles.deleting") : t("profiles.retryDeletion")}
        </Button>
        {!busy && (
          <Button
            variant="ghost"
            onClick={() => {
              setError("");
              currentProfile.current = undefined;
              setSelected(undefined);
              intent.current = "switch";
              needsClose.current = false;
              setMode("choose");
              setCovered(true);
              setPhase("locked");
            }}
          >
            {t("profiles.backToProfiles")}
          </Button>
        )}
      </StartupScreen>
    );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const settingPassword =
      mode === "recover" ||
      (mode === "create" && passwordManagement) ||
      (mode === "manage" &&
        passwordManagement &&
        !removePassword &&
        (Boolean(password) || Boolean(confirmPassword) || !selected?.lockEnabled));
    if (settingPassword) {
      const length = Array.from(password).length;
      if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
        setError(PASSWORD_LENGTH_ERROR);
        passwordInput.current?.focus();
        return;
      }
      if (password !== confirmPassword) {
        setError("");
        setConfirmationInvalid(true);
        confirmationInput.current?.focus();
        return;
      }
    }
    await run(async () => {
      if (mode === "unlock" && selected) await unlock(selected.id);
      if (mode === "create") {
        const { recoveryCode, ...created } = await profileCommand<
          ProfileSummary & { recoveryCode: string | null }
        >("create_profile", {
          name,
          avatarId: avatar,
          password: passwordManagement ? password : null,
        });
        intent.current = "switch";
        setSelected(created);
        setState((old) => (old ? { ...old, profiles: [...old.profiles, created] } : old));
        rememberOpeningProfile(created);
        if (recoveryCode) setRecovery(recoveryCode);
        else await unlock(created.id, "", created);
      }
      if (mode === "recover" && selected) {
        setRecovery(
          await profileCommand<string>("recover_profile_password", {
            profileId: selected.id,
            recoveryCode: proof,
            password,
          }),
        );
      }
      if (mode === "manage") {
        await profileCommand("update_profile", { name, avatarId: avatar }, true);
        if (passwordManagement && (password || removePassword)) {
          const code = await profileCommand<string | null>(
            "set_profile_password",
            { proof: proof || null, password: removePassword ? null : password || null },
            true,
          );
          setRecovery(code ?? undefined);
          revokeProfileSession();
          setCovered(true);
          if (!code) {
            await profileCommand("lock_profile", { preserveAuth: false });
            if (selected) await unlock(selected.id, "", { ...selected, lockEnabled: false });
          }
        } else reloadApplication();
      }
    });
  }
  function beginCreateProfile() {
    setError("");
    setPassword("");
    setConfirmPassword("");
    setConfirmationInvalid(false);
    setProof("");
    setName("");
    setPasswordManagement(false);
    setRemovePassword(false);
    setSelected(undefined);
    setAvatar(DEFAULT_PROFILE_AVATAR);
    setMode("create");
  }
  if (!isWeb && state?.startupError)
    return (
      <ProfileStartupRecovery
        error={state.startupError}
        onStartNew={(next) => {
          setState(next);
          setPhase("locked");
          beginCreateProfile();
        }}
      />
    );
  if (!recovery && (phase === "loading" || phase === "closing" || phase === "opening")) {
    return (
      <StartupScreen
        profile={selected}
        error={error ? profileErrorMessage(error, t) : undefined}
        message={
          closeFailed
            ? t("profiles.lockFailed", { defaultValue: "Couldn’t finish locking" })
            : phase === "closing"
              ? t("profiles.locking", { defaultValue: "Locking Wealthfolio…" })
              : undefined
        }
      >
        {error && (
          <Button
            onClick={() => {
              setError("");
              if (closeFailed) void lock(false, intent.current);
              else refreshRef.current?.();
            }}
          >
            {t("retry")}
          </Button>
        )}
      </StartupScreen>
    );
  }
  if (state?.session && !covered && mode !== "manage") {
    const current = state.profiles.find((p) => p.id === state.session?.profileId);
    return (
      <ProfileContext.Provider
        value={{
          profile: current,
          profileCount: state.profiles.length,
          profiles: state.profiles,
          addProfile: () => {
            void lock(false, "switch").then((closed) => {
              if (closed) beginCreateProfile();
            });
          },
          manageProfile: () => {
            setPasswordManagement(current?.lockEnabled ?? false);
            setRemovePassword(false);
            setName(current?.name ?? "");
            setAvatar(current?.avatarId ?? DEFAULT_PROFILE_AVATAR);
            setSelected(current);
            setPassword("");
            setConfirmPassword("");
            setConfirmationInvalid(false);
            setProof("");
            setMode("manage");
          },
          lockProfile: () => void lock(),
          switchProfile: () => void lock(false, "switch"),
          selectProfile: (profileId) => {
            const target = state.profiles.find((profile) => profile.id === profileId);
            if (!target || target.id === current?.id) return;
            void lock(false, "switch").then((closed) => {
              if (closed && target) select(target);
            });
          },
        }}
      >
        {children}
      </ProfileContext.Provider>
    );
  }
  const isProfileEditor = !recovery && (mode === "create" || mode === "manage");
  const isProfilePicker = !recovery && (mode === "choose" || mode === "unlock");
  const hasNoProfiles = state?.profiles.length === 0;
  const isRecoveryView = Boolean(recovery) || mode === "recover";
  const recoveryCodeInvalid = mode === "recover" && error.includes("PROFILE_PASSWORD_INVALID");
  const formError =
    error && error !== PASSWORD_LENGTH_ERROR && !recoveryCodeInvalid && !deleteOpen ? (
      <p
        id="profile-form-error"
        role="alert"
        className="text-destructive break-words text-sm leading-relaxed"
      >
        {profileErrorMessage(error, t)}
      </p>
    ) : null;
  const formActions = (
    <div
      className={
        mode === "recover"
          ? "flex flex-col gap-2 pt-2"
          : "bg-background/95 fixed inset-x-0 bottom-0 z-20 flex justify-center gap-2 border-t px-6 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] pt-3 backdrop-blur-md sm:static sm:justify-start sm:border-0 sm:bg-transparent sm:px-0 sm:pb-0 sm:pt-2 sm:backdrop-blur-none"
      }
    >
      <Button disabled={busy} type="submit">
        {mode === "recover"
          ? busy
            ? t("profiles.resettingPassword")
            : t("profiles.resetPassword")
          : mode === "manage"
            ? t("profiles.saveChanges")
            : t("profiles.save")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          if (mode === "recover") {
            setError("");
            setProof("");
            setPassword("");
            setConfirmPassword("");
            setConfirmationInvalid(false);
            setMode("unlock");
          } else {
            intent.current = "switch";
            setMode("choose");
          }
        }}
      >
        {mode === "recover"
          ? t("profiles.backToUnlock")
          : isProfileEditor
            ? t("profiles.cancel")
            : t("profiles.back")}
      </Button>
    </div>
  );
  const passwordFields = (
    <>
      {(mode === "recover" ||
        (mode === "manage" && passwordManagement && selected?.lockEnabled)) && (
        <div className="space-y-2">
          <Label htmlFor="profile-proof">
            {mode === "recover" ? t("profiles.recoveryCode") : t("profiles.currentProof")}
          </Label>
          <PasswordInput
            id="profile-proof"
            showLabel={
              mode === "recover" ? t("profiles.showRecovery") : t("profiles.showCurrentProof")
            }
            hideLabel={
              mode === "recover" ? t("profiles.hideRecovery") : t("profiles.hideCurrentProof")
            }
            className="h-11 rounded-full bg-white/30 ps-4 backdrop-blur-md dark:bg-white/5"
            value={proof}
            onChange={(e) => {
              setProof(e.target.value);
              if (recoveryCodeInvalid) setError("");
            }}
            autoFocus={mode === "recover"}
            aria-invalid={recoveryCodeInvalid}
            aria-describedby={
              recoveryCodeInvalid
                ? "profile-recovery-error"
                : mode === "recover"
                  ? "profile-recovery-help"
                  : undefined
            }
            required={mode === "recover" || removePassword || Boolean(password)}
            autoComplete={mode === "recover" ? "off" : "current-password"}
          />
          {recoveryCodeInvalid && (
            <p id="profile-recovery-error" role="alert" className="text-destructive text-sm">
              {t("profiles.errors.incorrectRecovery")}
            </p>
          )}
        </div>
      )}
      {(mode === "recover" ||
        ((mode === "create" || mode === "manage") && passwordManagement && !removePassword)) && (
        <div className="space-y-2">
          <Label htmlFor="profile-password">{t("profiles.newPassword")}</Label>
          <PasswordInput
            ref={passwordInput}
            id="profile-password"
            showLabel={t("profiles.showNewPassword")}
            hideLabel={t("profiles.hideNewPassword")}
            className="h-11 rounded-full bg-white/30 ps-4 backdrop-blur-md dark:bg-white/5"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setConfirmationInvalid(false);
              setError("");
            }}
            placeholder={t("profiles.passwordRange", {
              min: MIN_PASSWORD_LENGTH,
              max: MAX_PASSWORD_LENGTH,
            })}
            autoComplete="new-password"
            required={mode !== "manage" || !selected?.lockEnabled || Boolean(confirmPassword)}
            aria-invalid={error === PASSWORD_LENGTH_ERROR}
            aria-describedby={
              error === PASSWORD_LENGTH_ERROR ? "profile-password-error" : undefined
            }
          />
          {error === PASSWORD_LENGTH_ERROR && (
            <p id="profile-password-error" role="alert" className="text-destructive text-sm">
              {profileErrorMessage(error, t)}
            </p>
          )}
          <Label htmlFor="profile-confirm-password">{t("profiles.confirmPassword")}</Label>
          <PasswordInput
            ref={confirmationInput}
            id="profile-confirm-password"
            showLabel={t("profiles.showConfirmation")}
            hideLabel={t("profiles.hideConfirmation")}
            className="h-11 rounded-full bg-white/30 ps-4 backdrop-blur-md dark:bg-white/5"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setConfirmationInvalid(false);
            }}
            autoComplete="new-password"
            required={mode !== "manage" || !selected?.lockEnabled || Boolean(password)}
            aria-invalid={confirmationInvalid}
            aria-describedby={confirmationInvalid ? "profile-confirm-password-error" : undefined}
          />
          {confirmationInvalid && (
            <p
              id="profile-confirm-password-error"
              role="alert"
              className="text-destructive text-sm"
            >
              {t("profiles.errors.passwordMismatch")}
            </p>
          )}
        </div>
      )}
    </>
  );
  return (
    <main
      className={`bg-background text-foreground relative flex min-h-dvh items-center justify-center px-6 py-16 ${mode === "unlock" && busy ? "profile-centering" : ""} ${isProfilePicker ? "profile-lock-screen pt-24" : isProfileEditor ? "profile-lock-screen profile-settings-screen" : isRecoveryView ? "profile-lock-screen" : ""}`}
      aria-busy={busy}
    >
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-50 h-8" />
      {isProfilePicker && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-[calc(1rem+env(safe-area-inset-top,0px))] flex justify-center sm:top-10"
        >
          <div className="group/logo pointer-events-auto shrink-0 [perspective:400px]">
            <img
              src="/logo.png"
              alt=""
              className="size-12 object-contain transition-transform duration-1000 ease-[cubic-bezier(0.22,1,0.36,1)] motion-safe:[transform:rotateY(0deg)] motion-safe:group-hover/logo:[transform:rotateY(180deg)] motion-reduce:transition-none"
            />
          </div>
        </div>
      )}
      <div
        className={`w-full space-y-6 ${isRecoveryView ? "!max-w-md rounded-3xl border border-white/40 bg-white/40 p-6 text-left shadow-xl shadow-black/5 backdrop-blur-xl sm:p-8 dark:border-white/10 dark:bg-white/5" : isProfileEditor ? "max-w-2xl text-left" : "max-w-xl text-center"}`}
      >
        {isRecoveryView && selected && (
          <div className="flex items-center gap-3 !overflow-visible">
            <span className="profile-lock-avatar [--avatar-rim:3px]">
              <ProfileAvatar id={selected.avatarId} className="size-12 rounded-full" />
            </span>
            <span className="text-muted-foreground min-w-0 truncate text-sm">{selected.name}</span>
          </div>
        )}
        <h1
          ref={heading}
          tabIndex={-1}
          className={
            isProfilePicker && !hasNoProfiles ? "sr-only" : "text-2xl font-semibold outline-none"
          }
        >
          {recovery
            ? t("profiles.saveRecovery")
            : mode === "choose" || mode === "unlock"
              ? hasNoProfiles
                ? t("profiles.firstProfile")
                : t("profiles.chooseProfile")
              : mode === "create"
                ? t("profiles.createTitle")
                : mode === "manage"
                  ? t("profiles.yourProfile")
                  : t("profiles.resetTitle")}
        </h1>
        {mode === "recover" && !recovery && (
          <p id="profile-recovery-help" className="text-muted-foreground text-sm leading-relaxed">
            {t("profiles.recoveryHelp")}
          </p>
        )}
        {!state || state.starting ? (
          <p>{t("profiles.opening")}</p>
        ) : authPending ? (
          <p>{t("profiles.authPending")}</p>
        ) : recovery ? (
          <>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t("profiles.recoveryStorage")}
            </p>
            <div className="space-y-2">
              <div className="flex items-start gap-3 rounded-2xl border border-black/5 bg-white/50 p-4 dark:border-white/10 dark:bg-black/15">
                <code className="min-w-0 flex-1 select-all break-words font-mono text-base leading-7 tracking-wide">
                  {recovery}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 rounded-full"
                  aria-label={
                    copiedRecovery === recovery ? t("profiles.codeCopied") : t("profiles.copyCode")
                  }
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(recovery);
                      setCopiedRecovery(recovery);
                      setError("");
                    } catch {
                      setError("PROFILE_COPY_FAILED");
                    }
                  }}
                >
                  {copiedRecovery === recovery ? (
                    <Icons.Check className="size-4" />
                  ) : (
                    <Icons.Copy className="size-4" />
                  )}
                </Button>
              </div>
              <p role="status" className="text-muted-foreground min-h-4 text-xs">
                {copiedRecovery === recovery ? t("profiles.copied") : ""}
              </p>
            </div>
            {formError}
            <p className="text-muted-foreground text-xs leading-relaxed">
              {t("profiles.recoveryLimit")}
            </p>
            <Button
              className="w-full"
              disabled={busy}
              onClick={() => {
                if (mode === "create" && selected) {
                  void run(() => unlock(selected.id, password));
                } else {
                  setRecovery(undefined);
                  reloadApplication();
                }
              }}
            >
              {t("profiles.savedRecovery")}
            </Button>
          </>
        ) : mode === "choose" || mode === "unlock" ? (
          <>
            {hasNoProfiles && (
              <p className="text-muted-foreground mx-auto max-w-sm text-sm leading-relaxed">
                {t("profiles.emptyHelp")}
              </p>
            )}
            <div
              className={
                hasNoProfiles
                  ? "hidden"
                  : "profile-selection-list relative flex flex-wrap justify-center gap-6"
              }
            >
              <AnimatePresence initial={false} mode="popLayout">
                {state.profiles
                  .filter((profile) => mode !== "unlock" || profile.id === selected?.id)
                  .map((profile) => (
                    <motion.button
                      layout={reducedMotion ? false : "position"}
                      initial={false}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{
                        duration: reducedMotion ? 0 : PROFILE_SELECTION_MS / 1000,
                        ease: "easeOut",
                      }}
                      key={profile.id}
                      disabled={busy}
                      onClick={() => select(profile)}
                      aria-pressed={selected?.id === profile.id}
                      className="profile-lock-option focus-visible:outline-ring flex w-28 flex-col items-center gap-4 rounded-2xl p-2 focus-visible:outline focus-visible:outline-2"
                    >
                      <span className="profile-lock-avatar">
                        <ProfileAvatar
                          id={profile.avatarId}
                          className="size-20 rounded-full [&_.profile-abstract-sculpture]:scale-90"
                        />
                      </span>
                      <span className="block w-full break-words text-sm font-medium">
                        {profile.name}
                      </span>
                    </motion.button>
                  ))}
              </AnimatePresence>
            </div>
            {mode === "unlock" && selected?.lockEnabled && (
              <form
                key={selected.id}
                onSubmit={submit}
                className="mx-auto max-w-xs space-y-3"
                aria-label={t("profiles.unlockLabel", { name: selected.name })}
              >
                <Label htmlFor="profile-password" className="sr-only">
                  {t("profiles.password")}
                </Label>
                <PasswordInput
                  ref={passwordInput}
                  id="profile-password"
                  aria-invalid={passwordInvalid}
                  aria-describedby={
                    passwordInvalid
                      ? "profile-password-error"
                      : error
                        ? "profile-form-error"
                        : undefined
                  }
                  showLabel={t("profiles.showPassword")}
                  hideLabel={t("profiles.hidePassword")}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setPasswordInvalid(false);
                    setError("");
                  }}
                  placeholder={t("profiles.enterPassword")}
                  className={`h-11 rounded-full border-white/40 bg-white/30 ps-10 text-center backdrop-blur-md dark:border-white/10 dark:bg-white/5 ${passwordInvalid ? "profile-password-invalid" : ""}`}
                  autoComplete="current-password"
                  autoFocus
                  required
                  disabled={busy}
                />
                <Button disabled={busy} type="submit" className="w-full">
                  {t("profiles.unlock")}
                </Button>
                {passwordInvalid && (
                  <span
                    id="profile-password-error"
                    role="alert"
                    className="text-destructive block text-sm leading-relaxed"
                  >
                    {t("profiles.errors.incorrectPassword")}
                  </span>
                )}
                {formError}
                <Button
                  type="button"
                  variant="link"
                  className="text-muted-foreground text-xs"
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    setPasswordInvalid(false);
                    setMode("recover");
                    setPassword("");
                    setConfirmPassword("");
                    setConfirmationInvalid(false);
                  }}
                >
                  {t("profiles.forgotPassword")}
                </Button>
              </form>
            )}
            {mode === "unlock" && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setMode("choose");
                  setPassword("");
                  setPasswordInvalid(false);
                  setError("");
                }}
              >
                {t("profiles.back")}
              </Button>
            )}
            <Button
              variant={hasNoProfiles ? "default" : "ghost"}
              size={hasNoProfiles ? "lg" : "sm"}
              className={hasNoProfiles ? "px-8" : "profile-lock-add text-muted-foreground text-xs"}
              disabled={busy}
              onClick={beginCreateProfile}
            >
              {state?.profiles.length === 0 ? t("profiles.create") : t("profiles.add")}
            </Button>
            {!(mode === "unlock" && selected?.lockEnabled) && formError}
            {state?.pendingDeletions?.map((profile) => (
              <div key={profile.id} className="space-y-2 text-sm">
                <p>{t("profiles.incompleteDeletion", { name: profile.name })}</p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void deleteProfile(profile.name, "", true, profile)}
                >
                  {t("profiles.retryNamedDeletion", { name: profile.name })}
                </Button>
              </div>
            ))}
          </>
        ) : (
          <form
            onSubmit={submit}
            className={`mx-auto space-y-5 text-left ${isProfileEditor ? "max-w-2xl" : "max-w-sm"}`}
          >
            {(mode === "create" || mode === "manage") && (
              <>
                <div className="flex items-start gap-5">
                  <span className="profile-lock-avatar shrink-0">
                    <ProfileAvatar
                      id={avatar}
                      className="size-24 rounded-full [&_.profile-abstract-sculpture]:scale-90"
                    />
                  </span>
                  <div className="min-w-0 max-w-xs flex-1 space-y-2">
                    <Label htmlFor="profile-name">{t("profiles.name")}</Label>
                    <Input
                      id="profile-name"
                      className="h-11 rounded-full bg-white/30 px-4 backdrop-blur-md dark:bg-white/5"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={60}
                      required
                      autoFocus
                    />
                    {(!passwordManagement || removePassword) && (
                      <Button
                        type="button"
                        variant="link"
                        className="text-muted-foreground h-auto px-0 py-2 text-sm"
                        disabled={busy}
                        onClick={() => {
                          setPasswordManagement(true);
                          setRemovePassword(false);
                        }}
                      >
                        {t("profiles.enablePassword")}
                      </Button>
                    )}
                    {passwordManagement && (
                      <div className="space-y-4 pt-2">
                        {passwordFields}
                        {!removePassword && (
                          <Button
                            type="button"
                            variant="link"
                            className="text-muted-foreground h-auto px-0 py-0 text-sm"
                            disabled={busy}
                            onClick={() => {
                              setPassword("");
                              setConfirmPassword("");
                              setConfirmationInvalid(false);
                              if (mode === "manage" && selected?.lockEnabled) {
                                setRemovePassword(true);
                              } else {
                                setPasswordManagement(false);
                                setProof("");
                              }
                            }}
                          >
                            {t("profiles.disablePassword")}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
            {mode === "recover" && passwordFields}
            {isProfileEditor && <ProfileAvatarPicker value={avatar} onChange={setAvatar} />}
            {formActions}
            {formError}
            {mode === "manage" && (
              <section className="border-destructive/25 space-y-2 border-t pt-6">
                <h2 className="font-medium">{t("profiles.delete")}</h2>
                <p className="text-muted-foreground text-sm">{t("profiles.deleteHelp")}</p>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setDeleteOpen(true)}
                >
                  {t("profiles.delete")}
                </Button>
              </section>
            )}
          </form>
        )}
        {deleteOpen && selected && (
          <DeleteProfileDialog
            error={error}
            profile={selected}
            onClose={() => setDeleteOpen(false)}
            onDelete={(confirmation, proof) => void deleteProfile(confirmation, proof)}
          />
        )}
      </div>
    </main>
  );
}
