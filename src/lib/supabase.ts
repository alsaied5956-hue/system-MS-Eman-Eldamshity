/**
 * src/lib/supabase.ts
 * Unified Supabase Client for Next.js and React modules
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_SUPABASE_URL = "https://lzdvmzumwuqycwdecaan.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_B2ATdO71x3VxvOL18ATZtA_bupiDf3l";

function sanitizeUrl(val: string): string {
  if (!val) return "";
  const str = val.trim().replace(/^["']|["']$/g, "");
  const match = str.match(/https?:\/\/[^\s)\]]+/);
  if (match && (str.startsWith("[") || str.includes("]("))) {
    return match[0];
  }
  return str;
}

const rawUrl =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_SUPABASE_URL) ||
  (typeof import.meta !== "undefined" && (import.meta as any)?.env?.NEXT_PUBLIC_SUPABASE_URL) ||
  (typeof import.meta !== "undefined" && (import.meta as any)?.env?.VITE_SUPABASE_URL) ||
  DEFAULT_SUPABASE_URL;

const rawKey =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY) ||
  (typeof import.meta !== "undefined" && (import.meta as any)?.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY) ||
  (typeof import.meta !== "undefined" && (import.meta as any)?.env?.VITE_SUPABASE_ANON_KEY) ||
  DEFAULT_SUPABASE_ANON_KEY;

let supabaseUrl = sanitizeUrl(rawUrl);
let supabaseAnonKey = (rawKey || "").trim().replace(/^["']|["']$/g, "");

if (!supabaseUrl || !supabaseUrl.startsWith("http")) {
  console.error("Critical: Invalid Supabase URL provided:", supabaseUrl);
  supabaseUrl = DEFAULT_SUPABASE_URL;
}

if (!supabaseAnonKey) {
  console.error("Critical: Invalid Supabase Anon Key provided. Falling back to default.");
  supabaseAnonKey = DEFAULT_SUPABASE_ANON_KEY;
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

export default supabase;
