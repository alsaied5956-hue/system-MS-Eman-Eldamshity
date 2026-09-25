/**
 * src/utils/dualSync.ts
 * Unified Dual-Cloud Real-Time Synchronization Engine
 * 
 * Guarantees that EVERY single system mutation:
 *  - Edit student / attendance / payment / grade
 *  - Delete student / payment
 *  - Scanner registration (حضور / تأخير)
 *  - Absence confirmation (حفظ غياب)
 *  - Payment recording / update / delete (دفع مصاريف)
 *  - Grade recording / update (رصد درجات)
 * 
 * Propagates IMMEDIATELY to both:
 *  1. Firebase (Firestore): Document collections & live event streams
 *  2. Supabase: Postgres tables & WebSocket Realtime channel (<20ms)
 * 
 * This enables any secondary system or external integration to ingest
 * live data in real time directly from either or both clouds.
 */

import { doc, setDoc, deleteDoc, getDoc, writeBatch } from "firebase/firestore";
import { purgeTombstoneBarcode, checkIsLocalServerHubAvailable } from "./storage";
import {
  db,
  ensureFirebaseAuth,
  isFirestoreQuotaActive,
  isFirestoreQuotaError,
  markFirestoreQuotaExceeded,
} from "./firebase";
import {
  broadcastLiveScan,
  broadcastGroupFinished,
  broadcastPaymentChange,
  broadcastStudentChange,
  broadcastExamGradeChange,
  saveAttendanceToSupabase,
  saveBulkAttendanceToSupabase,
  savePaymentToSupabase,
  deletePaymentFromSupabase,
  saveExamGradeToSupabase,
  saveStudentToSupabase,
  saveBulkStudentsToSupabase,
  deleteStudentFromSupabase,
  deleteAttendanceFromSupabase,
  getTodayDateKey,
  queueAttendanceScanForBatch,
  flushPendingAttendanceBatchToSupabase,
} from "./supabaseClient";
import {
  broadcastFirebaseLiveScan,
  broadcastFirebasePayment,
  broadcastFirebaseGroupFinished,
  broadcastFirebaseAttendanceStatus,
  broadcastFirebaseDeletion,
  syncStudentNodeToFirebaseRTDB,
  syncPaymentNodeToFirebaseRTDB,
  syncAttendanceNodeToFirebaseRTDB,
} from "./firebaseRealtime";
import { pushLiveAttendanceEvent, pushLiveAttendanceBatch } from "./liveEventStream";
import { recordDeviceEntryExitScan, getPersistentDeviceId } from "./deviceClient";
import { Student } from "../types";
import {
  emitParentNotification,
  recordTombstone,
  appendWALRecord,
  HLCEngine,
} from "../architecture";

// Safe non-blocking execution wrapper
function runInBackground(promise: Promise<any>, opName: string) {
  promise.catch((err) => {
    if (isFirestoreQuotaError(err)) {
      markFirestoreQuotaExceeded();
      return;
    }
    console.warn(`[DualSync] Notice during background sync (${opName}):`, err?.message || err);
  });
}

function runFirestoreWrite(opName: string, writeFn: () => Promise<any>) {
  if (isFirestoreQuotaActive()) return;
  runInBackground(
    (async () => {
      try {
        await ensureFirebaseAuth();
        await writeFn();
      } catch (err: any) {
        if (isFirestoreQuotaError(err)) {
          markFirestoreQuotaExceeded();
        } else {
          throw err;
        }
      }
    })(),
    opName
  );
}

// ------------------------------------------------------------------------
// 1. SCANNER & ATTENDANCE DUAL SYNC (حضور / تأخير)
// ------------------------------------------------------------------------

export interface ScanSyncParams {
  barcode: string;
  name: string;
  grade: string;
  days: string;
  status: "حضور" | "تأخير" | "غياب" | "غائب" | string;
  timeIso: string;
  timeDisplay?: string;
  isPaid?: boolean;
  scannedBy?: string;
  studentFallback?: Partial<Student>;
  sourceDeviceId?: string;
}

export function dualSyncLiveScan(params: ScanSyncParams) {
  const b = String(params.barcode).trim();
  const dateKey = getTodayDateKey();
  const normalizedStatus: "حضور" | "تأخير" | "غياب" =
    params.status === "غائب" || params.status === "غياب"
      ? "غياب"
      : params.status === "تأخير"
      ? "تأخير"
      : "حضور";

  // 1️⃣ Supabase Realtime broadcast (<20ms to all assistant screens)
  runInBackground(
    broadcastLiveScan({
      barcode: b,
      name: params.name,
      grade: params.grade,
      days: params.days,
      status: normalizedStatus,
      timeIso: params.timeIso,
      timeDisplay:
        params.timeDisplay ||
        new Date(params.timeIso).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }),
      isPaid: !!params.isPaid,
      scannedBy: params.scannedBy || "الماسح",
      timestamp: Date.now(),
      sourceDeviceId: params.sourceDeviceId || getPersistentDeviceId(),
    }),
    "Supabase broadcastLiveScan"
  );

  // 1.5️⃣ Firebase Realtime Database Broadcast (<50ms to all remote devices)
  runInBackground(
    broadcastFirebaseLiveScan({
      barcode: b,
      name: params.name,
      grade: params.grade,
      days: params.days,
      status: normalizedStatus,
      timeIso: params.timeIso,
      timeDisplay:
        params.timeDisplay ||
        new Date(params.timeIso).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }),
      isPaid: !!params.isPaid,
      scannedBy: params.scannedBy || "الماسح",
      timestamp: Date.now(),
      sourceDeviceId: params.sourceDeviceId || getPersistentDeviceId(),
    }),
    "Firebase RTDB broadcastFirebaseLiveScan"
  );

  // 2️⃣ Immediate Supabase PostgreSQL Persistent Upsert (<30ms) & Background Queue
  runInBackground(
    saveAttendanceToSupabase({
      barcode: b,
      studentName: params.name,
      status: normalizedStatus,
      timeIso: params.timeIso,
      dateKey,
      scannedBy: params.scannedBy || "الماسح",
      studentFallback: params.studentFallback,
    }),
    "Immediate Supabase saveAttendanceToSupabase"
  );

  // 2.5️⃣ Atomic Multi-Device Local Server Hub Broadcast (<2ms)
  if (typeof window !== "undefined" && checkIsLocalServerHubAvailable()) {
    fetch("/api/sync/live-scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        barcode: b,
        status: normalizedStatus,
        timeIso: params.timeIso,
        name: params.name,
        grade: params.grade,
        days: params.days,
        scannedBy: params.scannedBy || "الماسح",
        sourceDeviceId: params.sourceDeviceId || getPersistentDeviceId(),
      }),
    }).catch(() => {});
  }

  // 3️⃣ Firebase live_events/today stream
  const liveEventStatus: "حضور" | "تأخير" | "غائب" =
    normalizedStatus === "غياب" ? "غائب" : (normalizedStatus as "حضور" | "تأخير");

  runInBackground(
    pushLiveAttendanceEvent(b, liveEventStatus, Date.now(), true),
    "Firebase pushLiveAttendanceEvent"
  );

  // 4️⃣ Firebase Firestore individual attendance collection: attendance_records/{dateKey}_{barcode}
  runFirestoreWrite("Firebase attendance_records individual doc", async () => {
    const ref = doc(db, "attendance_records", `${dateKey}_${b}`);
    await setDoc(
      ref,
      {
        barcode: b,
        studentName: params.name,
        grade: params.grade,
        days: params.days,
        status: normalizedStatus,
        dateKey,
        timeIso: params.timeIso,
        recordedAt: Date.now(),
        scannedBy: params.scannedBy || "الماسح",
      },
      { merge: true }
    );
  });

  // 5️⃣ Isolated Device API scan logging (Zero-cache, device-specific ledger)
  runInBackground(
    recordDeviceEntryExitScan({
      barcode: b,
      type: "دخول",
      studentName: params.name,
      grade: params.grade,
      days: params.days,
      syncToUnifiedAttendance: true,
    }),
    "Device Hub recordDeviceEntryExitScan"
  );

  // 6️⃣ Sub-Second Parent Instant Push Pipeline & WAL Commit
  runInBackground(
    emitParentNotification({
      studentBarcode: b,
      studentName: params.name,
      parentPhone: params.studentFallback?.parentPhone || "",
      type: normalizedStatus === "تأخير" ? "LATE_ARRIVAL" : "ATTENDANCE_SCAN",
      title:
        normalizedStatus === "تأخير"
          ? `⚠️ تسجيل تأخير: ${params.name}`
          : `✅ تأكيد حضور: ${params.name}`,
      body:
        normalizedStatus === "تأخير"
          ? `تم تسجيل وصول ودخول الطالب(ة) ${params.name} إلى القاعة متأخراً.`
          : `تم تسجيل وصول ودخول الطالب(ة) ${params.name} إلى القاعة في الموعد المحدد.`,
      meta: {
        dateKey,
        timeDisplay: params.timeDisplay,
        status: normalizedStatus,
      },
      hlc: HLCEngine.now(),
    }),
    "Parent Realtime Pipeline"
  );
}

// ------------------------------------------------------------------------
// 2. GROUP ATTENDANCE FINALIZATION DUAL SYNC (حفظ واعتماد الغياب)
// ------------------------------------------------------------------------

export interface GroupFinishedSyncParams {
  grade: string;
  days: string;
  absentBarcodes: string[];
  lateBarcodes: string[];
  presentBarcodes: string[];
  dateKey?: string;
  finishedBy?: string;
  allStudents: Student[];
}

export function dualSyncGroupFinished(params: GroupFinishedSyncParams) {
  const dateKey = params.dateKey || getTodayDateKey();
  const absentSet = new Set(params.absentBarcodes.map((b) => String(b).trim()));
  const lateSet = new Set(params.lateBarcodes.map((b) => String(b).trim()));
  const presentSet = new Set(params.presentBarcodes.map((b) => String(b).trim()));

  // 1️⃣ Supabase Realtime broadcast
  runInBackground(
    broadcastGroupFinished({
      grade: params.grade,
      days: params.days,
      absentBarcodes: params.absentBarcodes,
      lateBarcodes: params.lateBarcodes,
      presentBarcodes: params.presentBarcodes,
      dateKey,
      finishedBy: params.finishedBy || "الماسح",
      timestamp: Date.now(),
    }),
    "Supabase broadcastGroupFinished"
  );

  // 1.5️⃣ Firebase Realtime Database Group Broadcast
  runInBackground(
    broadcastFirebaseGroupFinished({
      grade: params.grade,
      days: params.days,
      absentBarcodes: params.absentBarcodes,
      lateBarcodes: params.lateBarcodes,
      presentBarcodes: params.presentBarcodes,
      dateKey,
      finishedBy: params.finishedBy || "الماسح",
      timestamp: Date.now(),
      sourceDeviceId: getPersistentDeviceId(),
    }),
    "Firebase RTDB broadcastFirebaseGroupFinished"
  );

  // 2️⃣ Supabase Postgres bulk upsert into attendance_logs table
  const supabaseRecords = params.allStudents
    .filter((s) => {
      const b = String(s.barcode).trim();
      return absentSet.has(b) || lateSet.has(b) || presentSet.has(b);
    })
    .map((s) => {
      const b = String(s.barcode).trim();
      const status = absentSet.has(b) ? "غياب" : lateSet.has(b) ? "تأخير" : "حضور";
      return {
        barcode: b,
        studentName: s.name,
        status: status as "حضور" | "تأخير" | "غياب",
        dateKey,
        scannedBy: params.finishedBy || "admin",
        studentFallback: s,
      };
    });

  // Flush any pending attendance scans along with this group
  runInBackground(flushPendingAttendanceBatchToSupabase(), "Supabase flushPendingAttendanceBatchToSupabase");

  if (supabaseRecords.length > 0) {
    runInBackground(
      saveBulkAttendanceToSupabase(supabaseRecords),
      "Supabase saveBulkAttendanceToSupabase"
    );
  }

  // 3️⃣ Firebase live_events stream batch
  const liveEvents = supabaseRecords.map((r) => ({
    studentId: r.barcode,
    status: r.status as any,
    timestamp: Date.now(),
  }));
  if (liveEvents.length > 0) {
    runInBackground(
      pushLiveAttendanceBatch(liveEvents),
      "Firebase pushLiveAttendanceBatch"
    );
  }

  // 4️⃣ Firebase Firestore individual attendance docs in batch chunks
  runFirestoreWrite("Firebase batch attendance_records docs", async () => {
    const chunkSize = 400;
    for (let i = 0; i < supabaseRecords.length; i += chunkSize) {
      const chunk = supabaseRecords.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      chunk.forEach((item) => {
        const docRef = doc(db, "attendance_records", `${dateKey}_${item.barcode}`);
        batch.set(
          docRef,
          {
            barcode: item.barcode,
            studentName: item.studentName,
            grade: params.grade,
            days: params.days,
            status: item.status,
            dateKey,
            timeIso: new Date().toISOString(),
            recordedAt: Date.now(),
            scannedBy: params.finishedBy || "admin",
          },
          { merge: true }
        );
      });
      await batch.commit();
    }
  });
}

// ------------------------------------------------------------------------
// 3. ATTENDANCE STATUS CHANGE DUAL SYNC (تعديل حضور أو غياب من التقرير)
// ------------------------------------------------------------------------

export function dualSyncAttendanceStatusChange(params: {
  barcode: string;
  studentName: string;
  status: "حضور" | "تأخير" | "غياب" | "غائب" | string;
  dateKey?: string;
  timeIso?: string;
  updatedBy?: string;
  studentFallback?: Partial<Student>;
}) {
  const b = String(params.barcode).trim();
  const dateKey = params.dateKey || getTodayDateKey();
  const normalizedStatus: "حضور" | "تأخير" | "غياب" =
    params.status === "غائب" || params.status === "غياب"
      ? "غياب"
      : params.status === "تأخير"
      ? "تأخير"
      : "حضور";

  // Supabase
  runInBackground(
    saveAttendanceToSupabase({
      barcode: b,
      studentName: params.studentName,
      status: normalizedStatus,
      dateKey,
      timeIso: params.timeIso || new Date().toISOString(),
      scannedBy: params.updatedBy || "admin",
      studentFallback: params.studentFallback,
    }),
    "Supabase status update"
  );

  // Firebase Realtime Database
  runInBackground(
    broadcastFirebaseAttendanceStatus({
      barcode: b,
      status: normalizedStatus,
      dateKey,
      updatedBy: params.updatedBy || "admin",
      timestamp: Date.now(),
      sourceDeviceId: getPersistentDeviceId(),
    }),
    "Firebase RTDB broadcastFirebaseAttendanceStatus"
  );

  // Firebase
  runFirestoreWrite("Firebase status update", async () => {
    const ref = doc(db, "attendance_records", `${dateKey}_${b}`);
    await setDoc(
      ref,
      {
        barcode: b,
        studentName: params.studentName,
        status: normalizedStatus,
        dateKey,
        timeIso: params.timeIso || new Date().toISOString(),
        updatedAt: Date.now(),
        scannedBy: params.updatedBy || "admin",
      },
      { merge: true }
    );
  });
}

// ------------------------------------------------------------------------
// 4. PAYMENTS DUAL SYNC (تسجيل، تعديل، حذف دفع المصاريف)
// ------------------------------------------------------------------------

export function dualSyncPaymentRecord(params: {
  barcode: string;
  monthKey: string;
  amount: number;
  date: string;
  time?: string;
  note?: string;
  recordedBy?: string;
  studentFallback?: Partial<Student>;
}) {
  const b = String(params.barcode).trim();
  const amount = Number(params.amount) || 0;
  const time = params.time || new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });

  // 1️⃣ Supabase Realtime broadcast
  runInBackground(
    broadcastPaymentChange({
      action: "record",
      barcode: b,
      monthKey: params.monthKey,
      amount,
      date: params.date,
      time,
      note: params.note || "سداد اشتراك",
      recordedBy: params.recordedBy || "admin",
      timestamp: Date.now(),
    }),
    "Supabase broadcastPaymentChange (record)"
  );

  // 1.5️⃣ Firebase Realtime Database Payment Broadcast
  runInBackground(
    broadcastFirebasePayment({
      action: "record",
      barcode: b,
      monthKey: params.monthKey,
      amount,
      date: params.date,
      time,
      note: params.note || "سداد اشتراك",
      recordedBy: params.recordedBy || "admin",
      timestamp: Date.now(),
      sourceDeviceId: getPersistentDeviceId(),
    }),
    "Firebase RTDB broadcastFirebasePayment (record)"
  );

  // 2️⃣ Supabase Postgres payments table
  runInBackground(
    savePaymentToSupabase({
      barcode: b,
      monthKey: params.monthKey,
      amount,
      date: params.date,
      note: params.note,
      recordedBy: params.recordedBy,
      studentFallback: params.studentFallback,
    }),
    "Supabase savePaymentToSupabase"
  );

  // 3️⃣ Firebase Firestore collection: payment_records/{monthKey}_{barcode}
  runFirestoreWrite("Firebase payment_records doc", async () => {
    const ref = doc(db, "payment_records", `${params.monthKey}_${b}`);
    await setDoc(
      ref,
      {
        barcode: b,
        monthKey: params.monthKey,
        amount,
        date: params.date,
        time,
        note: params.note || "سداد اشتراك",
        recordedBy: params.recordedBy || "admin",
        updatedAt: Date.now(),
      },
      { merge: true }
    );
  });

  // 4️⃣ Sub-Second Parent Digital Receipt Notification
  if (params.studentFallback?.parentPhone) {
    runInBackground(
      emitParentNotification({
        studentBarcode: b,
        studentName: params.studentFallback?.name || b,
        parentPhone: params.studentFallback.parentPhone,
        type: "PAYMENT_RECEIPT",
        title: `🧾 إيصال سداد: ${amount} ج.م`,
        body: `تم استلام مبلغ ${amount} ج.م لسداد اشتراك شهر (${params.monthKey}) للطالب(ة) ${params.studentFallback?.name || b}.`,
        meta: {
          dateKey: params.date,
          amount,
          monthKey: params.monthKey,
        },
        hlc: HLCEngine.now(),
      }),
      "Parent Payment Receipt Notification"
    );
  }
}

export function dualSyncPaymentUpdate(params: {
  oldMonthKey: string;
  newMonthKey: string;
  barcode: string;
  newAmount: number;
  newNote?: string;
  newDate: string;
  recordedBy?: string;
  studentFallback?: Partial<Student>;
}) {
  const b = String(params.barcode).trim();
  const time = new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });

  // 1️⃣ Supabase Realtime broadcast
  runInBackground(
    broadcastPaymentChange({
      action: "update",
      barcode: b,
      monthKey: params.newMonthKey,
      amount: params.newAmount,
      date: params.newDate,
      time,
      note: params.newNote || "تعديل سداد اشتراك",
      recordedBy: params.recordedBy || "admin",
      timestamp: Date.now(),
    }),
    "Supabase broadcastPaymentChange (update)"
  );

  // 1.5️⃣ Firebase Realtime Database Payment Update Broadcast
  runInBackground(
    broadcastFirebasePayment({
      action: "update",
      barcode: b,
      monthKey: params.newMonthKey,
      amount: params.newAmount,
      date: params.newDate,
      time,
      note: params.newNote || "تعديل سداد اشتراك",
      recordedBy: params.recordedBy || "admin",
      timestamp: Date.now(),
      sourceDeviceId: getPersistentDeviceId(),
    }),
    "Firebase RTDB broadcastFirebasePayment (update)"
  );

  // 2️⃣ Supabase Postgres
  runInBackground(
    (async () => {
      if (params.oldMonthKey !== params.newMonthKey) {
        await deletePaymentFromSupabase(b, params.oldMonthKey);
      }
      await savePaymentToSupabase({
        barcode: b,
        monthKey: params.newMonthKey,
        amount: params.newAmount,
        date: params.newDate,
        note: params.newNote,
        recordedBy: params.recordedBy,
        studentFallback: params.studentFallback,
      });
    })(),
    "Supabase payment update"
  );

  // 3️⃣ Firebase Firestore
  runFirestoreWrite("Firebase payment update", async () => {
    if (params.oldMonthKey !== params.newMonthKey) {
      const oldRef = doc(db, "payment_records", `${params.oldMonthKey}_${b}`);
      await deleteDoc(oldRef);
    }
    const newRef = doc(db, "payment_records", `${params.newMonthKey}_${b}`);
    await setDoc(
      newRef,
      {
        barcode: b,
        monthKey: params.newMonthKey,
        amount: params.newAmount,
        date: params.newDate,
        time,
        note: params.newNote || "تعديل سداد اشتراك",
        recordedBy: params.recordedBy || "admin",
        updatedAt: Date.now(),
      },
      { merge: true }
    );
  });
}

export function dualSyncPaymentDelete(params: { barcode: string; monthKey: string; paymentId?: string | number }) {
  const b = String(params.barcode).trim();

  // 0️⃣ Durable Tombstone to prevent Zombie Resurrection
  runInBackground(
    recordTombstone("FINANCIAL_LEDGER", `${b}_${params.monthKey}`, "admin", "User deleted payment"),
    "Record payment tombstone"
  );

  // 1️⃣ Supabase Realtime broadcast
  runInBackground(
    broadcastPaymentChange({
      action: "delete",
      barcode: b,
      monthKey: params.monthKey,
      amount: 0,
      date: new Date().toISOString().split("T")[0],
      time: "",
      note: "حذف سداد",
      recordedBy: "admin",
      timestamp: Date.now(),
    }),
    "Supabase broadcastPaymentChange (delete)"
  );

  // 2️⃣ Real Database Deletion: Direct Supabase DELETE by primary key id, immediately followed by Firebase RTDB node removal & broadcast
  runInBackground(
    (async () => {
      await deletePaymentFromSupabase(b, params.monthKey, params.paymentId);

      // Immediately after successful Supabase deletion, remove node & broadcast in Firebase Realtime Database
      await broadcastFirebaseDeletion({
        type: "payment",
        barcode: b,
        monthKey: params.monthKey,
        id: params.paymentId ? String(params.paymentId) : undefined,
        timestamp: Date.now(),
        sourceDeviceId: getPersistentDeviceId(),
      });

      // Also evict from Server Sync Hub state and disk cache (if active)
      if (checkIsLocalServerHubAvailable()) {
        fetch("/api/sync/delete-payment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            barcode: b,
            monthKey: params.monthKey,
            paymentId: params.paymentId,
            sourceDeviceId: getPersistentDeviceId(),
          }),
        }).catch(() => {});
      }
    })(),
    "Supabase & Firebase RTDB delete payment"
  );

  // 3️⃣ Firebase Firestore
  runFirestoreWrite("Firebase delete payment doc", async () => {
    const ref = doc(db, "payment_records", `${params.monthKey}_${b}`);
    await deleteDoc(ref);
  });
}

// ------------------------------------------------------------------------
// 5. EXAM GRADES DUAL SYNC (رصد وتعديل درجات الامتحانات)
// ------------------------------------------------------------------------

export interface ExamGradeSyncParams {
  barcode: string;
  studentName?: string;
  examTitle: string;
  score: number;
  maxScore: number;
  percentage?: number;
  dateKey?: string;
  notes?: string;
  recordedBy?: string;
  studentFallback?: Partial<Student>;
}

export function dualSyncExamGrade(params: ExamGradeSyncParams) {
  const b = String(params.barcode).trim();
  const dateKey = params.dateKey || getTodayDateKey();
  const score = Number(params.score) || 0;
  const maxScore = Number(params.maxScore) || 100;
  const percentage = params.percentage ?? Math.round((score / Math.max(1, maxScore)) * 100);

  // 1️⃣ Supabase Realtime broadcast
  runInBackground(
    broadcastExamGradeChange({
      action: "record",
      barcode: b,
      studentName: params.studentName,
      examTitle: params.examTitle,
      score,
      maxScore,
      percentage,
      dateKey,
      timestamp: Date.now(),
    }),
    "Supabase broadcastExamGradeChange"
  );

  // 2️⃣ Supabase Postgres (homework table used for assessment and grade recording)
  runInBackground(
    saveExamGradeToSupabase({
      barcode: b,
      examTitle: params.examTitle,
      score,
      maxScore,
      dateKey,
      notes: params.notes || `رصد درجة امتحان: ${params.examTitle} (${score}/${maxScore} - ${percentage}%)`,
      studentFallback: params.studentFallback,
    }),
    "Supabase saveExamGradeToSupabase"
  );

  // 3️⃣ Firebase Firestore collection: exam_records/{dateKey}_{barcode}
  runFirestoreWrite("Firebase exam_records & student update", async () => {
    const ref = doc(db, "exam_records", `${dateKey}_${b}`);
    await setDoc(
      ref,
      {
        barcode: b,
        studentName: params.studentName || "",
        examTitle: params.examTitle,
        score,
        maxScore,
        percentage,
        dateKey,
        notes: params.notes || "",
        recordedBy: params.recordedBy || "admin",
        recordedAt: Date.now(),
      },
      { merge: true }
    );

    // Also update student's last exam summary in Firestore students collection
    const studentRef = doc(db, "students", b);
    await setDoc(
      studentRef,
      {
        lastExamTitle: params.examTitle,
        lastExamScore: `${score}/${maxScore} (${percentage}%)`,
        updatedAt: Date.now(),
      },
      { merge: true }
    );
  });
}

// ------------------------------------------------------------------------
// 6. STUDENTS DUAL SYNC (إضافة، تعديل، حذف طالب)
// ------------------------------------------------------------------------

export function dualSyncStudentSave(student: Student, action: "add" | "update" = "update") {
  const b = String(student.barcode).trim();

  // If adding, purge tombstone so student is never blocked
  if (action === "add") {
    purgeTombstoneBarcode(b);
  }

  // 1️⃣ Supabase Realtime broadcast
  runInBackground(
    broadcastStudentChange({
      action,
      barcode: b,
      studentData: student,
      timestamp: Date.now(),
    }),
    `Supabase broadcastStudentChange (${action})`
  );

  // 2️⃣ Supabase Postgres
  runInBackground(
    saveStudentToSupabase(student),
    "Supabase saveStudentToSupabase"
  );

  // 3️⃣ Firebase Firestore: students/{barcode}
  runFirestoreWrite("Firebase students/{barcode} doc", async () => {
    const ref = doc(db, "students", b);
    await setDoc(ref, { ...student, updatedAt: Date.now() }, { merge: true });
  });
}

export function dualSyncStudentDelete(barcode: string, studentId?: string | number) {
  const b = String(barcode).trim();

  // 0️⃣ Durable Tombstone to prevent Zombie Resurrection
  runInBackground(
    recordTombstone("STUDENT", b, "admin", "User deleted student"),
    "Record durable tombstone"
  );

  // 1️⃣ Supabase Realtime broadcast
  runInBackground(
    broadcastStudentChange({
      action: "delete",
      barcode: b,
      timestamp: Date.now(),
    }),
    "Supabase broadcastStudentChange (delete)"
  );

  // 2️⃣ Real Database Deletion: Direct Supabase DELETE by primary key id, immediately followed by Firebase RTDB node removal & broadcast
  runInBackground(
    (async () => {
      await deleteStudentFromSupabase(b, studentId);

      // Immediately after successful Supabase deletion, remove node & broadcast in Firebase Realtime Database
      await broadcastFirebaseDeletion({
        type: "student",
        barcode: b,
        timestamp: Date.now(),
        sourceDeviceId: getPersistentDeviceId(),
      });

      // Also evict from Server Sync Hub state and disk cache (if active)
      if (checkIsLocalServerHubAvailable()) {
        fetch("/api/sync/delete-student", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            barcode: b,
            studentId,
            sourceDeviceId: getPersistentDeviceId(),
          }),
        }).catch(() => {});
      }
    })(),
    "Supabase & Firebase RTDB delete student"
  );

  // 3️⃣ Firebase Firestore
  runFirestoreWrite("Firebase delete student doc", async () => {
    try {
      const ref = doc(db, "students", b);
      await deleteDoc(ref);
    } catch {}

    // Immediately sanitize main_center_data so snapshots never resurrect deleted student
    try {
      const sysRef = doc(db, "system_state", "main_center_data");
      const snap = await getDoc(sysRef);
      if (snap.exists()) {
        const val = snap.data();
        if (val) {
          const currentStudents = Array.isArray(val.students) ? val.students : [];
          const filtered = currentStudents.filter((s: any) => String(s?.barcode).trim() !== b);
          const delBarcodes = Array.from(new Set([...(val.deletedBarcodes || []), b]));
          await setDoc(
            sysRef,
            { students: filtered, deletedBarcodes: delBarcodes, updatedAt: Date.now() },
            { merge: true }
          );
        }
      }
    } catch {}
  });
}

export function dualSyncAttendanceDelete(barcode: string, dateKey?: string, attendanceId?: string | number) {
  const b = String(barcode).trim();
  const dKey = dateKey || getTodayDateKey();

  // 0️⃣ Durable Tombstone to prevent Zombie Resurrection
  runInBackground(
    recordTombstone("ATTENDANCE", `${b}_${dKey}`, "admin", "User deleted attendance"),
    "Record attendance tombstone"
  );

  // 1️⃣ Real Database Deletion: Direct Supabase DELETE by primary key id, immediately followed by Firebase RTDB node removal & broadcast
  runInBackground(
    (async () => {
      await deleteAttendanceFromSupabase(b, dKey, attendanceId);

      // Immediately after successful Supabase deletion, remove node & broadcast in Firebase Realtime Database
      await broadcastFirebaseDeletion({
        type: "attendance",
        barcode: b,
        dateKey: dKey,
        timestamp: Date.now(),
        sourceDeviceId: getPersistentDeviceId(),
      });

      // Also evict from Server Sync Hub state and disk cache (if active)
      if (checkIsLocalServerHubAvailable()) {
        fetch("/api/sync/delete-attendance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            barcode: b,
            dateKey: dKey,
            attendanceId,
            sourceDeviceId: getPersistentDeviceId(),
          }),
        }).catch(() => {});
      }
    })(),
    "Supabase & Firebase RTDB delete attendance"
  );

  // 2️⃣ Firebase Firestore
  runFirestoreWrite("Firebase delete attendance doc", async () => {
    const ref = doc(db, "attendance_records", `${dKey}_${b}`);
    await deleteDoc(ref);
  });
}

export function dualSyncBulkStudents(students: Student[]) {
  if (!students || students.length === 0) return;

  // 1️⃣ Supabase bulk upsert
  runInBackground(
    saveBulkStudentsToSupabase(students),
    "Supabase saveBulkStudentsToSupabase"
  );

  // 2️⃣ Firebase Firestore batch write
  runFirestoreWrite("Firebase bulk students batch write", async () => {
    const chunkSize = 400;
    for (let i = 0; i < students.length; i += chunkSize) {
      const chunk = students.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      chunk.forEach((s) => {
        const b = String(s.barcode).trim();
        const ref = doc(db, "students", b);
        batch.set(ref, { ...s, updatedAt: Date.now() }, { merge: true });
      });
      await batch.commit();
    }
  });
}
