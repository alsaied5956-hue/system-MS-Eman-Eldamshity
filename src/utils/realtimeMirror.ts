/**
 * src/utils/realtimeMirror.ts
 *
 * Global Postgres Realtime CDC (Change Data Capture) Mirror.
 *
 * Subscribes to `postgres_changes` (INSERT / UPDATE / DELETE) across every
 * primary management table and emits normalized, barcode-resolved deltas to
 * subscribers. This is the authoritative "Realtime Mirroring" layer that keeps
 * all admin/supervisor devices in sync directly from the database write-ahead
 * log — independent of (and complementary to) the existing broadcast hub.
 *
 * Design guarantees:
 *  - Idempotent by construction: consumers apply SET/REPLACE semantics, never
 *    accumulate, so re-delivery (including on the originating device) is safe.
 *  - student_id -> barcode resolution is handled here so consumers receive a
 *    ready-to-use barcode for payments / homework / attendance rows.
 *  - Zero coupling: it never mutates app state itself and never touches the
 *    broadcast hub, Firebase, PWA, or FCM pipelines.
 */

import { supabase } from "./supabaseClient";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type MirrorTable =
  | "students"
  | "homework"
  | "payments"
  | "attendance_logs"
  | "parent_accounts"
  | "system_settings";

export type MirrorEventType = "INSERT" | "UPDATE" | "DELETE";

export interface MirrorDelta {
  table: MirrorTable;
  type: MirrorEventType;
  /** Full new row for INSERT/UPDATE, null for DELETE */
  row: any | null;
  /** Old row for DELETE/UPDATE (usually only primary key columns for DELETE) */
  old: any | null;
  /** Resolved student barcode when the row is tied to a student, else null */
  barcode: string | null;
}

type MirrorListener = (delta: MirrorDelta) => void;

const MIRROR_TABLES: MirrorTable[] = [
  "students",
  "homework",
  "payments",
  "attendance_logs",
  "parent_accounts",
  "system_settings",
];

const listeners = new Set<MirrorListener>();
let channel: RealtimeChannel | null = null;
let indexPrimed = false;

// student_id (uuid) -> barcode, kept warm from the students CDC stream
const idToBarcode = new Map<string, string>();

/** Pre-load the id -> barcode index once so payment/homework deltas resolve instantly. */
async function primeStudentIndex(): Promise<void> {
  if (indexPrimed) return;
  indexPrimed = true;
  try {
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("students")
        .select("id, barcode")
        .range(from, from + pageSize - 1);
      if (error || !data || data.length === 0) break;
      data.forEach((r: any) => {
        if (r.id && r.barcode) idToBarcode.set(r.id, String(r.barcode).trim());
      });
      if (data.length < pageSize) break;
      from += pageSize;
    }
  } catch {
    // Non-fatal: fall back to per-row lookups
  }
}

/** Resolve the student barcode for any incoming row across the primary tables. */
async function resolveBarcode(table: MirrorTable, row: any, old: any): Promise<string | null> {
  // students: the row itself carries the barcode; deletes carry only the pk id.
  if (table === "students") {
    if (row?.barcode) return String(row.barcode).trim();
    const delId = old?.id ?? row?.id;
    if (delId && idToBarcode.has(delId)) return idToBarcode.get(delId)!;
    return null;
  }

  // parent_accounts / system_settings are not student-scoped rows.
  if (table === "parent_accounts" || table === "system_settings") {
    const src = row || old;
    return src?.barcode ? String(src.barcode).trim() : null;
  }

  // payments / homework / attendance_logs are child rows keyed by student_id.
  const src = row || old;
  if (!src) return null;
  if (src.barcode) return String(src.barcode).trim();

  const sid = src.student_id;
  if (!sid) return null;
  if (idToBarcode.has(sid)) return idToBarcode.get(sid)!;

  try {
    const { data } = await supabase.from("students").select("barcode").eq("id", sid).maybeSingle();
    if (data?.barcode) {
      const b = String(data.barcode).trim();
      idToBarcode.set(sid, b);
      return b;
    }
  } catch {
    // ignore — best-effort resolution
  }
  return null;
}

function keepStudentIndexWarm(type: MirrorEventType, row: any, old: any): void {
  if (type === "DELETE") {
    const id = old?.id ?? row?.id;
    if (id) idToBarcode.delete(id);
    return;
  }
  if (row?.id && row?.barcode) idToBarcode.set(row.id, String(row.barcode).trim());
}

async function handlePayload(table: MirrorTable, payload: any): Promise<void> {
  const type = (payload?.eventType || payload?.type) as MirrorEventType;
  const row = payload?.new && Object.keys(payload.new).length ? payload.new : null;
  const old = payload?.old && Object.keys(payload.old).length ? payload.old : null;

  if (table === "students") keepStudentIndexWarm(type, row, old);

  let barcode: string | null = null;
  try {
    barcode = await resolveBarcode(table, row, old);
  } catch {
    barcode = null;
  }

  const delta: MirrorDelta = { table, type, row, old, barcode };
  listeners.forEach((fn) => {
    try {
      fn(delta);
    } catch (e) {
      console.warn("[Realtime Mirror CDC] listener error:", e);
    }
  });
}

/** Start the global CDC channel (idempotent — safe to call more than once). */
export function startRealtimeMirror(): RealtimeChannel {
  if (channel) return channel;

  void primeStudentIndex();

  channel = supabase.channel("realtime-mirror-cdc");
  for (const table of MIRROR_TABLES) {
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table },
      (payload) => {
        void handlePayload(table, payload);
      }
    );
  }
  channel.subscribe((status) => {
    console.log(`[Realtime Mirror CDC] Channel status: ${status}`);
  });
  return channel;
}

/** Subscribe to normalized CDC deltas. Returns an unsubscribe function. */
export function subscribeToRealtimeMirror(listener: MirrorListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tear down the CDC channel entirely (used only on full app teardown). */
export function stopRealtimeMirror(): void {
  if (channel) {
    try {
      supabase.removeChannel(channel);
    } catch {
      // ignore
    }
    channel = null;
  }
}
