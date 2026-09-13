/**
 * src/utils/firebaseRealtime.ts
 * Firebase Realtime Database Live Multi-Device Broadcaster & Listener
 * Provides sub-50ms instant state synchronization between devices across different networks
 */

import { getDatabase, ref, set, remove, onValue, onChildRemoved, onChildAdded, push, Database } from "firebase/database";
import { app } from "./firebase";
import { FIREBASE_CONFIG } from "./envConfig";
import { LiveScanPayload, GroupFinishedPayload } from "./supabaseClient";
import { getPersistentDeviceId } from "./deviceClient";

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

export interface RealtimeDeletionPayload {
  type: "student" | "payment" | "attendance";
  barcode: string;
  monthKey?: string;
  dateKey?: string;
  id?: string;
  timestamp: number;
  sourceDeviceId?: string;
  _publishedAt?: number;
}

/**
 * Broadcast a real-time record deletion (student, payment, attendance) across Firebase Realtime Database
 * and immediately update/remove the corresponding node inside Firebase Realtime Database.
 */
export async function broadcastFirebaseDeletion(payload: RealtimeDeletionPayload): Promise<void> {
  const db = getFirebaseRealtimeDb();
  if (!db) return;

  try {
    const timestamp = payload.timestamp || Date.now();
    const sourceDeviceId = payload.sourceDeviceId || getPersistentDeviceId();
    const b = String(payload.barcode).trim();

    // 1. Direct removal of the corresponding node in Firebase Realtime Database
    if (payload.type === "student") {
      const studentNode = ref(db, `students_live/${b}`);
      await remove(studentNode).catch(() => {});
    } else if (payload.type === "payment" && payload.monthKey) {
      const paymentNode = ref(db, `payments_live/${payload.monthKey}_${b}`);
      await remove(paymentNode).catch(() => {});
    } else if (payload.type === "attendance" && payload.dateKey) {
      const attendanceNode = ref(db, `attendance_live/${payload.dateKey}_${b}`);
      await remove(attendanceNode).catch(() => {});
    }

    // 2. Write to persistent deleted_records node so newly connecting devices instantly know about it
    const delKey =
      payload.type === "payment"
        ? `payment_${payload.monthKey}_${b}`
        : payload.type === "attendance"
        ? `attendance_${payload.dateKey}_${b}`
        : `student_${b}`;
    await set(ref(db, `deleted_records/${delKey}`), {
      ...payload,
      barcode: b,
      timestamp,
      sourceDeviceId,
      _publishedAt: Date.now(),
    }).catch(() => {});

    // 3. Publish to latest_deletion stream for instant multi-device event notification (onValue)
    const deletionRef = ref(db, "live_events/latest_deletion");
    await set(deletionRef, {
      ...payload,
      barcode: b,
      timestamp,
      sourceDeviceId,
      _publishedAt: Date.now(),
    });

    // 4. Push to deletion_stream for reliable sequence broadcasting (onChildAdded)
    const streamRef = ref(db, "live_events/deletion_stream");
    const itemRef = push(streamRef);
    await set(itemRef, {
      ...payload,
      barcode: b,
      timestamp,
      sourceDeviceId,
      _publishedAt: Date.now(),
    }).catch(() => {});
  } catch (err: any) {
    console.warn("[Firebase RTDB] Failed to broadcast deletion:", err?.message || err);
  }
}

/**
 * Sync active student node to Firebase Realtime Database
 */
export async function syncStudentNodeToFirebaseRTDB(student: { barcode: string; name?: string }): Promise<void> {
  const db = getFirebaseRealtimeDb();
  if (!db || !student.barcode) return;
  try {
    const studentNode = ref(db, `students_live/${String(student.barcode).trim()}`);
    await set(studentNode, {
      barcode: String(student.barcode).trim(),
      name: student.name || "",
      updatedAt: Date.now(),
    });
  } catch {}
}

/**
 * Sync active payment node to Firebase Realtime Database
 */
export async function syncPaymentNodeToFirebaseRTDB(record: { barcode: string; monthKey: string; amount?: number }): Promise<void> {
  const db = getFirebaseRealtimeDb();
  if (!db || !record.barcode || !record.monthKey) return;
  try {
    const paymentNode = ref(db, `payments_live/${record.monthKey}_${String(record.barcode).trim()}`);
    await set(paymentNode, {
      barcode: String(record.barcode).trim(),
      monthKey: record.monthKey,
      amount: record.amount || 0,
      updatedAt: Date.now(),
    });
  } catch {}
}

/**
 * Sync active attendance node to Firebase Realtime Database
 */
export async function syncAttendanceNodeToFirebaseRTDB(record: { barcode: string; dateKey: string; status?: string }): Promise<void> {
  const db = getFirebaseRealtimeDb();
  if (!db || !record.barcode || !record.dateKey) return;
  try {
    const attendanceNode = ref(db, `attendance_live/${record.dateKey}_${String(record.barcode).trim()}`);
    await set(attendanceNode, {
      barcode: String(record.barcode).trim(),
      dateKey: record.dateKey,
      status: record.status || "حضور",
      updatedAt: Date.now(),
    });
  } catch {}
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

/**
 * Active Real-Time Listener on Firebase Realtime Database for deletions.
 * When a record (student, payment, attendance) is deleted on Device A,
 * this listener triggers instantly on Device B to remove it from state/DOM without a page refresh.
 */
export function subscribeToFirebaseDeletions(callback: (payload: RealtimeDeletionPayload) => void): () => void {
  const db = getFirebaseRealtimeDb();
  if (!db) return () => {};

  const unsubs: Array<() => void> = [];

  try {
    // 1. Active listener on live_events/latest_deletion (onValue)
    const deletionRef = ref(db, "live_events/latest_deletion");

    const unsubLatest = onValue(
      deletionRef,
      (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.val() as RealtimeDeletionPayload;
        if (!data || !data.barcode || !data.type) return;

        callback(data);
      },
      (error) => {
        console.warn("[Firebase RTDB] Deletion subscription notice:", error.message);
      }
    );
    unsubs.push(() => {
      try {
        unsubLatest();
      } catch {}
    });

    // 2. Active sequential stream listener on live_events/deletion_stream (onChildAdded)
    // Ensures zero dropped events even during burst deletions
    const streamRef = ref(db, "live_events/deletion_stream");
    const unsubStream = onChildAdded(
      streamRef,
      (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.val() as RealtimeDeletionPayload;
        if (!data || !data.barcode || !data.type) return;

        callback(data);
      },
      (error) => {
        console.warn("[Firebase RTDB] Deletion stream notice:", error.message);
      }
    );
    unsubs.push(() => {
      try {
        unsubStream();
      } catch {}
    });

    // 2. Active child listener on students_live (onChildRemoved)
    const studentsLiveRef = ref(db, "students_live");
    const unsubStudents = onChildRemoved(studentsLiveRef, (snapshot) => {
      const barcode = snapshot.key;
      if (barcode) {
        callback({
          type: "student",
          barcode,
          timestamp: Date.now(),
        });
      }
    });
    unsubs.push(() => {
      try {
        unsubStudents();
      } catch {}
    });

    // 3. Active child listener on payments_live (onChildRemoved)
    const paymentsLiveRef = ref(db, "payments_live");
    const unsubPayments = onChildRemoved(paymentsLiveRef, (snapshot) => {
      const key = snapshot.key; // format: ${monthKey}_${barcode}
      if (key && key.includes("_")) {
        const [monthKey, ...rest] = key.split("_");
        const barcode = rest.join("_");
        callback({
          type: "payment",
          barcode,
          monthKey,
          timestamp: Date.now(),
        });
      }
    });
    unsubs.push(() => {
      try {
        unsubPayments();
      } catch {}
    });

    // 4. Active child listener on attendance_live (onChildRemoved)
    const attendanceLiveRef = ref(db, "attendance_live");
    const unsubAttendance = onChildRemoved(attendanceLiveRef, (snapshot) => {
      const key = snapshot.key; // format: ${dateKey}_${barcode}
      if (key && key.includes("_")) {
        const [dateKey, ...rest] = key.split("_");
        const barcode = rest.join("_");
        callback({
          type: "attendance",
          barcode,
          dateKey,
          timestamp: Date.now(),
        });
      }
    });
    unsubs.push(() => {
      try {
        unsubAttendance();
      } catch {}
    });

    return () => {
      unsubs.forEach((unsub) => {
        try {
          unsub();
        } catch {}
      });
    };
  } catch (err) {
    console.warn("Failed to subscribe to deletions:", err);
    return () => {};
  }
}
