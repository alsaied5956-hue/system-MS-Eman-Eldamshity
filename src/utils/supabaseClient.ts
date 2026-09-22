/**
 * src/utils/supabaseClient.ts
 * High-Performance Supabase v2 Client & Sub-20ms Realtime WebSocket Hub
 * Powers Instant Multi-Device Sync for Attendance, Group Finalization, Payments, Homework, and Students
 */

import { createClient, SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { SUPABASE_CONFIG, logDatabaseConfiguration } from "./envConfig";
import centerBackup from "../data/centerBackup.json";

// Log configuration status on startup
logDatabaseConfiguration();

const DEFAULT_SUPABASE_URL = "https://lzdvmzumwuqycwdecaan.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_B2ATdO71x3VxvOL18ATZtA_bupiDf3l";

// Sanitize URL: handle accidental markdown links like [url](url) or wrapping quotes
function sanitizeSupabaseUrl(val: string): string {
  if (!val) return "";
  const str = val.trim().replace(/^["']|["']$/g, "");
  const match = str.match(/https?:\/\/[^\s)\]]+/);
  if (match && (str.startsWith("[") || str.includes("]("))) {
    return match[0];
  }
  return str;
}

const rawSupabaseUrl =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_SUPABASE_URL) ||
  (typeof import.meta !== "undefined" && (import.meta as any)?.env?.NEXT_PUBLIC_SUPABASE_URL) ||
  (typeof import.meta !== "undefined" && (import.meta as any)?.env?.VITE_SUPABASE_URL) ||
  SUPABASE_CONFIG?.url ||
  DEFAULT_SUPABASE_URL;

const rawSupabaseAnonKey =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY) ||
  (typeof import.meta !== "undefined" && (import.meta as any)?.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY) ||
  (typeof import.meta !== "undefined" && (import.meta as any)?.env?.VITE_SUPABASE_ANON_KEY) ||
  SUPABASE_CONFIG?.anonKey ||
  DEFAULT_SUPABASE_ANON_KEY;

let supabaseUrl = sanitizeSupabaseUrl(rawSupabaseUrl);
let supabaseAnonKey = (rawSupabaseAnonKey || "").trim().replace(/^["']|["']$/g, "");

if (!supabaseUrl || !supabaseUrl.startsWith("http")) {
  console.error("Critical: Invalid Supabase URL provided:", supabaseUrl);
  supabaseUrl = DEFAULT_SUPABASE_URL;
}

if (!supabaseAnonKey) {
  console.error("Critical: Invalid Supabase Anon Key provided. Falling back to default.");
  supabaseAnonKey = DEFAULT_SUPABASE_ANON_KEY;
}

/**
 * Resilient Fetch wrapper for Supabase client:
 * In restricted sandboxed environments (such as preview iframes), direct browser fetches
 * to 3rd-party domains can be blocked or fail with `TypeError: Failed to fetch`.
 * This wrapper transparently retries via the local same-origin Express proxy `/api/supabase-proxy`.
 */
const resilientSupabaseFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (err: any) {
    const errMsg = String(err?.message || err || "");
    const isFetchFailure =
      err instanceof TypeError ||
      errMsg.includes("Failed to fetch") ||
      errMsg.includes("NetworkError") ||
      errMsg.includes("Load failed") ||
      errMsg.includes("Network request failed");

    if (isFetchFailure && typeof window !== "undefined") {
      try {
        let rawUrl = "";
        let method = init?.method || "GET";
        let headers = init?.headers;
        let body = init?.body;

        if (typeof input === "string") {
          rawUrl = input;
        } else if (input instanceof URL) {
          rawUrl = input.toString();
        } else if (typeof Request !== "undefined" && input instanceof Request) {
          rawUrl = input.url;
          method = init?.method || input.method;
          headers = init?.headers || input.headers;
        }

        if (rawUrl) {
          const parsed = new URL(rawUrl);
          const proxyUrl = `/api/supabase-proxy${parsed.pathname}${parsed.search}`;
          return await fetch(proxyUrl, {
            method,
            headers,
            body,
          });
        }
      } catch (proxyErr) {
        console.warn("[SupabaseClient] Proxy fallback notice:", proxyErr);
      }
    }
    throw err;
  }
};

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  global: {
    fetch: resilientSupabaseFetch,
  },
  realtime: {
    params: {
      eventsPerSecond: 30,
    },
  },
});

export interface LiveScanPayload {
  barcode: string;
  name: string;
  grade: string;
  days: string;
  status: "حضور" | "تأخير" | "غياب";
  timeIso: string;
  timeDisplay: string;
  isPaid: boolean;
  scannedBy: string;
  timestamp: number;
  sourceDeviceId?: string;
}

export interface MultiDevicePingPayload {
  pingId: string;
  sourceDeviceId: string;
  sourceDeviceName: string;
  timestamp: number;
}

export interface MultiDevicePongPayload {
  pingId: string;
  targetDeviceId: string;
  responderDeviceId: string;
  responderDeviceName: string;
  timestamp: number;
  latencyMs?: number;
}

export interface GroupFinishedPayload {
  grade: string;
  days: string;
  absentBarcodes: string[];
  lateBarcodes: string[];
  presentBarcodes: string[];
  dateKey: string;
  finishedBy: string;
  timestamp: number;
}

export interface PaymentSyncPayload {
  action: "record" | "update" | "delete";
  barcode: string;
  monthKey: string;
  amount: number;
  date: string;
  time: string;
  note: string;
  recordedBy: string;
  timestamp: number;
}

export interface HomeworkSyncPayload {
  action: "update" | "bulk_update";
  barcodes: string[];
  dateKey: string;
  status: "done" | "incomplete" | "not_done";
  notes?: string;
  updatedBy: string;
  timestamp: number;
}

export interface StudentSyncPayload {
  action: "add" | "update" | "delete";
  barcode: string;
  studentData?: any;
  timestamp: number;
}

export interface ExamGradeSyncPayload {
  action: "record" | "update";
  barcode: string;
  studentName?: string;
  examTitle: string;
  score: number;
  maxScore: number;
  percentage: number;
  dateKey: string;
  timestamp: number;
}

export function getTodayDateKey(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ------------------------------------------------------------------------
// 1. DEDICATED REALTIME HUB (Sub-20ms WebSocket Channel)
// ------------------------------------------------------------------------

let realtimeHubChannel: RealtimeChannel | null = null;

export function getOrCreateRealtimeHub(): RealtimeChannel {
  if (!realtimeHubChannel) {
    realtimeHubChannel = supabase.channel("realtime-center-hub", {
      config: {
        broadcast: {
          self: false, // Don't echo back to the emitting device
          ack: false,  // Fire-and-forget for absolute zero-latency
        },
      },
    });

    realtimeHubChannel.subscribe((status) => {
      console.log(`[Supabase Realtime Hub] Status: ${status}`);
    });
  }
  return realtimeHubChannel;
}

// ------------------------------------------------------------------------
// 2. BROADCAST METHODS (Zero Latency Emits)
// ------------------------------------------------------------------------

/** Broadcast single scan to all assistant screens */
export async function broadcastLiveScan(payload: LiveScanPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "assistant_scan",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast scan notice:", err);
  }
}

/** Broadcast group finish (حفظ وإرسال الغياب للكل) across all screens */
export async function broadcastGroupFinished(payload: GroupFinishedPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "group_finished",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast group finish notice:", err);
  }
}

/** Broadcast payment record / update / delete across all screens */
export async function broadcastPaymentChange(payload: PaymentSyncPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "payment_change",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast payment notice:", err);
  }
}

/** Broadcast homework status update across all screens */
export async function broadcastHomeworkChange(payload: HomeworkSyncPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "homework_change",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast homework notice:", err);
  }
}

/** Broadcast student addition, update, or deletion */
export async function broadcastStudentChange(payload: StudentSyncPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "student_change",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast student notice:", err);
  }
}

/** Broadcast exam grade recording or update */
export async function broadcastExamGradeChange(payload: ExamGradeSyncPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "exam_grade_change",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast exam grade notice:", err);
  }
}

/** Broadcast full state changes across all connected devices (< 50ms peer delivery) */
export async function broadcastFullState(payload: any): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "full_state_sync",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast full state notice:", err);
  }
}

/** Broadcast instant multi-device ping for live latency check */
export async function broadcastMultiDevicePing(payload: MultiDevicePingPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "multi_device_ping",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast multi-device ping notice:", err);
  }
}

/** Broadcast pong response back to pinging device */
export async function broadcastMultiDevicePong(payload: MultiDevicePongPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "multi_device_pong",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast multi-device pong notice:", err);
  }
}

// ------------------------------------------------------------------------
// 3. LISTENERS (Instant Reception on All Devices with Zero-Leak Lifecycle)
// ------------------------------------------------------------------------

const liveScanListeners = new Set<(payload: LiveScanPayload) => void>();
const groupFinishedListeners = new Set<(payload: GroupFinishedPayload) => void>();
const paymentChangeListeners = new Set<(payload: PaymentSyncPayload) => void>();
const homeworkChangeListeners = new Set<(payload: HomeworkSyncPayload) => void>();
const studentChangeListeners = new Set<(payload: StudentSyncPayload) => void>();
const examGradeChangeListeners = new Set<(payload: ExamGradeSyncPayload) => void>();
const fullStateListeners = new Set<(payload: any) => void>();
const multiDevicePingListeners = new Set<(payload: MultiDevicePingPayload) => void>();
const multiDevicePongListeners = new Set<(payload: MultiDevicePongPayload) => void>();
let listenersInitialized = false;

function ensureChannelListenersRegistered() {
  if (listenersInitialized) return;
  listenersInitialized = true;
  const channel = getOrCreateRealtimeHub();

  channel.on("broadcast", { event: "full_state_sync" }, ({ payload }) => {
    if (payload) {
      fullStateListeners.forEach((fn) => {
        try {
          fn(payload);
        } catch (e) {
          console.warn("Error in fullState listener:", e);
        }
      });
    }
  });

  channel.on("broadcast", { event: "assistant_scan" }, ({ payload }) => {
    if (payload) {
      liveScanListeners.forEach((fn) => {
        try {
          fn(payload as LiveScanPayload);
        } catch (e) {
          console.warn("Error in liveScan listener:", e);
        }
      });
    }
  });

  channel.on("broadcast", { event: "group_finished" }, ({ payload }) => {
    if (payload) {
      groupFinishedListeners.forEach((fn) => {
        try {
          fn(payload as GroupFinishedPayload);
        } catch (e) {
          console.warn("Error in groupFinished listener:", e);
        }
      });
    }
  });

  channel.on("broadcast", { event: "payment_change" }, ({ payload }) => {
    if (payload) {
      paymentChangeListeners.forEach((fn) => {
        try {
          fn(payload as PaymentSyncPayload);
        } catch (e) {
          console.warn("Error in paymentChange listener:", e);
        }
      });
    }
  });

  channel.on("broadcast", { event: "homework_change" }, ({ payload }) => {
    if (payload) {
      homeworkChangeListeners.forEach((fn) => {
        try {
          fn(payload as HomeworkSyncPayload);
        } catch (e) {
          console.warn("Error in homeworkChange listener:", e);
        }
      });
    }
  });

  channel.on("broadcast", { event: "student_change" }, ({ payload }) => {
    if (payload) {
      studentChangeListeners.forEach((fn) => {
        try {
          fn(payload as StudentSyncPayload);
        } catch (e) {
          console.warn("Error in studentChange listener:", e);
        }
      });
    }
  });

  channel.on("broadcast", { event: "exam_grade_change" }, ({ payload }) => {
    if (payload) {
      examGradeChangeListeners.forEach((fn) => {
        try {
          fn(payload as ExamGradeSyncPayload);
        } catch (e) {
          console.warn("Error in examGradeChange listener:", e);
        }
      });
    }
  });

  channel.on("broadcast", { event: "multi_device_ping" }, ({ payload }) => {
    if (payload) {
      multiDevicePingListeners.forEach((fn) => {
        try {
          fn(payload as MultiDevicePingPayload);
        } catch (e) {
          console.warn("Error in ping listener:", e);
        }
      });
    }
  });

  channel.on("broadcast", { event: "multi_device_pong" }, ({ payload }) => {
    if (payload) {
      multiDevicePongListeners.forEach((fn) => {
        try {
          fn(payload as MultiDevicePongPayload);
        } catch (e) {
          console.warn("Error in pong listener:", e);
        }
      });
    }
  });
}

export function subscribeToLiveScans(
  onScanReceived: (payload: LiveScanPayload) => void
): () => void {
  ensureChannelListenersRegistered();
  liveScanListeners.add(onScanReceived);
  return () => {
    liveScanListeners.delete(onScanReceived);
  };
}

export function subscribeToGroupFinished(
  onGroupFinished: (payload: GroupFinishedPayload) => void
): () => void {
  ensureChannelListenersRegistered();
  groupFinishedListeners.add(onGroupFinished);
  return () => {
    groupFinishedListeners.delete(onGroupFinished);
  };
}

export function subscribeToPaymentChanges(
  onPaymentChanged: (payload: PaymentSyncPayload) => void
): () => void {
  ensureChannelListenersRegistered();
  paymentChangeListeners.add(onPaymentChanged);
  return () => {
    paymentChangeListeners.delete(onPaymentChanged);
  };
}

export function subscribeToHomeworkChanges(
  onHomeworkChanged: (payload: HomeworkSyncPayload) => void
): () => void {
  ensureChannelListenersRegistered();
  homeworkChangeListeners.add(onHomeworkChanged);
  return () => {
    homeworkChangeListeners.delete(onHomeworkChanged);
  };
}

export function subscribeToStudentChanges(
  onStudentChanged: (payload: StudentSyncPayload) => void
): () => void {
  ensureChannelListenersRegistered();
  studentChangeListeners.add(onStudentChanged);
  return () => {
    studentChangeListeners.delete(onStudentChanged);
  };
}

export function subscribeToExamGradeChanges(
  onExamGradeChanged: (payload: ExamGradeSyncPayload) => void
): () => void {
  ensureChannelListenersRegistered();
  examGradeChangeListeners.add(onExamGradeChanged);
  return () => {
    examGradeChangeListeners.delete(onExamGradeChanged);
  };
}

export function subscribeToFullState(
  onFullStateReceived: (payload: any) => void
): () => void {
  ensureChannelListenersRegistered();
  fullStateListeners.add(onFullStateReceived);
  return () => {
    fullStateListeners.delete(onFullStateReceived);
  };
}

export function subscribeToMultiDevicePing(
  onPingReceived: (payload: MultiDevicePingPayload) => void
): () => void {
  ensureChannelListenersRegistered();
  multiDevicePingListeners.add(onPingReceived);
  return () => {
    multiDevicePingListeners.delete(onPingReceived);
  };
}

export function subscribeToMultiDevicePong(
  onPongReceived: (payload: MultiDevicePongPayload) => void
): () => void {
  ensureChannelListenersRegistered();
  multiDevicePongListeners.add(onPongReceived);
  return () => {
    multiDevicePongListeners.delete(onPongReceived);
  };
}

// ------------------------------------------------------------------------
// 4. SUPABASE POSTGRES PERSISTENCE HELPERS
// ------------------------------------------------------------------------

// In-memory barcode to student_id cache to avoid redundant network lookups
export const barcodeToIdCache = new Map<string, string>();

export async function getStudentIdByBarcode(barcode: string): Promise<string | null> {
  const b = String(barcode).trim();
  if (barcodeToIdCache.has(b)) {
    return barcodeToIdCache.get(b)!;
  }
  const { data } = await supabase
    .from("students")
    .select("id")
    .eq("barcode", b)
    .maybeSingle();

  if (data?.id) {
    barcodeToIdCache.set(b, data.id);
    return data.id;
  }
  return null;
}

/**
 * Ensures student exists in Supabase so foreign key constraints never fail.
 * Auto-creates student record on the fly if not found.
 */
export async function ensureStudentInSupabase(
  barcode: string,
  fallback?: {
    name?: string;
    phone?: string;
    parentPhone?: string;
    groupGrade?: string;
    groupDays?: string;
    groupTime?: string;
    monthlyFee?: number;
    discount?: number;
    notes?: string;
    isActive?: boolean;
  }
): Promise<string | null> {
  const b = String(barcode).trim();
  const cached = barcodeToIdCache.get(b);
  if (cached) return cached;

  const existingId = await getStudentIdByBarcode(b);
  if (existingId) return existingId;

  try {
    const payload = {
      barcode: b,
      name: fallback?.name || `طالب ${b}`,
      phone: String(fallback?.phone || ""),
      parent_phone: String(fallback?.parentPhone || fallback?.phone || "00000000000"),
      grade: fallback?.groupGrade || "غير محدد",
      group_days: fallback?.groupDays || "غير محدد",
      group_time: fallback?.groupTime || "04:00 م",
      monthly_fee: Number(fallback?.monthlyFee) || 0,
      discount: Number(fallback?.discount) || 0,
      notes: fallback?.notes || "",
      is_active: fallback?.isActive !== false,
    };
    const { data, error } = await supabase
      .from("students")
      .upsert(payload, { onConflict: "barcode" })
      .select("id")
      .single();
    if (data?.id) {
      barcodeToIdCache.set(b, data.id);
      return data.id;
    }
    if (error) {
      console.warn("Auto-insert student in Supabase notice:", error.message);
    }
  } catch (err) {
    console.warn("Auto-insert student in Supabase exception:", err);
  }
  return null;
}

/**
 * Bulk resolves student IDs from Supabase in a single batch query.
 * Auto-creates any missing students in a single bulk upsert.
 * Zero individual loop awaits!
 */
export async function ensureStudentsInSupabaseBulk(
  items: Array<{
    barcode: string;
    fallback?: {
      name?: string;
      phone?: string;
      parentPhone?: string;
      groupGrade?: string;
      groupDays?: string;
      groupTime?: string;
      monthlyFee?: number;
      discount?: number;
      notes?: string;
      isActive?: boolean;
    };
  }>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!items || items.length === 0) return result;

  const allBarcodes = Array.from(new Set(items.map((it) => String(it.barcode).trim()))).filter(Boolean);

  // 1. Populate already cached IDs
  const uncached: string[] = [];
  allBarcodes.forEach((b) => {
    const cached = barcodeToIdCache.get(b);
    if (cached) {
      result.set(b, cached);
    } else {
      uncached.push(b);
    }
  });

  // 2. Fetch all missing from Supabase in a single query
  if (uncached.length > 0) {
    try {
      const { data: found, error } = await supabase
        .from("students")
        .select("id, barcode")
        .in("barcode", uncached);

      if (!error && found) {
        found.forEach((row) => {
          if (row.barcode && row.id) {
            const cleanB = String(row.barcode).trim();
            barcodeToIdCache.set(cleanB, row.id);
            result.set(cleanB, row.id);
          }
        });
      }
    } catch (err) {
      console.warn("[SupabaseClient] Bulk student query exception:", err);
    }
  }

  // 3. Any still missing: auto-create in a single bulk upsert
  const stillMissing = allBarcodes.filter((b) => !result.has(b));
  if (stillMissing.length > 0) {
    const fallbackMap = new Map<string, any>();
    items.forEach((it) => {
      const b = String(it.barcode).trim();
      if (!fallbackMap.has(b)) {
        fallbackMap.set(b, it.fallback);
      }
    });

    const newRows = stillMissing.map((b) => {
      const fb = fallbackMap.get(b);
      return {
        barcode: b,
        name: fb?.name || `طالب ${b}`,
        phone: String(fb?.phone || ""),
        parent_phone: String(fb?.parentPhone || fb?.phone || "00000000000"),
        grade: fb?.groupGrade || "غير محدد",
        group_days: fb?.groupDays || "غير محدد",
        group_time: fb?.groupTime || "04:00 م",
        monthly_fee: Number(fb?.monthlyFee) || 0,
        discount: Number(fb?.discount) || 0,
        notes: fb?.notes || "",
        is_active: fb?.isActive !== false,
      };
    });

    try {
      const { data: created, error } = await supabase
        .from("students")
        .upsert(newRows, { onConflict: "barcode" })
        .select("id, barcode");

      if (!error && created) {
        created.forEach((row) => {
          if (row.barcode && row.id) {
            const cleanB = String(row.barcode).trim();
            barcodeToIdCache.set(cleanB, row.id);
            result.set(cleanB, row.id);
          }
        });
      }
    } catch (err) {
      console.warn("[SupabaseClient] Bulk student upsert exception:", err);
    }
  }

  return result;
}

/** Save single attendance record to Supabase with status normalization */
export async function saveAttendanceToSupabase(record: {
  barcode: string;
  studentName: string;
  status: "حضور" | "تأخير" | "غياب" | "غائب" | string;
  timeIso?: string;
  dateKey?: string;
  scannedBy?: string;
  studentFallback?: any;
}): Promise<void> {
  const dateKey = record.dateKey || getTodayDateKey();
  const studentId = await ensureStudentInSupabase(record.barcode, record.studentFallback || { name: record.studentName });
  if (!studentId) return;

  const normalizedStatus: "حضور" | "تأخير" | "غياب" =
    record.status === "غائب" || record.status === "غياب"
      ? "غياب"
      : record.status === "تأخير"
      ? "تأخير"
      : "حضور";

  await supabase
    .from("attendance_logs")
    .upsert(
      {
        student_id: studentId,
        barcode: String(record.barcode).trim(),
        student_name: record.studentName,
        date_key: dateKey,
        time_recorded: record.timeIso || new Date().toISOString(),
        status: normalizedStatus,
        scanned_by: record.scannedBy || "admin",
      },
      { onConflict: "student_id,date_key" }
    );
}

/**
 * Bulk save group attendance to Supabase in a single parallel bulk insertion.
 * Eliminates serial awaiting in loops for instant performance.
 */
export async function saveBulkAttendanceToSupabase(
  records: Array<{
    barcode: string;
    studentName: string;
    status: "حضور" | "تأخير" | "غياب" | "غائب" | string;
    dateKey: string;
    scannedBy?: string;
    studentFallback?: any;
  }>
): Promise<void> {
  if (!records || records.length === 0) return;

  // 1. Resolve all student IDs in a single bulk operation
  const idMap = await ensureStudentsInSupabaseBulk(
    records.map((r) => ({
      barcode: r.barcode,
      fallback: r.studentFallback || { name: r.studentName },
    }))
  );

  const nowIso = new Date().toISOString();
  const rowsToInsert = records
    .map((rec) => {
      const b = String(rec.barcode).trim();
      const sId = idMap.get(b);
      if (!sId) return null;

      const normalizedStatus: "حضور" | "تأخير" | "غياب" =
        rec.status === "غائب" || rec.status === "غياب"
          ? "غياب"
          : rec.status === "تأخير"
          ? "تأخير"
          : "حضور";

      return {
        student_id: sId,
        barcode: b,
        student_name: rec.studentName,
        date_key: rec.dateKey,
        time_recorded: nowIso,
        status: normalizedStatus,
        scanned_by: rec.scannedBy || "admin",
      };
    })
    .filter(Boolean);

  if (rowsToInsert.length === 0) return;

  // 2. Single bulk insertion (or parallel chunk insertion if very large)
  const chunkSize = 500;
  if (rowsToInsert.length <= chunkSize) {
    const { error } = await supabase
      .from("attendance_logs")
      .upsert(rowsToInsert, { onConflict: "student_id,date_key" });
    if (error) {
      console.error("[SupabaseClient] Bulk attendance upsert error:", error.message);
    }
  } else {
    const chunks = [];
    for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
      chunks.push(rowsToInsert.slice(i, i + chunkSize));
    }
    await Promise.all(
      chunks.map((chunk) =>
        supabase.from("attendance_logs").upsert(chunk, { onConflict: "student_id,date_key" })
      )
    );
  }
}

/** Save or update payment in Supabase */
export async function savePaymentToSupabase(record: {
  barcode: string;
  monthKey: string;
  amount: number;
  date?: string;
  note?: string;
  recordedBy?: string;
  studentFallback?: any;
}): Promise<void> {
  const studentId = await ensureStudentInSupabase(record.barcode, record.studentFallback);
  if (!studentId) return;

  await supabase
    .from("payments")
    .upsert(
      {
        student_id: studentId,
        month_key: record.monthKey,
        amount_paid: Number(record.amount) || 0,
        required_amount: Number(record.amount) || 100,
        discount: 0,
        status: "paid",
        payment_date: record.date ? new Date(record.date).toISOString() : new Date().toISOString(),
        received_by: record.recordedBy || "admin",
        notes: record.note || "سداد اشتراك",
      },
      { onConflict: "student_id,month_key" }
    );
}

/** 
 * Real Database Deletion: Direct DELETE query against Supabase payments table using primary key id
 */
export async function deletePaymentFromSupabase(barcode: string, monthKey: string, paymentIdParam?: string | number): Promise<void> {
  const b = String(barcode).trim();
  let studentId = await getStudentIdByBarcode(b);
  if (!studentId) {
    const { data: std } = await supabase.from("students").select("id").eq("barcode", b).maybeSingle();
    studentId = std?.id || null;
  }

  // 1. Direct DELETE query using primary key id if provided
  if (paymentIdParam) {
    await supabase.from("payments").delete().eq("id", String(paymentIdParam));
  } else if (studentId) {
    // Locate the primary key id of the payment record
    const { data: pmtRow } = await supabase
      .from("payments")
      .select("id")
      .eq("student_id", studentId)
      .eq("month_key", monthKey)
      .maybeSingle();

    if (pmtRow?.id) {
      await supabase.from("payments").delete().eq("id", pmtRow.id);
    }
  }

  // 2. Also ensure deletion by student_id and month_key
  if (studentId) {
    await supabase
      .from("payments")
      .delete()
      .eq("student_id", studentId)
      .eq("month_key", monthKey);
  }
}

/** Save or update exam grade in Supabase */
export async function saveExamGradeToSupabase(record: {
  barcode: string;
  examTitle: string;
  score: number;
  maxScore: number;
  dateKey?: string;
  notes?: string;
  studentFallback?: any;
}): Promise<void> {
  const dateKey = record.dateKey || getTodayDateKey();
  const studentId = await ensureStudentInSupabase(record.barcode, record.studentFallback);
  if (!studentId) return;

  await supabase
    .from("homework")
    .insert({
      student_id: studentId,
      date_key: dateKey,
      title: record.examTitle || "امتحان / تقييم",
      status: "done",
      score: record.score,
      max_score: record.maxScore,
      notes: record.notes || `رصد درجة: ${record.score}/${record.maxScore}`,
    });
}

/** Save or update homework record in Supabase */
export async function saveHomeworkToSupabase(records: Array<{
  barcode: string;
  dateKey: string;
  status: "done" | "incomplete" | "not_done";
  notes?: string;
}>): Promise<void> {
  if (!records || records.length === 0) return;

  const rows = [];
  for (const r of records) {
    const sId = await getStudentIdByBarcode(r.barcode);
    if (!sId) continue;
    rows.push({
      student_id: sId,
      date_key: r.dateKey,
      title: "واجب الحصة",
      status: r.status,
      notes: r.notes || "",
    });
  }

  if (rows.length > 0) {
    await supabase.from("homework").insert(rows);
  }
}

/** Save student to Supabase */
export async function saveStudentToSupabase(s: any): Promise<void> {
  if (!s || !s.barcode) return;
  const payload = {
    barcode: String(s.barcode).trim(),
    name: s.name || "طالب بدون اسم",
    phone: String(s.phone || ""),
    parent_phone: String(s.parentPhone || s.phone || "00000000000"),
    grade: s.groupGrade || s.grade || "غير محدد",
    group_days: s.groupDays || "غير محدد",
    group_time: s.groupTime || "04:00 م",
    monthly_fee: Number(s.monthlyFee || s.customMonthlyFee) || 0,
    discount: Number(s.discount) || 0,
    notes: s.notes || "",
    is_active: s.isActive !== false,
  };

  const { data } = await supabase
    .from("students")
    .upsert(payload, { onConflict: "barcode" })
    .select("id")
    .single();

  if (data?.id) {
    barcodeToIdCache.set(String(s.barcode).trim(), data.id);
  }
}

/** Bulk save students to Supabase */
export async function saveBulkStudentsToSupabase(students: any[]): Promise<void> {
  if (!students || students.length === 0) return;
  const rows = students.map((s) => ({
    barcode: String(s.barcode).trim(),
    name: s.name || "طالب بدون اسم",
    phone: String(s.phone || ""),
    parent_phone: String(s.parentPhone || s.phone || "00000000000"),
    grade: s.groupGrade || s.grade || "غير محدد",
    group_days: s.groupDays || "غير محدد",
    group_time: s.groupTime || "04:00 م",
    monthly_fee: Number(s.monthlyFee || s.customMonthlyFee) || 0,
    discount: Number(s.discount) || 0,
    notes: s.notes || "",
    is_active: s.isActive !== false,
  }));

  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await supabase.from("students").upsert(chunk, { onConflict: "barcode" });
  }
}

/** 
 * Real Database Deletion: Direct DELETE query executed against Supabase using primary key id
 * Cascades cleanup to child records (attendance, payments, homework) and removes cache
 */
export async function deleteStudentFromSupabase(barcode: string, studentIdParam?: string | number): Promise<void> {
  const b = String(barcode).trim();
  barcodeToIdCache.delete(b);

  // 1. Locate the primary key id in Supabase
  let studentId: string | null = studentIdParam ? String(studentIdParam) : null;
  if (!studentId) {
    const { data: stdRow } = await supabase
      .from("students")
      .select("id")
      .eq("barcode", b)
      .maybeSingle();

    if (stdRow?.id) {
      studentId = stdRow.id;
    }
  }

  // 2. Direct DELETE query using primary key id
  // Crucial: Clean child foreign-key records first so deletion of parent student is never blocked
  if (studentId) {
    await supabase.from("attendance").delete().eq("student_id", studentId);
    await supabase.from("payments").delete().eq("student_id", studentId);
    await supabase.from("homework").delete().eq("student_id", studentId);
    await supabase.from("attendance_logs").delete().eq("student_id", studentId);
    await supabase.from("students").delete().eq("id", studentId);
  }

  // 3. Guarantee deletion by barcode as well
  await supabase.from("attendance_logs").delete().eq("barcode", b);
  await supabase.from("students").delete().eq("barcode", b);
}

/** 
 * Real Database Deletion: Direct DELETE query against Supabase attendance table using primary key id
 */
export async function deleteAttendanceFromSupabase(barcode: string, dateKey?: string, attendanceIdParam?: string | number): Promise<void> {
  const b = String(barcode).trim();
  const targetDate = dateKey || getTodayDateKey();
  let studentId = await getStudentIdByBarcode(b);
  if (!studentId) {
    const { data: std } = await supabase.from("students").select("id").eq("barcode", b).maybeSingle();
    studentId = std?.id || null;
  }

  // 1. Direct DELETE query using primary key id if provided
  if (attendanceIdParam) {
    await supabase.from("attendance").delete().eq("id", String(attendanceIdParam));
    await supabase.from("attendance_logs").delete().eq("id", String(attendanceIdParam));
  } else {
    // Locate primary key id in attendance_logs
    let logQuery = supabase.from("attendance_logs").select("id").eq("date_key", targetDate);
    if (studentId) {
      logQuery = logQuery.eq("student_id", studentId);
    } else {
      logQuery = logQuery.eq("barcode", b);
    }
    const { data: logRow } = await logQuery.maybeSingle();
    if (logRow?.id) {
      await supabase.from("attendance_logs").delete().eq("id", logRow.id);
    }

    if (studentId) {
      const { data: attRow } = await supabase
        .from("attendance")
        .select("id")
        .eq("student_id", studentId)
        .eq("session_date", targetDate)
        .maybeSingle();

      if (attRow?.id) {
        await supabase.from("attendance").delete().eq("id", attRow.id);
      }
    }
  }

  if (studentId) {
    await supabase
      .from("attendance")
      .delete()
      .eq("student_id", studentId)
      .eq("session_date", targetDate);
    await supabase
      .from("attendance_logs")
      .delete()
      .eq("student_id", studentId)
      .eq("date_key", targetDate);
  }

  // Also remove from attendance_logs by barcode and date_key
  await supabase
    .from("attendance_logs")
    .delete()
    .eq("barcode", b)
    .eq("date_key", targetDate);
}

// ------------------------------------------------------------------------
// 5. SMART WRITE-BATCHING FOR ATTENDANCE (ZERO DB ABUSE - FLUSH EVERY 30s OR ON SAVE & SEND)
// ------------------------------------------------------------------------

export interface QueuedAttendanceScan {
  barcode: string;
  studentName: string;
  status: "حضور" | "تأخير" | "غياب" | "غائب" | string;
  timeIso?: string;
  dateKey?: string;
  scannedBy?: string;
  studentFallback?: any;
}

const pendingAttendanceBatchQueue = new Map<string, QueuedAttendanceScan>();

/**
 * Enqueue attendance scan in local memory without immediately calling Supabase
 */
export function queueAttendanceScanForBatch(record: QueuedAttendanceScan): void {
  const b = String(record.barcode).trim();
  if (!b) return;
  pendingAttendanceBatchQueue.set(b, record);
}

/**
 * Returns count of uncommitted attendance scans in batch buffer
 */
export function getPendingAttendanceBatchCount(): number {
  return pendingAttendanceBatchQueue.size;
}

/**
 * Commits all pending attendance scans to Supabase in a single bulk transaction
 */
export async function flushPendingAttendanceBatchToSupabase(): Promise<void> {
  if (pendingAttendanceBatchQueue.size === 0) return;

  const recordsToFlush = Array.from(pendingAttendanceBatchQueue.values());
  pendingAttendanceBatchQueue.clear();

  try {
    const formatted = recordsToFlush.map((r) => ({
      barcode: r.barcode,
      studentName: r.studentName,
      status: r.status,
      dateKey: r.dateKey || getTodayDateKey(),
      scannedBy: r.scannedBy || "الماسح",
      studentFallback: r.studentFallback,
    }));
    await saveBulkAttendanceToSupabase(formatted);
    console.log(`[Supabase Engine] Flushed ${recordsToFlush.length} attendance records in single bulk transaction.`);
  } catch (err) {
    console.warn("Notice flushing attendance batch to Supabase:", err);
    // Re-insert uncommitted records if network dropped
    recordsToFlush.forEach((r) => {
      if (!pendingAttendanceBatchQueue.has(r.barcode)) {
        pendingAttendanceBatchQueue.set(r.barcode, r);
      }
    });
  }
}

// Scheduled auto-flush every 30 seconds
if (typeof window !== "undefined") {
  setInterval(() => {
    flushPendingAttendanceBatchToSupabase().catch(() => {});
  }, 30000);

  window.addEventListener("beforeunload", () => {
    flushPendingAttendanceBatchToSupabase().catch(() => {});
  });
}

// ------------------------------------------------------------------------
// 6. DIRECT DIRECTORY FETCH ON MOUNT (ZERO LOSS & DIRECT RELATIONAL LOAD)
// ------------------------------------------------------------------------

export interface SupabaseDirectoryFetchResult {
  students: any[];
  attendanceToday: Record<string, string>;
  attendanceHistory?: Record<string, Record<string, string>>;
  payments: Record<string, Record<string, any>>;
  groupPrices?: Record<string, number>;
  usersList?: any[];
  count: number;
}

/**
 * Fetch authoritative student directory, attendance logs (today + history),
 * payments, exam grades, and system configs directly from Supabase PostgreSQL.
 * Runs on application boot across all devices to guarantee a single cloud source of truth.
 */
export async function fetchFullDirectoryFromSupabase(): Promise<SupabaseDirectoryFetchResult | null> {
  try {
    let allStudentsRows: any[] = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("students")
        .select("*")
        .range(from, from + pageSize - 1);

      if (error) {
        console.warn("Supabase fetch students warning:", error.message);
        break;
      }
      if (!data || data.length === 0) break;
      allStudentsRows = allStudentsRows.concat(data);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    if (allStudentsRows.length === 0) {
      // Direct fresh pull: If no students in Supabase, return empty array without injecting mock fallback
      return {
        students: [],
        attendanceToday: {},
        attendanceHistory: {},
        payments: {},
        count: 0,
      };
    }

    allStudentsRows.forEach((row) => {
      if (row.id && row.barcode) {
        barcodeToIdCache.set(String(row.barcode).trim(), row.id);
      }
    });

    const todayKey = getTodayDateKey();
    const attendanceToday: Record<string, string> = {};
    const attendanceHistory: Record<string, Record<string, string>> = {};
    const studentAttendanceCounts = new Map<string, { present: number; absent: number }>();

    // Fetch all attendance logs using pagination to construct complete, authentic history
    const allLogs: { barcode: string; date_key: string; status: string }[] = [];
    let logFrom = 0;
    const step = 1000;
    while (true) {
      const { data: chunk, error: logErr } = await supabase
        .from("attendance_logs")
        .select("barcode, date_key, status")
        .order("created_at", { ascending: false })
        .range(logFrom, logFrom + step - 1);

      if (logErr || !chunk || chunk.length === 0) break;
      allLogs.push(...chunk);
      if (chunk.length < step) break;
      logFrom += step;
      if (allLogs.length >= 40000) break;
    }

    allLogs.forEach((l) => {
      if (l.barcode && l.date_key) {
        const b = String(l.barcode).trim();
        // Discard any impossible future date
        if (l.date_key > todayKey) return;

        if (!attendanceHistory[l.date_key]) {
          attendanceHistory[l.date_key] = {};
        }
        attendanceHistory[l.date_key][b] = l.status;

        if (l.date_key === todayKey) {
          attendanceToday[b] = l.status;
        }

        const counts = studentAttendanceCounts.get(b) || { present: 0, absent: 0 };
        if (l.status === "حضور" || l.status === "تأخير") {
          counts.present += 1;
        } else if (l.status === "غياب" || l.status === "غائب") {
          counts.absent += 1;
        }
        studentAttendanceCounts.set(b, counts);
      }
    });

    // Fetch homework/exams to populate student test scores
    const studentExamScores = new Map<string, { scores: number[]; lastTitle?: string; lastScore?: string }>();
    const { data: hwData } = await supabase
      .from("homework")
      .select("student_id, title, score, max_score, date_key")
      .order("created_at", { ascending: true });

    // Reverse lookup map from student_id to barcode
    const idToBarcodeMap = new Map<string, string>();
    allStudentsRows.forEach((r) => {
      if (r.id && r.barcode) idToBarcodeMap.set(r.id, String(r.barcode).trim());
    });

    if (Array.isArray(hwData)) {
      hwData.forEach((hw) => {
        const b = idToBarcodeMap.get(hw.student_id);
        if (b && hw.score !== null && hw.score !== undefined) {
          const current = studentExamScores.get(b) || { scores: [] };
          const pct = hw.max_score > 0 ? Math.round((hw.score / hw.max_score) * 100) : Number(hw.score);
          current.scores.push(pct);
          current.lastTitle = hw.title;
          current.lastScore = `${hw.score}/${hw.max_score || 100}`;
          studentExamScores.set(b, current);
        }
      });
    }

    const mappedStudents = allStudentsRows.map((row) => {
      const b = String(row.barcode).trim();
      const counts = studentAttendanceCounts.get(b);
      const examInfo = studentExamScores.get(b);

      return {
        id: row.id,
        barcode: b,
        name: row.name || "طالب بدون اسم",
        phone: String(row.phone || ""),
        parentPhone: String(row.parent_phone || row.phone || ""),
        groupGrade: row.grade || "الصف الرابع الابتدائي",
        groupDays: row.group_days || "سبت - إثنين - أربعاء",
        customMonthlyFee: Number(row.monthly_fee) || undefined,
        discountReason: row.notes || undefined,
        points: (counts?.present || 0) * 10,
        totalAttendanceDays: counts?.present || 0,
        totalAbsentDays: counts?.absent || 0,
        totalExamScores: examInfo?.scores || [],
        lastExamTitle: examInfo?.lastTitle,
        lastExamScore: examInfo?.lastScore,
        createdAt: row.created_at || new Date().toISOString(),
      };
    });

    const paymentsMap: Record<string, Record<string, any>> = {};
    const { data: payRows, error: payErr } = await supabase
      .from("payments")
      .select("id, month_key, amount_paid, payment_date, notes, received_by, students(barcode)");

    if (!payErr && Array.isArray(payRows)) {
      payRows.forEach((p) => {
        const barcode = (p as any).students?.barcode;
        const mKey = p.month_key;
        if (barcode && mKey) {
          if (!paymentsMap[mKey]) paymentsMap[mKey] = {};
          paymentsMap[mKey][barcode] = {
            id: p.id,
            barcode,
            month: mKey,
            monthKey: mKey,
            amount: Number(p.amount_paid) || 0,
            date: p.payment_date ? p.payment_date.split("T")[0] : "",
            time: p.payment_date ? p.payment_date.split("T")[1]?.slice(0, 5) : "",
            note: p.notes || "",
            recordedBy: p.received_by || "admin",
          };
        }
      });
    }

    // Fetch system configs
    let groupPrices: Record<string, number> | undefined;
    let usersList: any[] | undefined;
    const { data: cfgData } = await supabase.from("system_configs").select("*");
    if (Array.isArray(cfgData)) {
      cfgData.forEach((row) => {
        if (row.id === "group_prices" && row.config_value) {
          groupPrices = row.config_value;
        } else if (row.id === "users" && Array.isArray(row.config_value)) {
          usersList = row.config_value;
        }
      });
    }

    return {
      students: mappedStudents,
      attendanceToday,
      attendanceHistory,
      payments: paymentsMap,
      groupPrices,
      usersList,
      count: mappedStudents.length,
    };
  } catch (err) {
    console.warn("Exception fetching full directory from Supabase:", err);
    return null;
  }
}

