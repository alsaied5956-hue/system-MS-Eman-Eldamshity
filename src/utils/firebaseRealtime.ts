/**
 * src/utils/firebaseRealtime.ts
 * Firebase Realtime Database Live Multi-Device Broadcaster & Listener
 * Provides sub-50ms instant state synchronization between devices across different networks
 */

import { getDatabase, ref, set, onValue, Database } from "firebase/database";
import { app } from "./firebase";
import { FIREBASE_CONFIG } from "./envConfig";
import { LiveScanPayload, GroupFinishedPayload } from "./supabaseClient";

let rtdbInstance: Database | null = null;
let isRtdbAvailable = true;

export function getFirebaseRealtimeDb(): Database | null {
  if (!isRtdbAvailable) return null;
  if (rtdbInstance) return rtdbInstance;

  try {
    if (FIREBASE_CONFIG.databaseURL) {
      rtdbInstance = getDatabase(app, FIREBASE_CONFIG.databaseURL);
    } else {
      rtdbInstance = getDatabase(app);
    }
    return rtdbInstance;
  } catch (err: any) {
    console.warn("[Firebase RTDB] Notice initializing Realtime Database:", err?.message || err);
    isRtdbAvailable = false;
    return null;
  }
}

// -------------------------------------------------------------
// Broadcasters
// -------------------------------------------------------------

/**
 * Broadcast a live barcode scan over Firebase Realtime Database
 */
export async function broadcastFirebaseLiveScan(payload: LiveScanPayload): Promise<void> {
  const db = getFirebaseRealtimeDb();
  if (!db) return;

  try {
    const scanRef = ref(db, "live_events/latest_scan");
    await set(scanRef, {
      ...payload,
      _publishedAt: Date.now(),
    });
  } catch (err: any) {
    console.warn("[Firebase RTDB] Failed to publish live scan:", err?.message || err);
  }
}

/**
 * Broadcast a payment update over Firebase Realtime Database
 */
export async function broadcastFirebasePayment(payload: {
  action: "record" | "update" | "delete";
  barcode: string;
  monthKey: string;
  amount: number;
  date?: string;
  time?: string;
  note?: string;
  recordedBy?: string;
  timestamp: number;
  sourceDeviceId?: string;
}): Promise<void> {
  const db = getFirebaseRealtimeDb();
  if (!db) return;

  try {
    const paymentRef = ref(db, "live_events/latest_payment");
    await set(paymentRef, {
      ...payload,
      _publishedAt: Date.now(),
    });
  } catch (err: any) {
    console.warn("[Firebase RTDB] Failed to publish payment event:", err?.message || err);
  }
}

/**
 * Broadcast group finalization over Firebase Realtime Database
 */
export async function broadcastFirebaseGroupFinished(payload: GroupFinishedPayload & { sourceDeviceId?: string }): Promise<void> {
  const db = getFirebaseRealtimeDb();
  if (!db) return;

  try {
    const groupRef = ref(db, "live_events/latest_group");
    await set(groupRef, {
      ...payload,
      _publishedAt: Date.now(),
    });
  } catch (err: any) {
    console.warn("[Firebase RTDB] Failed to publish group finalization:", err?.message || err);
  }
}

/**
 * Broadcast attendance status change (حضور / تأخير / غياب)
 */
export async function broadcastFirebaseAttendanceStatus(payload: {
  barcode: string;
  status: "حضور" | "تأخير" | "غياب";
  dateKey: string;
  updatedBy: string;
  timestamp: number;
  sourceDeviceId?: string;
}): Promise<void> {
  const db = getFirebaseRealtimeDb();
  if (!db) return;

  try {
    const statusRef = ref(db, "live_events/latest_attendance_update");
    await set(statusRef, {
      ...payload,
      _publishedAt: Date.now(),
    });
  } catch (err: any) {
    console.warn("[Firebase RTDB] Failed to publish attendance status change:", err?.message || err);
  }
}

// -------------------------------------------------------------
// Subscriptions / Listeners
// -------------------------------------------------------------

/**
 * Listen for live scans broadcasted from other devices
 */
export function subscribeToFirebaseLiveScans(callback: (payload: LiveScanPayload) => void): () => void {
  const db = getFirebaseRealtimeDb();
  if (!db) return () => {};

  try {
    const scanRef = ref(db, "live_events/latest_scan");
    let isInitialMount = true;

    const unsubscribe = onValue(
      scanRef,
      (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.val();
        if (!data || !data.barcode) return;

        // Skip historical event that was already sitting in DB on startup
        if (isInitialMount) {
          isInitialMount = false;
          if (Date.now() - (data._publishedAt || 0) > 8000) {
            return;
          }
        }

        callback(data);
      },
      (error) => {
        console.warn("[Firebase RTDB] Scan subscription notice:", error.message);
      }
    );

    return () => {
      try {
        unsubscribe();
      } catch {}
    };
  } catch {
    return () => {};
  }
}

/**
 * Listen for payment updates broadcasted from other devices
 */
export function subscribeToFirebasePayments(callback: (payload: any) => void): () => void {
  const db = getFirebaseRealtimeDb();
  if (!db) return () => {};

  try {
    const paymentRef = ref(db, "live_events/latest_payment");
    let isInitialMount = true;

    const unsubscribe = onValue(
      paymentRef,
      (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.val();
        if (!data || !data.barcode) return;

        if (isInitialMount) {
          isInitialMount = false;
          if (Date.now() - (data._publishedAt || 0) > 8000) {
            return;
          }
        }

        callback(data);
      },
      (error) => {
        console.warn("[Firebase RTDB] Payment subscription notice:", error.message);
      }
    );

    return () => {
      try {
        unsubscribe();
      } catch {}
    };
  } catch {
    return () => {};
  }
}

/**
 * Listen for group finalization broadcasted from other devices
 */
export function subscribeToFirebaseGroups(callback: (payload: GroupFinishedPayload) => void): () => void {
  const db = getFirebaseRealtimeDb();
  if (!db) return () => {};

  try {
    const groupRef = ref(db, "live_events/latest_group");
    let isInitialMount = true;

    const unsubscribe = onValue(
      groupRef,
      (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.val();
        if (!data || !data.grade) return;

        if (isInitialMount) {
          isInitialMount = false;
          if (Date.now() - (data._publishedAt || 0) > 8000) {
            return;
          }
        }

        callback(data);
      },
      (error) => {
        console.warn("[Firebase RTDB] Group subscription notice:", error.message);
      }
    );

    return () => {
      try {
        unsubscribe();
      } catch {}
    };
  } catch {
    return () => {};
  }
}

/**
 * Listen for individual attendance status updates from other devices
 */
export function subscribeToFirebaseAttendanceStatus(callback: (payload: any) => void): () => void {
  const db = getFirebaseRealtimeDb();
  if (!db) return () => {};

  try {
    const statusRef = ref(db, "live_events/latest_attendance_update");
    let isInitialMount = true;

    const unsubscribe = onValue(
      statusRef,
      (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.val();
        if (!data || !data.barcode) return;

        if (isInitialMount) {
          isInitialMount = false;
          if (Date.now() - (data._publishedAt || 0) > 8000) {
            return;
          }
        }

        callback(data);
      },
      (error) => {
        console.warn("[Firebase RTDB] Attendance status subscription notice:", error.message);
      }
    );

    return () => {
      try {
        unsubscribe();
      } catch {}
    };
  } catch {
    return () => {};
  }
}
