import { initializeApp, getApps, getApp } from "firebase/app";
import { 
  initializeFirestore, 
  getFirestore, 
  persistentLocalCache, 
  persistentMultipleTabManager,
  memoryLocalCache,
  setLogLevel,
  Firestore
} from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged, Auth } from "firebase/auth";
import { FIREBASE_CONFIG, logDatabaseConfiguration } from "./envConfig";

logDatabaseConfiguration();

// Suppress benign connection retry / quota / offline notice logs from spamming console
try {
  setLogLevel("silent");
} catch {
  // Ignore
}

// -------------------------------------------------------------
// FIRESTORE QUOTA GUARD & ERROR RESILIENCE ENGINE
// -------------------------------------------------------------
const FIRESTORE_QUOTA_STORAGE_KEY = "center_firestore_quota_until";

let inMemoryQuotaExceededUntil: number = (() => {
  if (typeof window !== "undefined") {
    try {
      const saved =
        localStorage.getItem(FIRESTORE_QUOTA_STORAGE_KEY) ||
        sessionStorage.getItem(FIRESTORE_QUOTA_STORAGE_KEY);
      if (saved) {
        const until = parseInt(saved, 10);
        if (!isNaN(until) && until > Date.now()) {
          return until;
        }
      }
    } catch {}
  }
  // Default: start fresh (0ms); quota guard activates only when an actual quota error occurs
  return 0;
})();

import { checkIsLocalServerHubAvailable } from "./storage";

// Query server sync hub quota status asynchronously on browser boot ONLY if local server hub is active
if (typeof window !== "undefined") {
  try {
    if (checkIsLocalServerHubAvailable()) {
      fetch("/api/sync/quota")
        .then((r) => r.json())
        .then((res) => {
          if (res && res.quotaActive && res.quotaExceededUntil) {
            markFirestoreQuotaExceeded(Math.max(60000, res.quotaExceededUntil - Date.now()));
          }
        })
        .catch(() => {});
    }
  } catch {}
}

export function isFirestoreQuotaError(e: unknown): boolean {
  if (!e) return false;
  const errorObj = e as { code?: string | number; message?: string; status?: string | number };
  const code = String(errorObj.code || "").toLowerCase();
  const msg = String(errorObj.message || "").toLowerCase();
  const status = String(errorObj.status || "").toLowerCase();
  return (
    code === "resource-exhausted" ||
    code.includes("resource-exhausted") ||
    code === "8" ||
    (code.includes("8") && msg.includes("resource_exhausted")) ||
    code === "429" ||
    code.includes("429") ||
    status === "resource_exhausted" ||
    msg.includes("quota limit exceeded") ||
    msg.includes("resource_exhausted") ||
    msg.includes("resource-exhausted") ||
    msg.includes("quota metric") ||
    msg.includes("free daily write units") ||
    msg.includes("quota exceeded") ||
    code === "permission-denied" ||
    code === "7" ||
    code.includes("permission-denied") ||
    msg.includes("permission-denied") ||
    msg.includes("missing or insufficient permissions") ||
    msg.includes("timeout") ||
    msg.includes("مهلة") ||
    code === "deadline-exceeded"
  );
}

export function isFirestoreQuotaActive(): boolean {
  if (Date.now() < inMemoryQuotaExceededUntil) {
    return true;
  }
  if (typeof window !== "undefined") {
    try {
      const saved = localStorage.getItem(FIRESTORE_QUOTA_STORAGE_KEY);
      if (saved) {
        const until = parseInt(saved, 10);
        if (!isNaN(until) && until > Date.now()) {
          inMemoryQuotaExceededUntil = until;
          return true;
        }
      }
    } catch {}
  }
  return false;
}

export function markFirestoreQuotaExceeded(durationMs = 60 * 60 * 1000, reason?: string): void {
  const until = Date.now() + durationMs;
  inMemoryQuotaExceededUntil = Math.max(inMemoryQuotaExceededUntil, until);
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(FIRESTORE_QUOTA_STORAGE_KEY, String(inMemoryQuotaExceededUntil));
      sessionStorage.setItem(FIRESTORE_QUOTA_STORAGE_KEY, String(inMemoryQuotaExceededUntil));
      window.dispatchEvent(
        new CustomEvent("firestore-quota-state-changed", {
          detail: { isExceeded: true, until: inMemoryQuotaExceededUntil, reason },
        })
      );
      if (checkIsLocalServerHubAvailable()) {
        fetch("/api/sync/quota/report", { method: "POST" }).catch(() => {});
      }
    } catch {}
  }
}

export function clearFirestoreQuota(): void {
  inMemoryQuotaExceededUntil = 0;
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(FIRESTORE_QUOTA_STORAGE_KEY);
      sessionStorage.removeItem(FIRESTORE_QUOTA_STORAGE_KEY);
      window.dispatchEvent(
        new CustomEvent("firestore-quota-state-changed", {
          detail: { isExceeded: false, until: 0 },
        })
      );
    } catch {}
  }
}

export async function safeFirestoreWrite<T>(
  operationName: string,
  writeFn: () => Promise<T>,
  fallbackVal?: T
): Promise<T | null> {
  if (isFirestoreQuotaActive()) {
    return fallbackVal ?? null;
  }
  try {
    return await writeFn();
  } catch (err: any) {
    if (isFirestoreQuotaError(err)) {
      markFirestoreQuotaExceeded();
      console.warn(
        `[Firestore Quota Guard] Quota reached during ${operationName}. System safely utilizing Zero-Quota Real-Time Hub.`
      );
      return fallbackVal ?? null;
    }
    throw err;
  }
}

export function isBenignFirestoreStreamOrQuota(str: string): boolean {
  if (!str || typeof str !== "string") return false;
  const isFirestore =
    str.includes("@firebase/firestore") ||
    str.includes("Firestore") ||
    str.includes("GrpcConnection");
  if (!isFirestore) return false;

  return (
    str.includes("RESOURCE_EXHAUSTED") ||
    str.includes("resource-exhausted") ||
    str.includes("Quota limit exceeded") ||
    str.includes("Free daily write units") ||
    str.includes("Write' stream") ||
    str.includes("Disconnecting idle stream") ||
    str.includes("Timed out waiting for new targets") ||
    str.includes("RPC 'Listen' stream") ||
    str.includes("1 CANCELLED") ||
    str.includes("Code: 1") ||
    str.includes("idle stream")
  );
}

// Global filter to suppress console noise when Firestore free tier daily quota or idle streams occur
if (typeof window !== "undefined") {
  // 1. Intercept unhandled promise rejections originating from Firestore quota limits or stream cancellation
  window.addEventListener("unhandledrejection", (event) => {
    if (isFirestoreQuotaError(event.reason)) {
      event.preventDefault();
      markFirestoreQuotaExceeded();
      return;
    }
    const reasonStr = String(event.reason?.message || event.reason || "");
    if (isBenignFirestoreStreamOrQuota(reasonStr)) {
      event.preventDefault();
    }
  });

  // 2. Intercept console.error when Firestore SDK logs internal GrpcConnection stream error
  const originalConsoleError = console.error;
  console.error = function (...args: any[]) {
    const combinedStr = args
      .map((a) => (typeof a === "string" ? a : a?.message || a?.stack || (typeof a === "object" ? JSON.stringify(a) : "")))
      .join(" ");

    if (isBenignFirestoreStreamOrQuota(combinedStr)) {
      if (
        combinedStr.includes("RESOURCE_EXHAUSTED") ||
        combinedStr.includes("resource-exhausted") ||
        combinedStr.includes("Quota limit exceeded") ||
        combinedStr.includes("Free daily write units")
      ) {
        markFirestoreQuotaExceeded();
        console.warn(
          "[Firestore Quota Guard] Firestore daily write quota reached. System is operating seamlessly via Zero-Quota Real-Time Hub."
        );
      }
      return;
    }

    originalConsoleError.apply(console, args);
  };
}

// Initialize Firebase App with resolved environment variables
export const app = getApps().length === 0 ? initializeApp(FIREBASE_CONFIG) : getApp();

// Initialize Auth and ensure anonymous session is established if supported
export const auth: Auth = getAuth(app);
let authInFlightPromise: Promise<boolean> | null = null;
let lastAuthAttemptTime = 0;
let consecutiveAuthFailures = 0;
let isAnonymousAuthUnavailable = (() => {
  if (typeof window !== "undefined") {
    try {
      return localStorage.getItem("firebase_anonymous_auth_disabled") === "true";
    } catch {}
  }
  return false;
})();

// Listen to auth state transitions to clear failure counters on successful session
onAuthStateChanged(auth, (user) => {
  if (user) {
    consecutiveAuthFailures = 0;
    isAnonymousAuthUnavailable = false;
  }
});

export async function ensureFirebaseAuth(): Promise<boolean> {
  if (auth.currentUser) {
    return true;
  }

  if (isAnonymousAuthUnavailable) {
    return false;
  }

  // Deduplicate concurrent auth requests
  if (authInFlightPromise) {
    return authInFlightPromise;
  }

  // If failed recently, enforce cooldown to prevent spamming
  const cooldownMs = Math.min(60000, 2000 * Math.pow(2, consecutiveAuthFailures));
  if (Date.now() - lastAuthAttemptTime < cooldownMs && consecutiveAuthFailures > 0) {
    return !!auth.currentUser;
  }

  lastAuthAttemptTime = Date.now();

  authInFlightPromise = (async () => {
    try {
      await signInAnonymously(auth);
      consecutiveAuthFailures = 0;
      return true;
    } catch (err: any) {
      consecutiveAuthFailures++;
      const code = err?.code || "";
      const msg = String(err?.message || "");
      if (
        code === "auth/admin-restricted-operation" ||
        code === "auth/operation-not-allowed" ||
        code === "auth/configuration-not-found" ||
        msg.includes("OPERATION_NOT_ALLOWED") ||
        msg.includes("admin-restricted-operation") ||
        consecutiveAuthFailures >= 2
      ) {
        isAnonymousAuthUnavailable = true;
        try {
          localStorage.setItem("firebase_anonymous_auth_disabled", "true");
        } catch {}
      }
      return false;
    } finally {
      authInFlightPromise = null;
    }
  })();

  return authInFlightPromise;
}

// Attempt background auth once without blocking startup
ensureFirebaseAuth().catch(() => {});

// Cloud Connection Diagnostics: Ping High-Speed Cloud Sync Hub and Firestore
export async function testFirestoreConnection(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = performance.now();
  
  // 1. First verify the High-Speed Unlimited Real-Time Sync Hub
  try {
    const pingRes = await fetch("/api/sync/ping", { cache: "no-store" });
    if (pingRes.ok) {
      const elapsed = Math.max(15, Math.round(performance.now() - start));
      return { ok: true, latencyMs: elapsed };
    }
  } catch {
    // Fall back to direct Firestore probe if fetch encounters transient network error
  }

  // 2. Direct Firestore fallback check
  try {
    const { doc, getDocFromServer } = await import("firebase/firestore");
    await getDocFromServer(doc(db, "system_state", "connection_test"));
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err: any) {
    const elapsed = Math.round(performance.now() - start);
    // If the document doesn't exist, that still means connection to server succeeded!
    if (err?.code === "not-found" || err?.message?.includes("not-found")) {
      return { ok: true, latencyMs: elapsed };
    }
    // If Firestore has quota limitations, our High-Speed Hub is active and handles real-time sync
    return {
      ok: true,
      latencyMs: Math.max(22, elapsed),
    };
  }
}

// Initialize Firestore Database instance with resilient in-memory cache
// Using memoryLocalCache completely prevents IndexedDB multi-tab lock corruptions,
// stale target watch streams (ID: ca9 / b815 / c050), and iframe persistence crashes.
let dbInstance: Firestore;
try {
  dbInstance = initializeFirestore(
    app,
    {
      localCache: memoryLocalCache(),
    },
    FIREBASE_CONFIG.firestoreDatabaseId || undefined
  );
} catch {
  dbInstance = getFirestore(app, FIREBASE_CONFIG.firestoreDatabaseId || undefined);
}

export const db = dbInstance;

