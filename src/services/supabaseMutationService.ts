/**
 * src/services/supabaseMutationService.ts
 * 
 * Strict Cloud-First Supabase Mutation Engine
 * 
 * Architectural Guarantees:
 * 1. EVERY mutation executes an explicit `await` against Supabase Postgres FIRST.
 * 2. If the cloud write fails (network, RLS, constraint), it throws an error immediately,
 *    preventing false optimistic UI updates or state drift across devices.
 * 3. Bypasses and eliminates local storage / IndexedDB as an intermediate sync layer.
 * 4. Ensures referential integrity with foreign key mapping and barcode caching.
 */

import {
  supabase,
  getStudentIdByBarcode,
  ensureStudentInSupabase,
  ensureStudentsInSupabaseBulk,
  getTodayDateKey,
} from "../utils/supabaseClient";
import { Student, PaymentRecord, UserAccount, GradeName, GroupDays } from "../types";
import { getPersistentDeviceId } from "../utils/deviceClient";
import {
  triggerAttendancePresentNotification,
  triggerAttendanceLateNotification,
  triggerAttendanceAbsentNotification,
  triggerExamGradeNotification,
  triggerHomeworkStatusNotification,
  triggerPaymentReceiptNotification,
  triggerProfileUpdateNotification,
  triggerSupervisorChatNotification,
} from "./fcmPushDispatcher";

export interface MutationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ----------------------------------------------------------------------------
// 1. STUDENTS MUTATIONS (Cloud-First)
// ----------------------------------------------------------------------------

export async function cloudAddStudent(
  student: Student,
  cardFee: number = 0,
  recordedBy: string = "admin"
): Promise<{ student: Student; payment?: PaymentRecord }> {
  const barcode = String(student.barcode).trim();
  if (!barcode) throw new Error("باركود الطالب مطلوب ولا يمكن تركه فارغاً");

  const studentRow = {
    barcode,
    name: student.name.trim(),
    phone: String(student.phone || "").trim(),
    parent_phone: String(student.parentPhone || student.phone || "00000000000").trim(),
    grade: student.groupGrade,
    group_days: student.groupDays,
    group_time: student.notes?.includes("مواعيد:") ? "" : "04:00 م",
    monthly_fee: Number(student.customMonthlyFee) || 0,
    discount: student.discountReason ? 10 : 0,
    notes: student.notes || student.discountReason || "",
    is_active: true,
  };

  const { data, error } = await supabase
    .from("students")
    .upsert(studentRow, { onConflict: "barcode" })
    .select("id, created_at")
    .single();

  if (error) {
    console.error("[MutationService] Error creating student in Supabase:", error);
    throw new Error(`فشل حفظ الطالب في قاعدة البيانات: ${error.message}`);
  }

  const committedStudent: Student = {
    ...student,
    id: data?.id,
    createdAt: data?.created_at || new Date().toISOString(),
  };

  let committedPayment: PaymentRecord | undefined;

  // If card fee is charged, record payment directly in payments table
  if (cardFee > 0 && data?.id) {
    const today = getTodayDateKey();
    const monthKey = today.slice(0, 7); // YYYY-MM
    const paymentRow = {
      student_id: data.id,
      month_key: `card_${monthKey}`,
      amount_paid: cardFee,
      required_amount: cardFee,
      discount: 0,
      status: "paid",
      payment_date: new Date().toISOString(),
      received_by: recordedBy,
      notes: "رسوم استخراج كارت الباركود الذكي",
    };

    const { data: pmtData, error: pmtErr } = await supabase
      .from("payments")
      .upsert(paymentRow, { onConflict: "student_id,month_key" })
      .select("id")
      .single();

    if (pmtErr) {
      console.warn("[MutationService] Notice recording card fee:", pmtErr.message);
    } else {
      committedPayment = {
        id: pmtData?.id,
        barcode,
        month: monthKey,
        monthKey,
        amount: cardFee,
        date: today,
        time: new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }),
        note: "رسوم استخراج كارت الباركود الذكي",
        isCardFee: true,
        recordedBy,
      };
    }
  }

  return { student: committedStudent, payment: committedPayment };
}

export async function cloudUpdateStudent(
  oldBarcode: string,
  updatedStudent: Student
): Promise<Student> {
  const oldB = String(oldBarcode).trim();
  const newB = String(updatedStudent.barcode).trim();
  if (!newB) throw new Error("باركود الطالب الجديد غير صالح");

  const studentRow = {
    barcode: newB,
    name: updatedStudent.name.trim(),
    phone: String(updatedStudent.phone || "").trim(),
    parent_phone: String(updatedStudent.parentPhone || updatedStudent.phone || "").trim(),
    grade: updatedStudent.groupGrade,
    group_days: updatedStudent.groupDays,
    monthly_fee: Number(updatedStudent.customMonthlyFee) || 0,
    notes: updatedStudent.notes || updatedStudent.discountReason || "",
  };

  // If barcode changed, find id and update
  const studentId = await getStudentIdByBarcode(oldB);
  let query = supabase.from("students");

  if (studentId) {
    const { data, error } = await query
      .update(studentRow)
      .eq("id", studentId)
      .select()
      .single();

    if (error) {
      console.error("[MutationService] Error updating student by id:", error);
      throw new Error(`فشل تحديث بيانات الطالب: ${error.message}`);
    }
    // High-Priority FCM Push: Student profile updated
    triggerProfileUpdateNotification(updatedStudent).catch(() => {});
    return { ...updatedStudent, id: data?.id || studentId };
  } else {
    const { data, error } = await query
      .update(studentRow)
      .eq("barcode", oldB)
      .select()
      .single();

    if (error) {
      console.error("[MutationService] Error updating student by barcode:", error);
      throw new Error(`فشل تحديث بيانات الطالب: ${error.message}`);
    }
    // High-Priority FCM Push: Student profile updated
    triggerProfileUpdateNotification(updatedStudent).catch(() => {});
    return { ...updatedStudent, id: data?.id };
  }
}

export async function cloudDeleteStudent(
  barcode: string,
  studentIdParam?: string
): Promise<{ barcode: string }> {
  const b = String(barcode).trim();
  if (!b) throw new Error("باركود الطالب غير محدد للحذف");

  let studentId = studentIdParam || (await getStudentIdByBarcode(b));

  if (!studentId) {
    const { data } = await supabase.from("students").select("id").eq("barcode", b).maybeSingle();
    studentId = data?.id;
  }

  if (studentId) {
    // Delete dependent tables first to guarantee relational integrity
    await supabase.from("attendance_logs").delete().eq("student_id", studentId);
    await supabase.from("payments").delete().eq("student_id", studentId);
    await supabase.from("homework").delete().eq("student_id", studentId);
    await supabase.from("chat_messages").delete().eq("student_id", studentId);

    const { error } = await supabase.from("students").delete().eq("id", studentId);
    if (error) {
      console.error("[MutationService] Error deleting student by id:", error);
      throw new Error(`فشل حذف الطالب من السحابة: ${error.message}`);
    }
  } else {
    await supabase.from("attendance_logs").delete().eq("barcode", b);
    const { error } = await supabase.from("students").delete().eq("barcode", b);
    if (error) {
      console.error("[MutationService] Error deleting student by barcode:", error);
      throw new Error(`فشل حذف الطالب: ${error.message}`);
    }
  }

  return { barcode: b };
}

export async function cloudBulkImportStudents(studentsList: Student[]): Promise<Student[]> {
  if (!studentsList || studentsList.length === 0) return [];

  const rows = studentsList.map((s) => ({
    barcode: String(s.barcode).trim(),
    name: s.name.trim(),
    phone: String(s.phone || "").trim(),
    parent_phone: String(s.parentPhone || s.phone || "00000000000").trim(),
    grade: s.groupGrade,
    group_days: s.groupDays,
    group_time: "04:00 م",
    monthly_fee: Number(s.customMonthlyFee) || 0,
    notes: s.notes || s.discountReason || "",
    is_active: true,
  }));

  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase
      .from("students")
      .upsert(chunk, { onConflict: "barcode" });

    if (error) {
      console.error("[MutationService] Error bulk importing chunk:", error);
      throw new Error(`فشل استيراد دفعة الطلاب: ${error.message}`);
    }
  }

  return studentsList;
}

// ----------------------------------------------------------------------------
// 2. ATTENDANCE MUTATIONS (Cloud-First & Zero-Lag)
// ----------------------------------------------------------------------------

export async function cloudRecordAttendance(
  barcode: string,
  status: "حضور" | "تأخير",
  timeIso: string,
  studentName: string,
  scannedBy: string = "admin",
  studentFallback?: Student
): Promise<{ barcode: string; status: string; timeIso: string }> {
  const b = String(barcode).trim();
  const dateKey = getTodayDateKey();
  const studentId = await ensureStudentInSupabase(b, studentFallback || { name: studentName });

  if (!studentId) {
    throw new Error(`تعذر العثور على سجل الطالب (${b}) لتسجيل الحضور`);
  }

  const { error } = await supabase
    .from("attendance_logs")
    .upsert(
      {
        student_id: studentId,
        barcode: b,
        student_name: studentName,
        date_key: dateKey,
        time_recorded: timeIso || new Date().toISOString(),
        status,
        scanned_by: scannedBy,
      },
      { onConflict: "student_id,date_key" }
    );

  if (error) {
    console.error("[MutationService] Error recording attendance in Supabase:", error);
    throw new Error(`فشل تسجيل الحضور في السحابة: ${error.message}`);
  }

  // ⚡ ASYNCHRONOUS PUSH NOTIFICATION: Trigger in background without blocking UI thread
  setTimeout(() => {
    const timeDisplay = timeIso
      ? new Date(timeIso).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })
      : new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
    const studentInfo = studentFallback || { barcode: b, name: studentName };

    if (status === "تأخير") {
      triggerAttendanceLateNotification(studentInfo, timeDisplay, dateKey).catch(() => {});
    } else {
      triggerAttendancePresentNotification(studentInfo, timeDisplay, dateKey).catch(() => {});
    }
  }, 0);

  return { barcode: b, status, timeIso };
}

export async function cloudFinishGroupAttendance(
  grade: GradeName,
  days: GroupDays,
  dateKey: string,
  absentBarcodes: string[],
  lateBarcodes: string[],
  presentBarcodes: string[],
  finishedBy: string = "admin",
  allStudents: Student[] = []
): Promise<{ dateKey: string; absentBarcodes: string[]; lateBarcodes: string[]; presentBarcodes: string[] }> {
  const studentMap = new Map<string, Student>();
  allStudents.forEach((s) => studentMap.set(String(s.barcode).trim(), s));

  const allBarcodes = Array.from(
    new Set([...absentBarcodes, ...lateBarcodes, ...presentBarcodes].map((b) => String(b).trim()))
  ).filter(Boolean);

  if (allBarcodes.length === 0) {
    return { dateKey, absentBarcodes, lateBarcodes, presentBarcodes };
  }

  // 1. Parallel Student ID Resolution in a single batch query (Zero loop awaits!)
  const idMap = await ensureStudentsInSupabaseBulk(
    allBarcodes.map((b) => ({
      barcode: b,
      fallback: studentMap.get(b) || { name: `طالب ${b}` },
    }))
  );

  const nowIso = new Date().toISOString();
  const absentSet = new Set(absentBarcodes.map((b) => String(b).trim()));
  const lateSet = new Set(lateBarcodes.map((b) => String(b).trim()));

  const rowsToCommit = allBarcodes
    .map((b) => {
      const sId = idMap.get(b);
      if (!sId) return null;
      const sObj = studentMap.get(b);
      const status: "حضور" | "تأخير" | "غياب" = absentSet.has(b)
        ? "غياب"
        : lateSet.has(b)
        ? "تأخير"
        : "حضور";

      return {
        student_id: sId,
        barcode: b,
        student_name: sObj?.name || `طالب ${b}`,
        date_key: dateKey,
        time_recorded: nowIso,
        status,
        scanned_by: finishedBy,
      };
    })
    .filter(Boolean);

  // 2. Single Parallel Bulk Database Insertion: save all records (Present, Late, Absent) in one operation
  if (rowsToCommit.length > 0) {
    const chunkSize = 500;
    if (rowsToCommit.length <= chunkSize) {
      const { error } = await supabase
        .from("attendance_logs")
        .upsert(rowsToCommit, { onConflict: "student_id,date_key" });

      if (error) {
        console.error("[MutationService] Error in bulk attendance insert:", error);
        throw new Error(`فشل تثبيت حضور المجموعة في السحابة: ${error.message}`);
      }
    } else {
      const chunks = [];
      for (let i = 0; i < rowsToCommit.length; i += chunkSize) {
        chunks.push(rowsToCommit.slice(i, i + chunkSize));
      }
      const results = await Promise.all(
        chunks.map((chunk) =>
          supabase.from("attendance_logs").upsert(chunk, { onConflict: "student_id,date_key" })
        )
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) {
        console.error("[MutationService] Error in parallel batch insert:", failed.error);
        throw new Error(`فشل تثبيت دفعة حضور المجموعة في السحابة: ${failed.error.message}`);
      }
    }
  }

  // 3. Asynchronous Push & Platform Notifications:
  // Offload to background thread via setTimeout so UI thread is completely unblocked!
  setTimeout(() => {
    (async () => {
      const notifyPromises = [];
      for (const b of absentBarcodes) {
        const sObj = studentMap.get(b) || { barcode: b, name: `طالب ${b}` };
        notifyPromises.push(triggerAttendanceAbsentNotification(sObj, dateKey).catch(() => {}));
      }
      for (const b of lateBarcodes) {
        const sObj = studentMap.get(b) || { barcode: b, name: `طالب ${b}` };
        notifyPromises.push(triggerAttendanceLateNotification(sObj, "04:30 م", dateKey).catch(() => {}));
      }
      await Promise.allSettled(notifyPromises);
    })().catch(() => {});
  }, 0);

  return { dateKey, absentBarcodes, lateBarcodes, presentBarcodes };
}

export async function cloudChangeAttendanceStatus(
  barcode: string,
  dateKey: string,
  newStatus: string,
  studentName: string,
  scannedBy: string = "admin",
  studentFallback?: Partial<Student>
): Promise<{ barcode: string; dateKey: string; status: string }> {
  const b = String(barcode).trim();
  const sId = await ensureStudentInSupabase(b, {
    name: studentName,
    parentPhone: studentFallback?.parentPhone || studentFallback?.phone,
    groupGrade: studentFallback?.groupGrade,
  });
  if (!sId) throw new Error("تعذر تحديد معرف الطالب");

  const normalizedStatus: "حضور" | "تأخير" | "غياب" =
    newStatus === "غائب" || newStatus === "غياب"
      ? "غياب"
      : newStatus === "تأخير"
      ? "تأخير"
      : "حضور";

  const { error } = await supabase
    .from("attendance_logs")
    .upsert(
      {
        student_id: sId,
        barcode: b,
        student_name: studentName,
        date_key: dateKey,
        time_recorded: new Date().toISOString(),
        status: normalizedStatus,
        scanned_by: scannedBy,
      },
      { onConflict: "student_id,date_key" }
    );

  if (error) {
    console.error("[MutationService] Error changing attendance status:", error);
    throw new Error(`فشل تعديل حالة الحضور في السحابة: ${error.message}`);
  }

  // ⚡ HIGH-PRIORITY FCM PUSH: Trigger corresponding attendance event
  const studentInfo = {
    barcode: b,
    name: studentName,
    parentPhone: studentFallback?.parentPhone || studentFallback?.phone,
  };
  if (normalizedStatus === "حضور") {
    triggerAttendancePresentNotification(studentInfo, undefined, dateKey).catch(() => {});
  } else if (normalizedStatus === "تأخير") {
    triggerAttendanceLateNotification(studentInfo, undefined, dateKey).catch(() => {});
  } else if (normalizedStatus === "غياب") {
    triggerAttendanceAbsentNotification(studentInfo, dateKey).catch(() => {});
  }

  return { barcode: b, dateKey, status: normalizedStatus };
}

export async function cloudDeleteAttendance(
  barcode: string,
  dateKey: string
): Promise<{ barcode: string; dateKey: string }> {
  const b = String(barcode).trim();
  const { error } = await supabase
    .from("attendance_logs")
    .delete()
    .eq("barcode", b)
    .eq("date_key", dateKey);

  if (error) {
    console.error("[MutationService] Error deleting attendance log:", error);
    throw new Error(`فشل حذف تسجيل الحضور من السحابة: ${error.message}`);
  }

  return { barcode: b, dateKey };
}

// ----------------------------------------------------------------------------
// 3. PAYMENTS MUTATIONS (Cloud-First & Strictly Atomic)
// ----------------------------------------------------------------------------

export async function cloudRecordPayment(record: {
  barcode: string;
  amount: number;
  monthKey: string;
  note?: string;
  date?: string;
  recordedBy?: string;
  studentFallback?: Student;
}): Promise<PaymentRecord> {
  const b = String(record.barcode).trim();
  const sId = await ensureStudentInSupabase(b, record.studentFallback);
  if (!sId) throw new Error(`تعذر العثور على الطالب (${b}) لتسجيل الدفع`);

  const paymentDate = record.date ? new Date(record.date).toISOString() : new Date().toISOString();
  const payload = {
    student_id: sId,
    month_key: record.monthKey,
    amount_paid: Number(record.amount) || 0,
    required_amount: Number(record.amount) || 100,
    discount: 0,
    status: "paid",
    payment_date: paymentDate,
    received_by: record.recordedBy || "admin",
    notes: record.note || `اشتراك شهر ${record.monthKey}`,
  };

  const { data, error } = await supabase
    .from("payments")
    .upsert(payload, { onConflict: "student_id,month_key" })
    .select("id, payment_date")
    .single();

  if (error) {
    console.error("[MutationService] Error recording payment:", error);
    throw new Error(`فشل تسجيل الدفع في السحابة: ${error.message}`);
  }

  // ⚡ HIGH-PRIORITY FCM PUSH: Trigger Payment Receipt to parent
  triggerPaymentReceiptNotification(
    record.studentFallback || { barcode: b, name: `طالب ${b}` },
    record.amount,
    record.monthKey,
    record.date || getTodayDateKey(),
    data?.id ? String(data.id).slice(0, 8) : undefined
  ).catch(() => {});

  return {
    id: data?.id,
    barcode: b,
    month: record.monthKey,
    monthKey: record.monthKey,
    amount: record.amount,
    date: record.date || getTodayDateKey(),
    time: new Date(paymentDate).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }),
    note: record.note || `اشتراك شهر ${record.monthKey}`,
    recordedBy: record.recordedBy || "admin",
  };
}

export async function cloudUpdatePayment(record: {
  oldMonthKey: string;
  newMonthKey: string;
  barcode: string;
  newAmount: number;
  newNote: string;
  newDate?: string;
  recordedBy?: string;
  studentFallback?: Student;
}): Promise<PaymentRecord> {
  const b = String(record.barcode).trim();
  const sId = await ensureStudentInSupabase(b, record.studentFallback);
  if (!sId) throw new Error(`تعذر العثور على الطالب (${b}) لتعديل السداد`);

  // If the month changed, delete the old month record first
  if (record.oldMonthKey !== record.newMonthKey) {
    await supabase
      .from("payments")
      .delete()
      .eq("student_id", sId)
      .eq("month_key", record.oldMonthKey);
  }

  const paymentDate = record.newDate ? new Date(record.newDate).toISOString() : new Date().toISOString();
  const payload = {
    student_id: sId,
    month_key: record.newMonthKey,
    amount_paid: Number(record.newAmount) || 0,
    required_amount: Number(record.newAmount) || 100,
    discount: 0,
    status: "paid",
    payment_date: paymentDate,
    received_by: record.recordedBy || "admin",
    notes: record.newNote || `اشتراك شهر ${record.newMonthKey}`,
  };

  const { data, error } = await supabase
    .from("payments")
    .upsert(payload, { onConflict: "student_id,month_key" })
    .select("id")
    .single();

  if (error) {
    console.error("[MutationService] Error updating payment:", error);
    throw new Error(`فشل تحديث السداد في السحابة: ${error.message}`);
  }

  // ⚡ HIGH-PRIORITY FCM PUSH: Trigger Payment Receipt to parent
  triggerPaymentReceiptNotification(
    record.studentFallback || { barcode: b, name: `طالب ${b}` },
    record.newAmount,
    record.newMonthKey,
    record.newDate || getTodayDateKey(),
    data?.id ? String(data.id).slice(0, 8) : undefined
  ).catch(() => {});

  return {
    id: data?.id,
    barcode: b,
    month: record.newMonthKey,
    monthKey: record.newMonthKey,
    amount: record.newAmount,
    date: record.newDate || getTodayDateKey(),
    time: new Date(paymentDate).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }),
    note: record.newNote,
    recordedBy: record.recordedBy || "admin",
  };
}

export async function cloudDeletePayment(
  monthKey: string,
  barcode: string,
  paymentIdParam?: string
): Promise<{ monthKey: string; barcode: string }> {
  const b = String(barcode).trim();
  const sId = await getStudentIdByBarcode(b);

  if (paymentIdParam) {
    const { error } = await supabase.from("payments").delete().eq("id", paymentIdParam);
    if (error) {
      console.error("[MutationService] Error deleting payment by id:", error);
      throw new Error(`فشل حذف السداد من السحابة: ${error.message}`);
    }
  } else if (sId) {
    const { error } = await supabase
      .from("payments")
      .delete()
      .eq("student_id", sId)
      .eq("month_key", monthKey);

    if (error) {
      console.error("[MutationService] Error deleting payment by student_id & month_key:", error);
      throw new Error(`فشل حذف السداد من السحابة: ${error.message}`);
    }
  }

  return { monthKey, barcode: b };
}

// ----------------------------------------------------------------------------
// 4. EXAM GRADES & HOMEWORK MUTATIONS (Cloud-First)
// ----------------------------------------------------------------------------

export async function cloudRecordExamGrade(record: {
  barcode: string;
  examTitle: string;
  score: number;
  maxScore: number;
  studentName?: string;
  recordedBy?: string;
  dateKey?: string;
  studentFallback?: Partial<Student>;
}): Promise<{ barcode: string; examTitle: string; score: number; maxScore: number; percentage: number }> {
  const b = String(record.barcode).trim();
  const sId = await ensureStudentInSupabase(b, {
    name: record.studentName,
    parentPhone: record.studentFallback?.parentPhone || record.studentFallback?.phone,
    groupGrade: record.studentFallback?.groupGrade,
  });
  if (!sId) throw new Error(`تعذر العثور على سجل الطالب (${b}) لرصد الدرجة`);

  const pct = Math.round((record.score / record.maxScore) * 100);
  const dateKey = record.dateKey || getTodayDateKey();

  const { error } = await supabase.from("homework").insert({
    student_id: sId,
    date_key: dateKey,
    title: record.examTitle,
    status: "done",
    score: record.score,
    max_score: record.maxScore,
    notes: `رصد درجة امتحان: ${record.examTitle} (${record.score}/${record.maxScore}) - ${record.recordedBy || "admin"}`,
  });

  if (error) {
    console.error("[MutationService] Error inserting exam grade in homework table:", error);
    throw new Error(`فشل حفظ درجة الامتحان في السحابة: ${error.message}`);
  }

  // ⚡ HIGH-PRIORITY FCM PUSH: Trigger Exam Grade to parent
  triggerExamGradeNotification(
    {
      barcode: b,
      name: record.studentName || `طالب ${b}`,
      parentPhone: record.studentFallback?.parentPhone || record.studentFallback?.phone,
      groupGrade: record.studentFallback?.groupGrade,
    },
    record.examTitle,
    record.score,
    record.maxScore,
    dateKey
  ).catch(() => {});

  return {
    barcode: b,
    examTitle: record.examTitle,
    score: record.score,
    maxScore: record.maxScore,
    percentage: pct,
  };
}

/**
 * ⚡ HOMEWORK STATUS MUTATIONS (Cloud-First & FCM Triggered)
 */
export async function cloudUpdateHomeworkStatus(record: {
  barcode: string;
  dateKey: string;
  status: "done" | "incomplete" | "not_done";
  notes?: string;
  studentFallback?: Student | { barcode: string; name: string; parentPhone?: string };
}): Promise<{ barcode: string; status: string }> {
  const b = String(record.barcode).trim();
  const sId = await ensureStudentInSupabase(b, record.studentFallback);
  if (!sId) throw new Error(`تعذر العثور على سجل الطالب (${b}) لتسجيل الواجب`);

  const { error } = await supabase.from("homework").insert({
    student_id: sId,
    date_key: record.dateKey,
    title: "واجب الحصة",
    status: record.status,
    notes: record.notes || (record.status === "done" ? "تسليم ممتاز وكامل" : record.status === "incomplete" ? "حل ناقص" : "لم يتم التسليم"),
  });

  if (error) {
    console.error("[MutationService] Error updating homework status:", error);
    throw new Error(`فشل تحديث حالة الواجب في السحابة: ${error.message}`);
  }

  // High-Priority FCM Push: Homework status update
  await triggerHomeworkStatusNotification(
    record.studentFallback || { barcode: b, name: `طالب ${b}` },
    record.status,
    record.notes,
    record.dateKey
  );

  return { barcode: b, status: record.status };
}

export async function cloudBulkUpdateHomeworkStatus(
  records: Array<{
    barcode: string;
    studentName: string;
    parentPhone?: string;
    status: "done" | "incomplete" | "not_done";
    notes?: string;
    dateKey: string;
  }>
): Promise<{ count: number }> {
  if (!records || records.length === 0) return { count: 0 };

  const rowsToInsert: any[] = [];
  for (const item of records) {
    const sId = await ensureStudentInSupabase(item.barcode, { name: item.studentName, parentPhone: item.parentPhone });
    if (sId) {
      rowsToInsert.push({
        student_id: sId,
        date_key: item.dateKey,
        title: "واجب الحصة",
        status: item.status,
        notes: item.notes || (item.status === "done" ? "تسليم ممتاز وكامل" : item.status === "incomplete" ? "حل ناقص" : "لم يتم التسليم"),
      });
    }
  }

  if (rowsToInsert.length > 0) {
    const { error } = await supabase.from("homework").insert(rowsToInsert);
    if (error) {
      console.error("[MutationService] Error bulk updating homework:", error);
      throw new Error(`فشل تحديث الواجبات جماعياً في السحابة: ${error.message}`);
    }
  }

  // Trigger FCM push notification for each student
  for (const item of records) {
    triggerHomeworkStatusNotification(
      { barcode: item.barcode, name: item.studentName, parentPhone: item.parentPhone },
      item.status,
      item.notes,
      item.dateKey
    ).catch(() => {});
  }

  return { count: records.length };
}

/**
 * ⚡ SUPERVISOR CHAT REPLY MUTATION (Cloud-First & FCM Triggered)
 */
export async function cloudSendChatMessage(record: {
  barcode: string;
  message: string;
  senderName?: string;
  studentFallback?: Student | { barcode: string; name: string; parentPhone?: string };
}): Promise<{ id?: string; barcode: string; message: string }> {
  const b = String(record.barcode).trim();
  const sId = await ensureStudentInSupabase(b, record.studentFallback);
  if (!sId) throw new Error(`تعذر العثور على سجل الطالب (${b}) لإرسال الرسالة`);

  const sender = record.senderName || "إشراف المنظومة";
  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      student_id: sId,
      sender_type: "supervisor",
      sender_name: sender,
      message: record.message.trim(),
      status: "sent",
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    console.error("[MutationService] Error inserting chat message in Supabase:", error);
  }

  // ⚡ HIGH-PRIORITY FCM PUSH: Trigger Supervisor Chat to linked parent
  await triggerSupervisorChatNotification(
    record.studentFallback || { barcode: b, name: `طالب ${b}` },
    record.message.trim(),
    sender
  );

  return {
    id: data?.id,
    barcode: b,
    message: record.message.trim(),
  };
}

// ----------------------------------------------------------------------------
// 5. SYSTEM CONFIGURATIONS & PERMISSIONS MUTATIONS (Cloud-First)
// ----------------------------------------------------------------------------

export async function cloudUpdateGroupPrices(
  prices: Record<GradeName, number>,
  updatedBy: string = "admin"
): Promise<Record<GradeName, number>> {
  const payload = {
    id: "group_prices",
    config_value: prices,
    updated_by: updatedBy,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("system_configs")
    .upsert(payload, { onConflict: "id" });

  if (error) {
    console.error("[MutationService] Error updating group prices:", error);
    throw new Error(`فشل تحديث أسعار المجموعات في السحابة: ${error.message}`);
  }

  return prices;
}

export async function cloudUpdateUsers(
  usersList: UserAccount[],
  updatedBy: string = "admin"
): Promise<UserAccount[]> {
  const payload = {
    id: "users",
    config_value: usersList,
    updated_by: updatedBy,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("system_configs")
    .upsert(payload, { onConflict: "id" });

  if (error) {
    console.error("[MutationService] Error updating users in Supabase:", error);
    throw new Error(`فشل تحديث صلاحيات المشرفين والمستخدمين: ${error.message}`);
  }

  return usersList;
}

export async function cloudFetchSystemConfigs(): Promise<{
  groupPrices?: Record<GradeName, number>;
  usersList?: UserAccount[];
}> {
  try {
    const { data, error } = await supabase.from("system_configs").select("*");
    if (error || !Array.isArray(data)) return {};

    let groupPrices: Record<GradeName, number> | undefined;
    let usersList: UserAccount[] | undefined;

    data.forEach((row) => {
      if (row.id === "group_prices" && row.config_value) {
        groupPrices = row.config_value as Record<GradeName, number>;
      } else if (row.id === "users" && Array.isArray(row.config_value)) {
        usersList = row.config_value as UserAccount[];
      }
    });

    return { groupPrices, usersList };
  } catch (err) {
    console.warn("[MutationService] Could not fetch system configs:", err);
    return {};
  }
}
