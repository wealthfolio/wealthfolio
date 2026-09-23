// usePairingClaimer
// Self-contained hook for the claimer (new device) pairing flow.
// After key exchange, restoration belongs to the runtime's restore operation;
// this hook only hands off to it and displays it in the pairing window.
// ================================================================

import { beginPairingRestore, logger } from "@/adapters";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as crypto from "../crypto";
import { syncService } from "../services/sync-service";
import { syncStorage } from "../storage/keyring";
import type { ClaimerSession, KeyBundlePayload } from "../types";
import { useRestoreOperation } from "./use-restore-operation";

type ClaimerPhase = "idle" | "connecting" | "claimed" | "confirming" | "restoring" | "error";

export type ClaimerStep =
  | "enter_code"
  | "connecting"
  | "waiting_keys"
  | "confirming"
  | "restoring"
  | "error";

export function usePairingClaimer() {
  const restore = useRestoreOperation();
  const [phase, setPhase] = useState<ClaimerPhase>("idle");
  const [session, setSession] = useState<ClaimerSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guard against auto-proceed firing twice
  const autoProceedFired = useRef(false);

  // Poll for key bundle
  const keyPoll = useQuery({
    queryKey: ["sync", "pairing", "key-poll", session?.pairingId],
    queryFn: () => syncService.pollForKeyBundle(session!),
    enabled: phase === "claimed" && !!session,
    refetchInterval: (query) => (query.state.data?.received ? false : 2000),
    retry: false,
  });

  // Compute SAS from session key
  const sasQuery = useQuery({
    queryKey: ["sync", "pairing", "claimer-sas", session?.sessionKey],
    queryFn: () => crypto.computeSAS(session!.sessionKey),
    enabled: !!session?.sessionKey,
    staleTime: Infinity,
  });

  // One operation per profile: after handing off, the pairing window shows it,
  // including a new attempt started from this window.
  const operation = phase === "restoring" ? restore.operation : null;

  const step: ClaimerStep = useMemo(() => {
    if (phase === "error") return "error";
    if (phase === "restoring") return operation ? "restoring" : "confirming";
    if (phase === "confirming") return "confirming";
    if (phase === "connecting") return "connecting";
    if (phase === "claimed") {
      if (keyPoll.error) return "error";
      return "waiting_keys";
    }
    return "enter_code";
  }, [phase, operation, keyPoll.error]);

  const errorMessage = useMemo(() => {
    if (error) return error;
    if (keyPoll.error) {
      return keyPoll.error instanceof Error ? keyPoll.error.message : String(keyPoll.error);
    }
    return null;
  }, [error, keyPoll.error]);

  // Auto-proceed: when the key bundle arrives, store credentials and hand
  // restoration to the runtime. Key exchange alone never means data arrived.
  useEffect(() => {
    if (phase !== "claimed") return;
    if (!keyPoll.data?.received || !keyPoll.data.keyBundle || !session) return;
    if (autoProceedFired.current) return;
    autoProceedFired.current = true;

    const keyBundle: KeyBundlePayload = keyPoll.data.keyBundle;
    const keyBundleCreatedAt = keyPoll.data.keyBundleCreatedAt;
    setPhase("confirming");

    (async () => {
      try {
        await syncStorage.setE2EECredentials(
          keyBundle.rootKey,
          keyBundle.keyVersion,
          session.deviceId,
          {
            secretKey: session.ephemeralSecretKey,
            publicKey: session.ephemeralPublicKey,
          },
        );

        const proofData = `confirm:${session.pairingId}:${keyBundle.keyVersion}`;
        const proof = await crypto.hmacSha256(session.sessionKey, proofData);
        const freshnessGate = keyBundleCreatedAt ?? session.keyBundleCreatedAt;

        logger.info("[usePairingClaimer] Keys received; starting restore");
        const started = await beginPairingRestore(session.pairingId, proof, freshnessGate);
        restore.settle(started);
        setPhase("restoring");
      } catch (err) {
        logger.error(`[usePairingClaimer] Pairing confirmation error: ${err}`);
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
  }, [phase, keyPoll.data, session, restore]);

  const submitCode = useCallback(async (code: string) => {
    logger.info(`[usePairingClaimer] Submitting code`);
    setError(null);
    autoProceedFired.current = false;
    setPhase("connecting");
    try {
      const s = await syncService.claimPairingSession(code);
      logger.info(`[usePairingClaimer] Session claimed, pairingId=${s.pairingId}`);
      setSession(s);
      setPhase("claimed");
    } catch (err) {
      logger.error(`[usePairingClaimer] Claim error: ${err}`);
      // Usually a mistyped or expired code: keep it on screen to fix.
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  }, []);

  /** Before key exchange this abandons the pairing session. */
  const cancel = useCallback(async () => {
    if (phase !== "restoring" && session) {
      await syncService.cancelPairing(session.pairingId).catch(() => {});
    }
    setSession(null);
    setPhase("idle");
    setError(null);
    autoProceedFired.current = false;
  }, [session, phase]);

  const retry = useCallback(() => {
    setSession(null);
    setPhase("idle");
    setError(null);
    autoProceedFired.current = false;
  }, []);

  return {
    step,
    error: errorMessage,
    sas: sasQuery.data ?? null,
    operation,
    restore,
    submitCode,
    cancel,
    retry,
  };
}
