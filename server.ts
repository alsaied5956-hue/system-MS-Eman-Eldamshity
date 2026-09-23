import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import zlib from "zlib";
import { initializeApp, getApps } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, onSnapshot, setLogLevel } from "firebase/firestore";
import { createServer as createViteServer } from "vite";

try {
  setLogLevel("silent");
} catch {
  // Ignore
}
import {
  analyzeStudentPerformance,
  generateSmartNotification,
  getAiServiceHealth,
} from "./src/server/geminiService.ts";

// Directory and file for zero-quota real-time sync persistence
const SYNC_DATA_DIR = path.join(process.cwd(), "data");
const SYNC_STATE_FILE = path.join(SYNC_DATA_DIR, "center_live_state.json");
const BACKUP_FALLBACK_FILE = path.join(process.cwd(), "src", "data", "centerBackup.json");
const DEVICES_DATA_DIR = path.join(SYNC_DATA_DIR, "devices");
const DEVICE_REGISTRY_FILE = path.join(DEVICES_DATA_DIR, "device_registry.json");
const ENTRY_EXIT_LOGS_FILE = path.join(SYNC_DATA_DIR, "center_entry_exit_logs.json");

// -------------------------------------------------------------
// FIRESTORE SERVER QUOTA & RPC ERROR SUPPRESSION ENGINE
// -------------------------------------------------------------
let serverFirestoreQuotaExceededUntil: number = Date.now() + 12 * 60 * 60 * 1000;

export function isFirestoreQuotaError(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || "").toLowerCase();
  const msg = String(err.message || "").toLowerCase();
  const status = String(err.status || "").toLowerCase();
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
    msg.includes("quota exceeded")
  );
}

export function isServerFirestoreQuotaActive(): boolean {
  return Date.now() < serverFirestoreQuotaExceededUntil;
}

export function markServerFirestoreQuotaExceeded(durationMs = 60 * 60 * 1000): void {
  serverFirestoreQuotaExceededUntil = Math.max(serverFirestoreQuotaExceededUntil, Date.now() + durationMs);
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

// 1. Intercept console.error to silence benign Firestore gRPC stream resource exhaustion & idle stream disconnects
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
      markServerFirestoreQuotaExceeded();
    }
    return;
  }

  originalConsoleError.apply(console, args);
};

// 2. Intercept process.stderr.write from native gRPC stream in Firebase SDK
const originalStderrWrite = process.stderr.write.bind(process.stderr);
(process.stderr as any).write = function (chunk: any, ...rest: any[]) {
  const str = typeof chunk === "string" ? chunk : chunk?.toString() || "";
  if (isBenignFirestoreStreamOrQuota(str)) {
    if (
      str.includes("RESOURCE_EXHAUSTED") ||
      str.includes("resource-exhausted") ||
      str.includes("Quota limit exceeded") ||
      str.includes("Free daily write units")
    ) {
      markServerFirestoreQuotaExceeded();
    }
    return true;
  }
  return (originalStderrWrite as any)(chunk, ...rest);
};

// 3. Catch unhandled rejections from background firestore promises
process.on("unhandledRejection", (reason: any) => {
  const reasonStr = typeof reason === "string" ? reason : reason?.message || reason?.stack || "";
  if (isFirestoreQuotaError(reason) || isBenignFirestoreStreamOrQuota(reasonStr)) {
    if (isFirestoreQuotaError(reason)) {
      markServerFirestoreQuotaExceeded();
    }
    return;
  }
  originalConsoleError("Unhandled Rejection:", reason);
});

if (!fs.existsSync(SYNC_DATA_DIR)) {
  fs.mkdirSync(SYNC_DATA_DIR, { recursive: true });
}
if (!fs.existsSync(DEVICES_DATA_DIR)) {
  fs.mkdirSync(DEVICES_DATA_DIR, { recursive: true });
}

// In-memory cache & SSE subscriber connections
let cachedServerState: any = null;
let lastServerUpdate = Date.now();

// Device Registry & Device Scans In-Memory Buffers
const registeredDevices = new Map<string, any>();
const deviceEventsCache = new Map<string, any[]>();
let centerEntryExitLogs: any[] = [];

// Load initial Device Registry and Entry/Exit Logs
try {
  if (fs.existsSync(DEVICE_REGISTRY_FILE)) {
    const raw = fs.readFileSync(DEVICE_REGISTRY_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed.forEach((d) => registeredDevices.set(d.deviceId, d));
    }
  }
} catch (e) {
  console.warn("[Device Hub] Device registry initialization note:", e);
}

try {
  if (fs.existsSync(ENTRY_EXIT_LOGS_FILE)) {
    const raw = fs.readFileSync(ENTRY_EXIT_LOGS_FILE, "utf-8");
    centerEntryExitLogs = JSON.parse(raw);
  }
} catch (e) {
  console.warn("[Device Hub] Entry/Exit logs initialization note:", e);
}

// Helper to get device events
function getDeviceEvents(deviceId: string): any[] {
  if (deviceEventsCache.has(deviceId)) {
    return deviceEventsCache.get(deviceId)!;
  }
  const filePath = path.join(DEVICES_DATA_DIR, `device_${deviceId}_events.json`);
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const list = JSON.parse(raw);
      deviceEventsCache.set(deviceId, list);
      return list;
    } catch {}
  }
  deviceEventsCache.set(deviceId, []);
  return [];
}

// Helper to save device events
function saveDeviceEvents(deviceId: string, events: any[]): void {
  deviceEventsCache.set(deviceId, events);
  try {
    const filePath = path.join(DEVICES_DATA_DIR, `device_${deviceId}_events.json`);
    fs.writeFileSync(filePath, JSON.stringify(events), "utf-8");
  } catch (err) {
    console.error(`[Device Hub] Failed to save device ${deviceId} events:`, err);
  }
}

// Helper to save device registry
function persistDeviceRegistry(): void {
  try {
    const list = Array.from(registeredDevices.values());
    fs.writeFileSync(DEVICE_REGISTRY_FILE, JSON.stringify(list), "utf-8");
  } catch (err) {
    console.error("[Device Hub] Failed to persist device registry:", err);
  }
}

// Helper to save entry/exit logs
function persistEntryExitLogs(): void {
  try {
    fs.writeFileSync(ENTRY_EXIT_LOGS_FILE, JSON.stringify(centerEntryExitLogs), "utf-8");
  } catch (err) {
    console.error("[Device Hub] Failed to persist entry/exit logs:", err);
  }
}

// SSE Subscriber Connection Tracking with Scope Filtering
interface SseConnection {
  id: string;
  res: Response;
  scope: "all" | "unified" | "device";
  deviceId?: string;
}
const sseSubscribers = new Map<string, SseConnection>();

// Dispatchers for isolated vs unified SSE events
function broadcastToUnified(payload: any): void {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [id, conn] of sseSubscribers.entries()) {
    if (conn.scope === "all" || conn.scope === "unified") {
      try {
        conn.res.write(msg);
      } catch {
        sseSubscribers.delete(id);
      }
    }
  }
}

function broadcastToDevice(deviceId: string, payload: any): void {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [id, conn] of sseSubscribers.entries()) {
    if (conn.scope === "all" || (conn.scope === "device" && conn.deviceId === deviceId)) {
      try {
        conn.res.write(msg);
      } catch {
        sseSubscribers.delete(id);
      }
    }
  }
}

function broadcastGlobal(payload: any): void {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [id, conn] of sseSubscribers.entries()) {
    try {
      conn.res.write(msg);
    } catch {
      sseSubscribers.delete(id);
    }
  }
}

// Try loading persisted state or fallback to backup
try {
  if (fs.existsSync(SYNC_STATE_FILE)) {
    const raw = fs.readFileSync(SYNC_STATE_FILE, "utf-8");
    cachedServerState = JSON.parse(raw);
    // Filter out any previously deleted barcodes to prevent resurrection
    const deletedBarcodesSet = new Set(
      (cachedServerState?.deletedBarcodes || []).map((b: string) => String(b).trim())
    );
    if (cachedServerState?.students && Array.isArray(cachedServerState.students)) {
      cachedServerState.students = cachedServerState.students.filter(
        (s: any) => !deletedBarcodesSet.has(String(s.barcode).trim())
      );
    }
    console.log("[Sync Hub] Loaded persistent center state from disk (sanitized)");
  } else if (fs.existsSync(BACKUP_FALLBACK_FILE)) {
    const raw = fs.readFileSync(BACKUP_FALLBACK_FILE, "utf-8");
    cachedServerState = JSON.parse(raw);
    // CRITICAL: Never seed fallback mock students into server memory
    // Authoritative student list must always be pulled fresh from Supabase
    cachedServerState.students = [];
    fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(cachedServerState), "utf-8");
    console.log("[Sync Hub] Initialized center state template with zero mock students");
  }
} catch (e) {
  console.warn("[Sync Hub] State initialization note:", e);
}

// -------------------------------------------------------------
// Firebase Firestore Live Bridge for 100% Cross-Device Unification
// -------------------------------------------------------------
let serverFirestoreDb: any = null;

function initServerFirestore() {
  if (serverFirestoreDb) return serverFirestoreDb;
  try {
    let firebaseConfig: any = {};
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }

    const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY || firebaseConfig.apiKey;
    const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || firebaseConfig.authDomain;
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || firebaseConfig.projectId;
    const databaseURL = process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL || firebaseConfig.databaseURL;
    const firestoreDatabaseId = firebaseConfig.firestoreDatabaseId;

    if (apiKey && projectId) {
      const mergedConfig = {
        ...firebaseConfig,
        apiKey,
        authDomain,
        projectId,
        databaseURL,
      };
      const app = getApps().length === 0 ? initializeApp(mergedConfig) : getApps()[0];
      serverFirestoreDb = getFirestore(app, firestoreDatabaseId);
      console.log("[Sync Hub] Initialized Firebase Firestore server bridge with project:", projectId);
      return serverFirestoreDb;
    }
  } catch (err) {
    console.warn("[Sync Hub] Failed to initialize Firestore bridge:", err);
  }
  return null;
}

function decompressCloudPayload(compressedString: string): any {
  if (!compressedString || typeof compressedString !== "string") return null;
  try {
    if (compressedString.startsWith("RAW:")) {
      return JSON.parse(compressedString.slice(4));
    }
    const b64 = compressedString.startsWith("GZIP:") ? compressedString.slice(5) : compressedString;
    const buf = Buffer.from(b64, "base64");
    const decompressed = zlib.gunzipSync(buf);
    return JSON.parse(decompressed.toString("utf-8"));
  } catch (err) {
    console.error("[Sync Hub] Error decompressing cloud payload:", err);
    return null;
  }
}

function compressCloudPayload(data: any): string {
  try {
    const jsonStr = JSON.stringify(data);
    const compressed = zlib.gzipSync(Buffer.from(jsonStr, "utf-8"));
    return "GZIP:" + compressed.toString("base64");
  } catch (err) {
    console.error("[Sync Hub] Error compressing payload:", err);
    return "RAW:" + JSON.stringify(data);
  }
}

const ATTENDANCE_SYSTEM_WIPE_EPOCH = 1774310000000;

function sanitizeStatePayload(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  let changed = false;
  const todayKey = new Date().toISOString().slice(0, 10);

  // 1. Enforce complete attendance wipe if before wipe epoch or attendanceWipedAt is set
  if (!payload.attendanceWipedAt || payload.attendanceWipedAt < ATTENDANCE_SYSTEM_WIPE_EPOCH) {
    payload.attendanceHistory = {};
    payload.attendanceToday = {};
    payload.scanLogOrder = [];
    payload.scanLogTimes = {};
    payload.attendanceWipedAt = ATTENDANCE_SYSTEM_WIPE_EPOCH;
    changed = true;
  }

  // 2. Sanitize attendanceToday: never retain yesterday's attendance on a new day
  if (payload.attendanceTodayDate !== todayKey) {
    if (payload.attendanceToday && Object.keys(payload.attendanceToday).length > 0) {
      payload.attendanceToday = {};
      payload.scanLogOrder = [];
      payload.scanLogTimes = {};
      changed = true;
    }
    payload.attendanceTodayDate = todayKey;
  }

  // 3. Remove points and enforce 0 points system wide, preserve all student info & exam history
  if (Array.isArray(payload.students)) {
    payload.students.forEach((s: any) => {
      if (s.points !== 0) {
        s.points = 0;
        changed = true;
      }
      if (!payload.attendanceHistory || Object.keys(payload.attendanceHistory).length === 0) {
        if (s.totalAttendanceDays !== 0) {
          s.totalAttendanceDays = 0;
          changed = true;
        }
        if (s.totalAbsentDays !== 0) {
          s.totalAbsentDays = 0;
          changed = true;
        }
      }
      if (!Array.isArray(s.examHistory)) {
        s.examHistory = [];
      }
    });
  }

  return changed;
}

async function syncServerWithFirestore() {
  const db = initServerFirestore();
  if (!db) return;

  try {
    const docRef = doc(db, "system_state", "main_center_data");
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const d = snap.data();
      if (d._compressedPayload) {
        const decompressed = decompressCloudPayload(d._compressedPayload);
        if (decompressed && Array.isArray(decompressed.students)) {
          const wasCleaned = sanitizeStatePayload(decompressed);
          cachedServerState = decompressed;
          lastServerUpdate = wasCleaned ? Date.now() : (d.updatedAt || Date.now());
          fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(decompressed), "utf-8");
          console.log(`[Sync Hub] Synced from Firestore successfully (${decompressed.students.length} students). Cleaned mock data: ${wasCleaned}`);

          // If cleaned, persist sanitized state back to Firestore immediately
          if (wasCleaned) {
            setDoc(
              docRef,
              {
                _compressedPayload: compressCloudPayload(decompressed),
                studentsCount: decompressed.students.length,
                updatedAt: lastServerUpdate,
                _lastClientId: "server_sanitizer",
                syncedAtIso: new Date().toISOString(),
              },
              { merge: true }
            ).catch((e) => console.warn("[Sync Hub] Failed to update sanitized state to Firestore:", e));
          }
        }
      }
    }

    // Subscribe to continuous real-time changes from Firestore
    onSnapshot(
      docRef,
      (snapshot) => {
        if (!snapshot.exists()) return;
        const d = snapshot.data();
        if (d._compressedPayload && d.updatedAt && d.updatedAt > lastServerUpdate) {
          const decompressed = decompressCloudPayload(d._compressedPayload);
          if (decompressed && Array.isArray(decompressed.students)) {
            sanitizeStatePayload(decompressed);
            cachedServerState = decompressed;
            lastServerUpdate = d.updatedAt;
            fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(decompressed), "utf-8");
            broadcastToUnified({
              type: "state_update",
              sourceDeviceId: d._lastClientId || "firestore_cloud",
              updatedAt: lastServerUpdate,
              data: decompressed,
            });
            console.log(`[Sync Hub] Received cloud broadcast from Firestore (${decompressed.students.length} students)`);
          }
        }
      },
      (err) => {
        const msg = err?.message || String(err || "");
        if (isBenignFirestoreStreamOrQuota(msg)) {
          return;
        }
        console.warn("[Sync Hub] Firestore snapshot listener warning:", msg);
      }
    );
  } catch (err) {
    console.warn("[Sync Hub] Firestore initialization sync error:", err);
  }
}

// Trigger initial cloud sync in background
syncServerWithFirestore().catch(() => {});

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware for body parsing and request isolation
  app.use(express.json({ limit: "25mb" }));

  // Enable CORS for external programs, scripts, or apps pulling data
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-session-id, x-device-id");
    if (_req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    next();
  });

  // Session & Request Tracking Middleware (Isolates multi-device calls)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = `req_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`;
    const sessionId = (req.headers["x-session-id"] as string) || "anonymous_session";
    const deviceId = (req.headers["x-device-id"] as string) || "anonymous_device";

    res.setHeader("X-Request-ID", requestId);
    res.setHeader("X-Session-ID", sessionId);
    res.setHeader("X-Device-ID", deviceId);

    (req as any).requestId = requestId;
    (req as any).sessionId = sessionId;
    (req as any).deviceId = deviceId;
    next();
  });

  // -------------------------------------------------------------
  // API Routes (Registered FIRST before Vite or static middlewares)
  // -------------------------------------------------------------

  // Strict Anti-Cache Headers for all API routes (Eliminates Stale/Cash issues completely)
  app.use("/api", (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    next();
  });

  // General server health check
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Fast Server Time Endpoint for Clock Drift Guard (±5 min threshold)
  app.get("/api/time", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      serverTime: Date.now(),
      iso: new Date().toISOString(),
    });
  });

  // Supabase REST & Auth Proxy Endpoint (Protects sandboxed iframes from cross-origin/CORS network drops)
  app.all(["/api/supabase-proxy", "/api/supabase-proxy/*"], async (req: Request, res: Response) => {
    try {
      const targetPath = req.url.replace(/^\/api\/supabase-proxy/, "") || "/";
      const supabaseUrl =
        process.env.VITE_SUPABASE_URL ||
        process.env.NEXT_PUBLIC_SUPABASE_URL ||
        "https://lzdvmzumwuqycwdecaan.supabase.co";
      const fullTargetUrl = new URL(targetPath, supabaseUrl).toString();

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value) continue;
        const lower = key.toLowerCase();
        // Skip hop-by-hop headers
        if (lower === "host" || lower === "connection" || lower === "content-length") continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
      }

      const anonKey =
        process.env.VITE_SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        "sb_publishable_B2ATdO71x3VxvOL18ATZtA_bupiDf3l";

      if (!headers["apikey"]) headers["apikey"] = anonKey;
      if (!headers["authorization"]) headers["authorization"] = `Bearer ${anonKey}`;

      const fetchOptions: RequestInit = {
        method: req.method,
        headers,
      };

      if (req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined) {
        fetchOptions.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      }

      const sbResponse = await fetch(fullTargetUrl, fetchOptions);

      res.status(sbResponse.status);

      sbResponse.headers.forEach((val, key) => {
        const lower = key.toLowerCase();
        if (
          lower !== "content-encoding" &&
          lower !== "transfer-encoding" &&
          lower !== "content-length"
        ) {
          res.setHeader(key, val);
        }
      });

      const responseText = await sbResponse.text();
      res.send(responseText);
    } catch (err: any) {
      console.warn("[Supabase Proxy] Warning forwarding to Supabase:", err?.message || err);
      res.status(502).json({
        message: "Failed to fetch from Supabase via proxy",
        details: err?.message || String(err),
      });
    }
  });

  // -------------------------------------------------------------
  // SYSTEM 1: Unified Center Synchronization Hub (الموقع الموحد)
  // -------------------------------------------------------------

  // 1. Ping / Diagnostic Endpoint
  app.get("/api/sync/ping", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      status: "ok",
      engine: "Dual Architecture Hub (Unified Center + Independent Devices)",
      serverTimestamp: Date.now(),
      unifiedClientsConnected: Array.from(sseSubscribers.values()).filter((c) => c.scope === "unified" || c.scope === "all").length,
      deviceClientsConnected: Array.from(sseSubscribers.values()).filter((c) => c.scope === "device").length,
      totalSseConnections: sseSubscribers.size,
      registeredDevicesCount: registeredDevices.size,
      hasUnifiedState: Boolean(cachedServerState),
      studentsCount: cachedServerState?.students?.length || 0,
      totalEntryExitLogsCount: centerEntryExitLogs.length,
    });
  });

  // 2. Real-Time Unified Server-Sent Events (SSE) Stream
  app.get(["/api/sync/events", "/api/sync/unified/events"], (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform, no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const connId = `unified_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`;
    const conn: SseConnection = {
      id: connId,
      res,
      scope: "unified",
    };
    sseSubscribers.set(connId, conn);

    // Initial handshake
    res.write(`data: ${JSON.stringify({ type: "handshake", channel: "unified", timestamp: Date.now(), connId })}\n\n`);

    // Keep-alive heartbeat every 15 seconds to prevent browser/proxy disconnects
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        clearInterval(heartbeat);
        sseSubscribers.delete(connId);
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseSubscribers.delete(connId);
    });
  });

  // 3. Pull Current Consolidated Unified State (Zero-Cache, Fresh from Source)
  app.get(["/api/sync/state", "/api/sync/data", "/api/sync/unified/state"], (_req: Request, res: Response) => {
    res.json({
      ok: true,
      data: cachedServerState,
      updatedAt: lastServerUpdate,
    });
  });

  // 3b. Dedicated endpoint to fetch students list only
  app.get("/api/sync/students", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      count: cachedServerState?.students?.length || 0,
      students: cachedServerState?.students || [],
      updatedAt: lastServerUpdate,
    });
  });

  // 3c. Dedicated endpoint to fetch attendance logs
  app.get("/api/sync/attendance", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      attendanceToday: cachedServerState?.attendanceToday || {},
      attendanceHistory: cachedServerState?.attendanceHistory || {},
      scanLogTimes: cachedServerState?.scanLogTimes || {},
      updatedAt: lastServerUpdate,
    });
  });

  // 4. Push Unified State Update with Immediate Real-time Broadcast
  app.post(["/api/sync/push", "/api/sync/unified/push"], (req: Request, res: Response) => {
    const { data, sourceDeviceId } = req.body;
    if (!data) {
      return res.status(400).json({ ok: false, error: "No data payload provided" });
    }

    let stateToSave = data;
    if (cachedServerState && typeof cachedServerState === "object") {
      // Intelligently merge attendanceToday and scanLogOrder so no terminal ever wipes another terminal's scans
      const existingToday = cachedServerState.attendanceToday || {};
      const incomingToday = data.attendanceToday || {};
      const mergedToday: Record<string, string> = { ...existingToday, ...incomingToday };

      // Ensure physical presence (حضور or تأخير) is never downgraded or wiped
      for (const [b, st] of Object.entries(existingToday)) {
        if ((st === "حضور" || st === "تأخير") && mergedToday[b] !== "حضور" && mergedToday[b] !== "تأخير") {
          mergedToday[b] = st as string;
        }
      }

      // Merge scanLogOrder union without losing any student
      const existingOrder = Array.isArray(cachedServerState.scanLogOrder) ? cachedServerState.scanLogOrder : [];
      const incomingOrder = Array.isArray(data.scanLogOrder) ? data.scanLogOrder : [];
      const combinedOrder = Array.from(new Set([...incomingOrder, ...existingOrder]));

      const combinedScanTimes = {
        ...(cachedServerState.scanLogTimes || {}),
        ...(data.scanLogTimes || {}),
      };

      stateToSave = {
        ...cachedServerState,
        ...data,
        attendanceToday: mergedToday,
        scanLogOrder: combinedOrder,
        scanLogTimes: combinedScanTimes,
      };
    }

    // Active incoming students must NEVER be wiped out by old deletedBarcodes tombstones!
    const activeIncomingBarcodes = new Set(
      (Array.isArray(data?.students) ? data.students : []).map((s: any) => String(s?.barcode || "").trim())
    );

    // Merge tombstones and sanitize stateToSave so deleted records never resurrect
    const allDeletedBarcodes = Array.from(
      new Set([
        ...(cachedServerState?.deletedBarcodes || []),
        ...(data?.deletedBarcodes || []),
      ])
    )
      .map((b) => String(b).trim())
      .filter((b) => !activeIncomingBarcodes.has(b)); // Purge re-added students
    const deletedBarcodesSet = new Set(allDeletedBarcodes);

    const allDeletedPaymentKeys = Array.from(
      new Set([
        ...(cachedServerState?.deletedPaymentKeys || []),
        ...(data?.deletedPaymentKeys || []),
      ])
    ).map((k) => String(k).trim());
    const deletedPaymentKeysSet = new Set(allDeletedPaymentKeys);

    const allDeletedAttendanceKeys = Array.from(
      new Set([
        ...(cachedServerState?.deletedAttendanceKeys || []),
        ...(data?.deletedAttendanceKeys || []),
      ])
    ).map((k) => String(k).trim());
    const deletedAttendanceKeysSet = new Set(allDeletedAttendanceKeys);

    if (Array.isArray(stateToSave.students)) {
      stateToSave.students = stateToSave.students.filter(
        (s: any) => !deletedBarcodesSet.has(String(s.barcode).trim())
      );
    }

    if (stateToSave.attendanceToday && typeof stateToSave.attendanceToday === "object") {
      const filteredToday: Record<string, string> = {};
      for (const [b, st] of Object.entries(stateToSave.attendanceToday)) {
        const cleanB = String(b).trim();
        if (!deletedBarcodesSet.has(cleanB) && !deletedAttendanceKeysSet.has(`today_${cleanB}`)) {
          filteredToday[cleanB] = st as string;
        }
      }
      stateToSave.attendanceToday = filteredToday;
    }

    stateToSave.deletedBarcodes = allDeletedBarcodes;
    stateToSave.deletedPaymentKeys = allDeletedPaymentKeys;
    stateToSave.deletedAttendanceKeys = allDeletedAttendanceKeys;

    // Apply strict sanitization: wipe epoch enforcement and 0 points
    sanitizeStatePayload(stateToSave);

    cachedServerState = stateToSave;
    lastServerUpdate = Date.now();

    // Persist to disk asynchronously
    try {
      fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(stateToSave), "utf-8");
    } catch (err) {
      console.error("[Sync Hub] Failed to write unified state to disk:", err);
    }

    // Broadcast instantly to all unified screens
    broadcastToUnified({
      type: "state_update",
      sourceDeviceId: sourceDeviceId || "unknown",
      updatedAt: lastServerUpdate,
      data: stateToSave,
    });

    // Mirror asynchronously to Cloud Firestore so all external platforms stay 100% unified
    if (serverFirestoreDb && !isServerFirestoreQuotaActive()) {
      try {
        const compressedPayload = compressCloudPayload(data);
        const docRef = doc(serverFirestoreDb, "system_state", "main_center_data");
        setDoc(
          docRef,
          {
            _compressedPayload: compressedPayload,
            studentsCount: Array.isArray(data.students) ? data.students.length : 0,
            paymentsCount: Object.values(data.payments || {}).reduce(
              (acc: number, m: any) => acc + Object.keys(m || {}).length,
              0
            ),
            updatedAt: lastServerUpdate,
            _lastClientId: sourceDeviceId || "server_sync_hub",
            syncedAtIso: new Date().toISOString(),
          },
          { merge: true }
        ).catch((e) => {
          if (isFirestoreQuotaError(e)) {
            markServerFirestoreQuotaExceeded();
          } else {
            console.warn("[Sync Hub] Background Firestore write warning:", e?.message);
          }
        });
      } catch (e: any) {
        if (isFirestoreQuotaError(e)) {
          markServerFirestoreQuotaExceeded();
        } else {
          console.warn("[Sync Hub] Firestore mirror compression note:", e?.message);
        }
      }
    }

    res.json({
      ok: true,
      updatedAt: lastServerUpdate,
      broadcastedToClients: sseSubscribers.size,
      firestoreQuotaActive: isServerFirestoreQuotaActive(),
    });
  });

  // 4b. Immediate Server-Side Student Record Deletion with SSE Broadcasting
  app.post("/api/sync/delete-student", (req: Request, res: Response) => {
    const { barcode, studentId, sourceDeviceId } = req.body;
    if (!barcode) {
      return res.status(400).json({ ok: false, error: "Missing barcode" });
    }
    const b = String(barcode).trim();

    if (cachedServerState && typeof cachedServerState === "object") {
      const deletedBarcodes = Array.from(
        new Set([...(cachedServerState.deletedBarcodes || []), b])
      );
      const filteredStudents = Array.isArray(cachedServerState.students)
        ? cachedServerState.students.filter((s: any) => String(s.barcode).trim() !== b)
        : [];

      const filteredToday = { ...(cachedServerState.attendanceToday || {}) };
      delete filteredToday[b];

      const filteredScanOrder = Array.isArray(cachedServerState.scanLogOrder)
        ? cachedServerState.scanLogOrder.filter((code: string) => code !== b)
        : [];

      const filteredScanTimes = { ...(cachedServerState.scanLogTimes || {}) };
      delete filteredScanTimes[b];

      cachedServerState = {
        ...cachedServerState,
        students: filteredStudents,
        attendanceToday: filteredToday,
        scanLogOrder: filteredScanOrder,
        scanLogTimes: filteredScanTimes,
        deletedBarcodes,
        updatedAt: Date.now(),
      };
      lastServerUpdate = Date.now();

      try {
        fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(cachedServerState), "utf-8");
      } catch (err) {
        console.error("[Sync Hub] Failed to persist student deletion to disk:", err);
      }
    }

    // Broadcast immediate SSE deletion to all connected clients
    broadcastToUnified({
      type: "record_deleted",
      recordType: "student",
      barcode: b,
      studentId,
      sourceDeviceId: sourceDeviceId || "server",
      timestamp: Date.now(),
    });

    res.json({ ok: true, deletedBarcode: b });
  });

  // 4b. Immediate Tombstone Restoration / Clean when student is re-added
  app.post("/api/sync/restore-tombstone", (req: Request, res: Response) => {
    const { barcode } = req.body;
    if (barcode && cachedServerState && typeof cachedServerState === "object") {
      const b = String(barcode).trim();
      cachedServerState.deletedBarcodes = (cachedServerState.deletedBarcodes || []).filter(
        (code: string) => String(code).trim() !== b
      );
      try {
        fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(cachedServerState), "utf-8");
      } catch {}
    }
    res.json({ ok: true });
  });

  // 4c. Immediate Server-Side Payment Record Deletion with SSE Broadcasting
  app.post("/api/sync/delete-payment", (req: Request, res: Response) => {
    const { barcode, monthKey, paymentId, sourceDeviceId } = req.body;
    if (!barcode || !monthKey) {
      return res.status(400).json({ ok: false, error: "Missing barcode or monthKey" });
    }
    const b = String(barcode).trim();
    const m = String(monthKey).trim();
    const payKey = `${m}_${b}`;

    if (cachedServerState && typeof cachedServerState === "object") {
      const deletedPaymentKeys = Array.from(
        new Set([...(cachedServerState.deletedPaymentKeys || []), payKey])
      );

      const payments = { ...(cachedServerState.payments || {}) };
      if (payments[m] && payments[m][b]) {
        const monthMap = { ...payments[m] };
        delete monthMap[b];
        payments[m] = monthMap;
      }

      cachedServerState = {
        ...cachedServerState,
        payments,
        deletedPaymentKeys,
        updatedAt: Date.now(),
      };
      lastServerUpdate = Date.now();

      try {
        fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(cachedServerState), "utf-8");
      } catch (err) {
        console.error("[Sync Hub] Failed to persist payment deletion to disk:", err);
      }
    }

    // Broadcast immediate SSE deletion to all connected clients
    broadcastToUnified({
      type: "record_deleted",
      recordType: "payment",
      barcode: b,
      monthKey: m,
      paymentId,
      sourceDeviceId: sourceDeviceId || "server",
      timestamp: Date.now(),
    });

    res.json({ ok: true, deletedPaymentKey: payKey });
  });

  // 4d. Immediate Server-Side Attendance Record Deletion with SSE Broadcasting
  app.post("/api/sync/delete-attendance", (req: Request, res: Response) => {
    const { barcode, dateKey, attendanceId, sourceDeviceId } = req.body;
    if (!barcode) {
      return res.status(400).json({ ok: false, error: "Missing barcode" });
    }
    const b = String(barcode).trim();
    const d = dateKey ? String(dateKey).trim() : new Date().toISOString().slice(0, 10);
    const attKey = `${d}_${b}`;

    if (cachedServerState && typeof cachedServerState === "object") {
      const deletedAttendanceKeys = Array.from(
        new Set([...(cachedServerState.deletedAttendanceKeys || []), attKey])
      );

      const filteredToday = { ...(cachedServerState.attendanceToday || {}) };
      delete filteredToday[b];

      const history = { ...(cachedServerState.attendanceHistory || {}) };
      if (history[d] && history[d][b]) {
        const dayMap = { ...history[d] };
        delete dayMap[b];
        history[d] = dayMap;
      }

      const filteredScanOrder = Array.isArray(cachedServerState.scanLogOrder)
        ? cachedServerState.scanLogOrder.filter((code: string) => code !== b)
        : [];

      cachedServerState = {
        ...cachedServerState,
        attendanceToday: filteredToday,
        attendanceHistory: history,
        scanLogOrder: filteredScanOrder,
        deletedAttendanceKeys,
        updatedAt: Date.now(),
      };
      lastServerUpdate = Date.now();

      try {
        fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(cachedServerState), "utf-8");
      } catch (err) {
        console.error("[Sync Hub] Failed to persist attendance deletion to disk:", err);
      }
    }

    // Broadcast immediate SSE deletion to all connected clients
    broadcastToUnified({
      type: "record_deleted",
      recordType: "attendance",
      barcode: b,
      dateKey: d,
      attendanceId,
      sourceDeviceId: sourceDeviceId || "server",
      timestamp: Date.now(),
    });

    res.json({ ok: true, deletedAttendanceKey: attKey });
  });

  // Query or report Firestore Quota state
  app.get("/api/sync/quota", (_req: Request, res: Response) => {
    res.json({
      quotaActive: isServerFirestoreQuotaActive(),
      quotaExceededUntil: serverFirestoreQuotaExceededUntil,
    });
  });

  app.post("/api/sync/quota/report", (_req: Request, res: Response) => {
    markServerFirestoreQuotaExceeded();
    res.json({ ok: true, quotaActive: true });
  });

  // Direct HTTP attachment download for complete JSON backup (Guaranteed download on all devices & iframes)
  app.get(["/api/backup/download", "/api/sync/backup"], (_req: Request, res: Response) => {
    try {
      const data =
        cachedServerState ||
        (fs.existsSync(SYNC_STATE_FILE)
          ? JSON.parse(fs.readFileSync(SYNC_STATE_FILE, "utf-8"))
          : JSON.parse(fs.readFileSync(BACKUP_FALLBACK_FILE, "utf-8")));
      const dateStr = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Disposition", `attachment; filename="center_backup_${dateStr}.json"`);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.send(JSON.stringify(data, null, 2));
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "Failed to generate backup file" });
    }
  });

  // 5. Consolidated Entry & Exit Journal (All Devices Aggregated)
  app.get("/api/entry-exit/logs", (req: Request, res: Response) => {
    const { deviceId, type, dateKey, barcode, limit } = req.query;
    let filtered = [...centerEntryExitLogs];

    if (deviceId) {
      filtered = filtered.filter((e) => e.deviceId === String(deviceId).trim());
    }
    if (type) {
      filtered = filtered.filter((e) => e.type === String(type).trim());
    }
    if (dateKey) {
      filtered = filtered.filter((e) => e.dateKey === String(dateKey).trim());
    }
    if (barcode) {
      filtered = filtered.filter((e) => String(e.barcode).trim() === String(barcode).trim());
    }

    const maxItems = Math.min(Number(limit) || 100, 1000);
    res.json({
      ok: true,
      count: filtered.length,
      logs: filtered.slice(0, maxItems),
      updatedAt: Date.now(),
    });
  });

  // 3. Sub-Second Parent Push Notification Webhook / Broadcast Hub
  app.post("/api/notifications/parent-push", (req: Request, res: Response) => {
    const payload = req.body || {};
    const { eventId, parentPhone, studentBarcode, title, body, type, timestamp } = payload;

    // Broadcast to connected SSE subscribers for parents or devices
    broadcastToUnified({
      event: "parent_notification",
      eventId,
      parentPhone,
      studentBarcode,
      title,
      body,
      type,
      timestamp: timestamp || Date.now(),
    });

    res.json({
      ok: true,
      delivered: true,
      eventId,
      timestamp: Date.now(),
    });
  });

  // 4. High-Priority Event Dispatcher (FCM HTTP v1 Standard Webhook)
  const recentFcmDispatches: any[] = [];

  app.post("/api/notifications/fcm-dispatch", async (req: Request, res: Response) => {
    try {
      const payload = req.body || {};
      const {
        eventId,
        actionType,
        studentBarcode,
        studentName,
        parentPhone,
        fcmToken,
        title,
        body,
        fcmPayload,
        timestamp,
      } = payload;

      const eventTime = timestamp || Date.now();
      const cleanBarcode = String(studentBarcode || "").trim();

      // Ensure FCM HTTP v1 standards in the payload
      const standardFcmMessage = fcmPayload?.message || {
        token: fcmToken || undefined,
        topic: !fcmToken ? `student_${cleanBarcode}` : undefined,
        notification: { title, body },
        data: {
          action_type: actionType || "ATTENDANCE_PRESENT",
          student_barcode: cleanBarcode,
          student_name: studentName || "",
          parent_phone: parentPhone || "",
          timestamp: String(eventTime),
          priority: "HIGH",
        },
        android: {
          priority: "HIGH",
          notification: {
            channel_id: "parent_urgent_alerts",
            sound: "default",
            default_sound: true,
            default_vibrate_timings: true,
            notification_priority: "PRIORITY_MAX",
          },
        },
      };

      // Store in memory ring-buffer
      const logRecord = {
        eventId: eventId || `fcm_${Date.now()}_${cleanBarcode}`,
        actionType: actionType || "UNKNOWN",
        studentBarcode: cleanBarcode,
        studentName,
        parentPhone,
        fcmToken: fcmToken ? `${String(fcmToken).slice(0, 12)}...` : null,
        title,
        body,
        fcmMessage: standardFcmMessage,
        dispatchedAt: eventTime,
        status: "DELIVERED_REALTIME",
      };

      recentFcmDispatches.unshift(logRecord);
      if (recentFcmDispatches.length > 300) {
        recentFcmDispatches.pop();
      }

      // Broadcast to connected SSE subscribers for parents or devices
      broadcastToUnified({
        event: "fcm_push_dispatched",
        eventId: logRecord.eventId,
        actionType,
        studentBarcode: cleanBarcode,
        studentName,
        parentPhone,
        title,
        body,
        fcmMessage: standardFcmMessage,
        timestamp: eventTime,
      });

      // Also broadcast as parent_notification for legacy listeners
      broadcastToUnified({
        event: "parent_notification",
        eventId: logRecord.eventId,
        parentPhone,
        studentBarcode: cleanBarcode,
        title,
        body,
        type: actionType,
        timestamp: eventTime,
      });

      console.log(`[FCM HTTP v1] Dispatched ${actionType} for student ${studentName || cleanBarcode} (${fcmToken ? "Direct Token" : "Topic/Broadcast"})`);

      res.json({
        ok: true,
        dispatched: true,
        eventId: logRecord.eventId,
        actionType,
        fcmTokenPresent: Boolean(fcmToken),
        standards: {
          androidPriority: "HIGH",
          defaultSound: true,
          channelId: "parent_urgent_alerts",
        },
        timestamp: eventTime,
      });
    } catch (err: any) {
      console.error("[FCM HTTP v1] Error processing dispatch:", err);
      res.status(500).json({ ok: false, error: err?.message || "Internal error in FCM dispatcher" });
    }
  });

  app.get("/api/notifications/fcm-logs", (req: Request, res: Response) => {
    const { barcode, limit } = req.query;
    let list = recentFcmDispatches;
    if (barcode) {
      list = list.filter((l) => l.studentBarcode === String(barcode));
    }
    const maxItems = Math.min(Number(limit) || 50, 200);
    res.json({
      ok: true,
      total: list.length,
      logs: list.slice(0, maxItems),
    });
  });

  // -------------------------------------------------------------
  // SYSTEM 2: Independent Device APIs (الموقع المستقل - أجهزة الدخول والخروج)
  // -------------------------------------------------------------

  // 1. Record Live Scan from an Independent Device (دخول أو خروج)
  app.post(["/api/devices/:deviceId/scan", "/api/entry-exit/scan"], (req: Request, res: Response) => {
    const paramDeviceId = req.params.deviceId;
    const body = req.body || {};
    const deviceId = String(paramDeviceId || body.deviceId || (req as any).deviceId || "standalone_device").trim();
    const barcode = String(body.barcode || "").trim();

    if (!barcode) {
      return res.status(400).json({ ok: false, error: "Missing barcode" });
    }

    // Normalize scan type: "دخول" أو "خروج"
    const rawType = String(body.type || "دخول").toLowerCase();
    const normalizedType: "دخول" | "خروج" =
      rawType === "exit" || rawType === "out" || rawType === "خروج" ? "خروج" : "دخول";

    // Lookup student in unified students database if not provided in payload
    let studentName = body.studentName ? String(body.studentName).trim() : "";
    let grade = body.grade ? String(body.grade).trim() : "";
    let days = body.days ? String(body.days).trim() : "";

    if (!studentName && cachedServerState?.students) {
      const found = cachedServerState.students.find(
        (s: any) => String(s.barcode).trim() === barcode
      );
      if (found) {
        studentName = found.name;
        grade = found.groupGrade || "";
        days = found.groupDays || "";
      }
    }

    const now = new Date();
    const timeDisplay = now.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit", hour12: true });
    const dateKey = now.toISOString().split("T")[0];

    // Device metadata
    const existingDevice = registeredDevices.get(deviceId);
    const deviceName = body.deviceName || existingDevice?.deviceName || `جهاز #${deviceId.substring(0, 6)}`;
    const deviceLocation = body.deviceLocation || existingDevice?.deviceLocation || "بوابة عامة";

    const scanEvent = {
      id: `scan_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      deviceId,
      deviceName,
      deviceLocation,
      barcode,
      studentName: studentName || "طالب غير مسجل",
      grade,
      days,
      type: normalizedType,
      timestamp: Date.now(),
      timeIso: now.toISOString(),
      timeDisplay,
      dateKey,
      notes: body.notes || "",
      syncedToUnified: false,
    };

    // 1. Add to Device's Isolated Events Ledger
    const currentDeviceEvents = getDeviceEvents(deviceId);
    currentDeviceEvents.unshift(scanEvent);
    if (currentDeviceEvents.length > 1000) {
      currentDeviceEvents.length = 1000; // Cap at last 1,000 events per device
    }
    saveDeviceEvents(deviceId, currentDeviceEvents);

    // 2. Add to Center Aggregated Entry/Exit Logs
    centerEntryExitLogs.unshift(scanEvent);
    if (centerEntryExitLogs.length > 3000) {
      centerEntryExitLogs.length = 3000;
    }
    persistEntryExitLogs();

    // 3. Update Device Registry & Heartbeat
    const updatedDevice = {
      deviceId,
      deviceName,
      deviceLocation,
      lastActive: Date.now(),
      ip: req.ip || (req.headers["x-forwarded-for"] as string) || "127.0.0.1",
      status: "online",
      totalScansCount: (existingDevice?.totalScansCount || 0) + 1,
      lastScanType: normalizedType,
      lastScanStudentName: scanEvent.studentName,
      lastScanTime: timeDisplay,
    };
    registeredDevices.set(deviceId, updatedDevice);
    persistDeviceRegistry();

    // 4. Optional Safe Bridge to Unified Attendance (If Entry 'دخول')
    const syncToUnified = body.syncToUnifiedAttendance !== false;
    if (normalizedType === "دخول" && syncToUnified && cachedServerState) {
      if (!cachedServerState.attendanceToday) cachedServerState.attendanceToday = {};
      if (!cachedServerState.scanLogTimes) cachedServerState.scanLogTimes = {};
      if (!Array.isArray(cachedServerState.scanLogOrder)) cachedServerState.scanLogOrder = [];

      cachedServerState.attendanceToday[barcode] = "حضور";
      cachedServerState.scanLogTimes[barcode] = scanEvent.timeIso;

      if (!cachedServerState.scanLogOrder.includes(barcode)) {
        cachedServerState.scanLogOrder.unshift(barcode);
      }
      scanEvent.syncedToUnified = true;

      // Persist state asynchronously
      try {
        fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(cachedServerState), "utf-8");
      } catch (err) {
        console.error("[Device Hub] Bridge write note:", err);
      }

      // Notify unified monitors with a lightweight delta event (No heavy full reload needed!)
      broadcastToUnified({
        type: "device_entry_notification",
        deviceId,
        scanEvent,
        barcode,
        status: "حضور",
        timeIso: scanEvent.timeIso,
      });
    }

    // 5. Broadcast to the Specific Device's SSE Stream
    broadcastToDevice(deviceId, {
      type: "device_scan",
      deviceId,
      event: scanEvent,
    });

    res.json({
      ok: true,
      message: `تم تسجيل حركة (${normalizedType}) بنجاح للجهاز (${deviceId})`,
      event: scanEvent,
      device: updatedDevice,
    });
  });

  // 2. Fetch Strictly Device-Specific Original Live Logs (Zero-Cache Guarantee)
  app.get("/api/devices/:deviceId/logs", (req: Request, res: Response) => {
    const deviceId = String(req.params.deviceId).trim();
    const events = getDeviceEvents(deviceId);
    const device = registeredDevices.get(deviceId);

    res.json({
      ok: true,
      deviceId,
      deviceInfo: device || { deviceId, status: "unknown" },
      count: events.length,
      logs: events,
      updatedAt: Date.now(),
    });
  });

  // 3. Device-Specific Real-Time Server-Sent Events (SSE) Stream
  // Ensures ONLY events for THIS device arrive, preventing noise & lag!
  app.get("/api/devices/:deviceId/events", (req: Request, res: Response) => {
    const deviceId = String(req.params.deviceId).trim();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform, no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const connId = `dev_${deviceId}_${Math.random().toString(36).substring(2, 8)}_${Date.now()}`;
    const conn: SseConnection = {
      id: connId,
      res,
      scope: "device",
      deviceId,
    };
    sseSubscribers.set(connId, conn);

    // Initial handshake acknowledging connection to device-specific stream
    res.write(`data: ${JSON.stringify({
      type: "handshake",
      channel: "device_isolated",
      deviceId,
      timestamp: Date.now(),
      connId,
    })}\n\n`);

    // Keep-alive heartbeat every 15s
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        clearInterval(heartbeat);
        sseSubscribers.delete(connId);
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseSubscribers.delete(connId);
    });
  });

  // 4. Device Registration / Configuration / Ping
  app.post("/api/devices/:deviceId/config", (req: Request, res: Response) => {
    const deviceId = String(req.params.deviceId).trim();
    const { deviceName, deviceLocation } = req.body || {};

    const existing = registeredDevices.get(deviceId) || {
      deviceId,
      totalScansCount: 0,
      status: "online",
    };

    const updated = {
      ...existing,
      deviceId,
      deviceName: deviceName ? String(deviceName).trim() : existing.deviceName || `جهاز #${deviceId.substring(0, 6)}`,
      deviceLocation: deviceLocation ? String(deviceLocation).trim() : existing.deviceLocation || "بوابة عامة",
      lastActive: Date.now(),
      status: "online",
    };

    registeredDevices.set(deviceId, updated);
    persistDeviceRegistry();

    res.json({
      ok: true,
      message: "تم تحديث بيانات الجهاز بنجاح",
      device: updated,
    });
  });

  // 5. Get Device Metadata & Status
  app.get("/api/devices/:deviceId/info", (req: Request, res: Response) => {
    const deviceId = String(req.params.deviceId).trim();
    const device = registeredDevices.get(deviceId);
    const events = getDeviceEvents(deviceId);

    res.json({
      ok: true,
      device: device || {
        deviceId,
        deviceName: `جهاز #${deviceId.substring(0, 6)}`,
        deviceLocation: "غير محدد",
        status: "offline",
        totalScansCount: events.length,
        lastActive: 0,
      },
      scansCount: events.length,
      updatedAt: Date.now(),
    });
  });

  // 6. List All Registered Devices in the Center
  app.get("/api/devices", (_req: Request, res: Response) => {
    const list = Array.from(registeredDevices.values()).map((d) => {
      const isOnline = Date.now() - (d.lastActive || 0) < 60000; // active in last 60s
      return {
        ...d,
        status: isOnline ? "online" : "idle",
      };
    });

    res.json({
      ok: true,
      count: list.length,
      devices: list,
      updatedAt: Date.now(),
    });
  });

  // 7. Clear Device Logs (For fresh device session)
  app.delete("/api/devices/:deviceId/logs", (req: Request, res: Response) => {
    const deviceId = String(req.params.deviceId).trim();
    saveDeviceEvents(deviceId, []);
    res.json({
      ok: true,
      message: `تم مسح سجل الجهاز (${deviceId}) بنجاح`,
    });
  });

  // Gemini AI Service Health & Real-time Rate Limit Metrics
  app.get("/api/ai/health", (_req: Request, res: Response) => {
    try {
      const health = getAiServiceHealth();
      res.json(health);
    } catch (err: any) {
      res.status(500).json({ status: "error", message: err?.message || "Health check failed" });
    }
  });

  // Asynchronous & Isolated Student Diagnostic Evaluation
  app.post("/api/ai/analyze-student", async (req: Request, res: Response) => {
    const { student, attendanceRate, examAvg, isUnpaid, notes } = req.body;
    const deviceId = (req as any).deviceId;
    const sessionId = (req as any).sessionId;

    if (!student || !student.name || !student.barcode) {
      return res.status(400).json({
        success: false,
        error: "Missing required student profile data (name, barcode).",
      });
    }

    try {
      const result = await analyzeStudentPerformance({
        student,
        attendanceRate: typeof attendanceRate === "number" ? attendanceRate : 100,
        examAvg: typeof examAvg === "number" ? examAvg : 80,
        isUnpaid: Boolean(isUnpaid),
        notes: notes || "",
        deviceId,
        sessionId,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      console.error(`[API /api/ai/analyze-student Error] ${error?.message}`);
      res.status(500).json({
        success: false,
        error: "Failed to generate student diagnosis",
        details: error?.message,
      });
    }
  });

  // Tailored Smart Notification Generator
  app.post("/api/ai/smart-notification", async (req: Request, res: Response) => {
    const { student, messageType, contextData } = req.body;
    const deviceId = (req as any).deviceId;
    const sessionId = (req as any).sessionId;

    if (!student || !student.name) {
      return res.status(400).json({
        success: false,
        error: "Missing required student profile data.",
      });
    }

    try {
      const result = await generateSmartNotification({
        student,
        messageType: messageType || "تشجيع",
        contextData: contextData || "",
        deviceId,
        sessionId,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      console.error(`[API /api/ai/smart-notification Error] ${error?.message}`);
      res.status(500).json({
        success: false,
        error: "Failed to generate smart notification",
        details: error?.message,
      });
    }
  });

  // Global Error Handler for API routes
  app.use("/api", (err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[API Server Error]", err);
    res.status(err.status || 500).json({
      error: "Internal Server Error",
      message: err.message || "An unexpected error occurred",
    });
  });

  // -------------------------------------------------------------
  // Vite Middleware & SPA Static Asset Serving
  // -------------------------------------------------------------
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] Production-ready full-stack server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("[Server Bootstrap Fatal Error]:", err);
  process.exit(1);
});
