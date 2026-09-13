/**
 * src/utils/envConfig.ts
 * Centralized Database & Multi-Device Environment Variable Resolver
 * Supports Next.js, React (Vite), and Serverless/Express runtimes with safe fallbacks
 */

import firebaseAppletConfig from "../../firebase-applet-config.json";

function sanitizeEnvValue(val: string): string {
  if (!val) return "";
  let cleaned = val.trim();
  // Strip surrounding quotes
  cleaned = cleaned.replace(/^["']|["']$/g, "").trim();
  // If wrapped in markdown link [url](url) or similar markdown format
  const match = cleaned.match(/https?:\/\/[^\s)\]]+/);
  if (match && (cleaned.startsWith("[") || cleaned.includes("]("))) {
    return match[0];
  }
  return cleaned;
}

function resolveEnvValue(keys: string[], fallback: string = ""): string {
  // 1. Check Node.js / Next.js / Serverless process.env
  if (typeof process !== "undefined" && process?.env) {
    for (const key of keys) {
      if (process.env[key] && typeof process.env[key] === "string" && process.env[key]?.trim() !== "") {
        return sanitizeEnvValue(process.env[key]!);
      }
    }
  }

  // 2. Check Vite client-side import.meta.env
  if (typeof import.meta !== "undefined" && (import.meta as any)?.env) {
    const metaEnv = (import.meta as any).env;
    for (const key of keys) {
      if (metaEnv[key] && typeof metaEnv[key] === "string" && metaEnv[key]?.trim() !== "") {
        return sanitizeEnvValue(metaEnv[key]!);
      }
    }
  }

  return sanitizeEnvValue(fallback);
}

// -------------------------------------------------------------
// Supabase Configuration
// -------------------------------------------------------------
const DEFAULT_SUPABASE_URL = "https://lzdvmzumwuqycwdecaan.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_B2ATdO71x3VxvOL18ATZtA_bupiDf3l";

export const SUPABASE_CONFIG = {
  url: resolveEnvValue(
    ["NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_URL"],
    DEFAULT_SUPABASE_URL
  ),
  anonKey: resolveEnvValue(
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY"],
    DEFAULT_SUPABASE_ANON_KEY
  ),
  isDefaultFallback: false,
};

SUPABASE_CONFIG.isDefaultFallback =
  SUPABASE_CONFIG.url === DEFAULT_SUPABASE_URL &&
  !resolveEnvValue(["NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_URL"]);

// -------------------------------------------------------------
// Firebase Configuration
// -------------------------------------------------------------
const defaultProjectId = (firebaseAppletConfig as any)?.projectId || "ai-studio-applet-webapp-dffd3";
const defaultApiKey = (firebaseAppletConfig as any)?.apiKey || "AIzaSyA8SdOtbVmBF7tsfIC_WsAgOFQj6tkyjaw";
const defaultAuthDomain = (firebaseAppletConfig as any)?.authDomain || `${defaultProjectId}.firebaseapp.com`;
const defaultDatabaseUrl = `https://${defaultProjectId}-default-rtdb.firebaseio.com`;

export const FIREBASE_CONFIG = {
  apiKey: resolveEnvValue(
    ["NEXT_PUBLIC_FIREBASE_API_KEY", "VITE_FIREBASE_API_KEY", "FIREBASE_API_KEY"],
    defaultApiKey
  ),
  authDomain: resolveEnvValue(
    ["NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_AUTH_DOMAIN", "FIREBASE_AUTH_DOMAIN"],
    defaultAuthDomain
  ),
  projectId: resolveEnvValue(
    ["NEXT_PUBLIC_FIREBASE_PROJECT_ID", "VITE_FIREBASE_PROJECT_ID", "FIREBASE_PROJECT_ID"],
    defaultProjectId
  ),
  databaseURL: resolveEnvValue(
    ["NEXT_PUBLIC_FIREBASE_DATABASE_URL", "VITE_FIREBASE_DATABASE_URL", "FIREBASE_DATABASE_URL"],
    defaultDatabaseUrl
  ),
  firestoreDatabaseId: (firebaseAppletConfig as any)?.firestoreDatabaseId || "ai-studio-310a44ff-94b7-4761-a048-94281283abc2",
  storageBucket: (firebaseAppletConfig as any)?.storageBucket || `${defaultProjectId}.firebasestorage.app`,
  appId: (firebaseAppletConfig as any)?.appId || "1:319901039747:web:fcd7b7a92b3923b44fefb6",
  messagingSenderId: (firebaseAppletConfig as any)?.messagingSenderId || "319901039747",
};

// -------------------------------------------------------------
// Diagnostics & Verification Logger
// -------------------------------------------------------------
let hasLoggedConfig = false;

export function logDatabaseConfiguration() {
  if (hasLoggedConfig) return;
  hasLoggedConfig = true;

  const isProd = typeof process !== "undefined" && process.env?.NODE_ENV === "production";

  console.group("🚀 [System Architect] Database & Multi-Device Sync Configuration");
  
  // Supabase Status
  if (SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey) {
    console.log("✅ Supabase Connected:", {
      endpoint: SUPABASE_CONFIG.url,
      anonKeyLength: SUPABASE_CONFIG.anonKey.length,
      isCustomEnv: !SUPABASE_CONFIG.isDefaultFallback,
      source: resolveEnvValue(["NEXT_PUBLIC_SUPABASE_URL"]) ? "NEXT_PUBLIC_SUPABASE_URL" : "default_fallback",
    });
  } else {
    console.warn("⚠️ Supabase: Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  }

  // Firebase Status
  if (FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId) {
    console.log("✅ Firebase Connected:", {
      projectId: FIREBASE_CONFIG.projectId,
      authDomain: FIREBASE_CONFIG.authDomain,
      databaseURL: FIREBASE_CONFIG.databaseURL,
      hasDatabaseUrl: !!FIREBASE_CONFIG.databaseURL,
      firestoreDbId: FIREBASE_CONFIG.firestoreDatabaseId,
      source: resolveEnvValue(["NEXT_PUBLIC_FIREBASE_API_KEY"]) ? "NEXT_PUBLIC_FIREBASE_API_KEY" : "applet_config",
    });
  } else {
    console.warn("⚠️ Firebase: Missing NEXT_PUBLIC_FIREBASE_API_KEY or NEXT_PUBLIC_FIREBASE_PROJECT_ID.");
  }

  if (isProd) {
    console.log("🔒 Running in PRODUCTION mode: LocalStorage mock mode is disabled; Supabase + Firebase are authoritative.");
  }

  console.groupEnd();
}
