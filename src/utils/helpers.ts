import { GradeName, GRADE_ORDER, Student, SessionSlot, PaymentRecord } from "../types";

export const SCHOOL_WHATSAPP_PHONE = "201070642904";
export const TEACHER_NAME = "الأستاذة إيمان الدمشيتي";

// Base default monthly prices per grade
export const DEFAULT_GRADE_PRICES: Record<GradeName, number> = {
  "الصف الرابع الابتدائي": 100,
  "الصف الخامس الابتدائي": 100,
  "الصف السادس الابتدائي": 120,
  "الصف الأول الإعدادي": 140,
  "الصف الثاني الإعدادي": 150,
  "الصف الثالث الإعدادي": 160,
  "الصف الأول الثانوي": 180,
  "الصف الثاني الثانوي": 200,
  "الصف الثالث الثانوي": 220,
};

// Safe Local Date Key (YYYY-MM-DD) avoiding UTC shifts
export function getTodayKey(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getCurrentMonthKey(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function formatTimeArabic(d = new Date()): string {
  try {
    return d.toLocaleTimeString("ar-EG", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return d.toLocaleTimeString();
  }
}

export function formatArabicDate(dateStr?: string): string {
  try {
    const d = dateStr ? new Date(dateStr) : new Date();
    return d.toLocaleDateString("ar-EG", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return dateStr || "";
  }
}

// Convert Arabic digits to English, remove non-digits, and normalize Egypt WhatsApp
export function cleanPhoneNumber(phone?: string): string {
  if (!phone) return "";
  const arabicDigits = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
  let normalized = String(phone);
  for (let i = 0; i < 10; i++) {
    normalized = normalized.split(arabicDigits[i]).join(String(i));
  }
  let digits = normalized.replace(/\D/g, "");

  // 1. Handle international prefix "0020" or "00"
  if (digits.startsWith("0020")) {
    digits = digits.substring(2);
  } else if (digits.startsWith("00")) {
    digits = digits.substring(2);
  }

  // 2. Handle redundant "200" typo (e.g. typing 20 then 010...)
  if (digits.startsWith("200") && digits.length === 13) {
    digits = "20" + digits.substring(3);
  }

  // 3. Handle Egyptian national format (e.g. 010..., 011..., 012..., 015...)
  if (digits.startsWith("0")) {
    digits = "2" + digits;
  } else if (!digits.startsWith("2") && digits.length === 10) {
    digits = "20" + digits;
  }

  return digits;
}

export function getWhatsAppMode(): "web" | "app" {
  try {
    const saved = localStorage.getItem("aiman_whatsapp_mode");
    if (saved === "app") return "app";
    return "web"; // Default to Google Chrome WhatsApp Web
  } catch {
    return "web";
  }
}

export function setWhatsAppMode(mode: "web" | "app"): void {
  try {
    localStorage.setItem("aiman_whatsapp_mode", mode);
  } catch (e) {
    console.error("Failed to save whatsapp mode:", e);
  }
}

export function openWhatsApp(phone: string, message: string, forceMode?: "web" | "app"): void {
  const cleanPhone = cleanPhoneNumber(phone);
  if (!cleanPhone) return;
  const encodedMsg = encodeURIComponent(message);

  const mode = forceMode || getWhatsAppMode();

  let url = "";
  if (mode === "web") {
    // Opens WhatsApp Web directly inside a Google Chrome browser tab
    url = `https://web.whatsapp.com/send?phone=${cleanPhone}&text=${encodedMsg}`;
  } else {
    // Opens WhatsApp Desktop application
    url = `https://wa.me/${cleanPhone}?text=${encodedMsg}`;
  }

  // Safe opening with popup-blocker fallback
  try {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (!win || win.closed || typeof win.closed === "undefined") {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  } catch {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

export function getGradeIndex(grade: GradeName): number {
  const idx = GRADE_ORDER.indexOf(grade);
  return idx === -1 ? 999 : idx;
}

export function sortStudentsByGradeAndName(students: Student[]): Student[] {
  return [...students].sort((a, b) => {
    const gDiff = getGradeIndex(a.groupGrade) - getGradeIndex(b.groupGrade);
    if (gDiff !== 0) return gDiff;
    return (a.name || "").localeCompare(b.name || "", "ar");
  });
}

export function getExamAverage(student: Student): number {
  if (Array.isArray(student.examHistory) && student.examHistory.length > 0) {
    const sum = student.examHistory.reduce((acc, curr) => acc + (Number(curr.percentage) || 0), 0);
    return Math.round(sum / student.examHistory.length);
  }
  if (!student.totalExamScores || student.totalExamScores.length === 0) return 0;
  const sum = student.totalExamScores.reduce((acc, curr) => acc + curr, 0);
  return Math.round(sum / student.totalExamScores.length);
}

export function getAbsenceRate(student: Student): number {
  const total = (student.totalAttendanceDays || 0) + (student.totalAbsentDays || 0);
  if (total === 0) return 0;
  return Math.round(((student.totalAbsentDays || 0) / total) * 100);
}

export function getAttendanceRate(student: Student): number {
  const total = (student.totalAttendanceDays || 0) + (student.totalAbsentDays || 0);
  if (total === 0) return 100;
  return Math.round(((student.totalAttendanceDays || 0) / total) * 100);
}

// Pre-defined common session slots
export const PREDEFINED_SESSION_SLOTS: SessionSlot[] = [
  { id: "auto", label: "⚡ تلقائي حسب الوقت الحالي", startHour: 0, startMinute: 0, lateThresholdMinute: 15, endHour: 23, endMinute: 59 },
  { id: "slot_1pm", label: "الحصة: 1:00 م (سماح حتى 1:15 م)", startHour: 13, startMinute: 0, lateThresholdMinute: 15, endHour: 14, endMinute: 0 },
  { id: "slot_2pm", label: "الحصة: 2:00 م (سماح حتى 2:15 م)", startHour: 14, startMinute: 0, lateThresholdMinute: 15, endHour: 15, endMinute: 0 },
  { id: "slot_3pm", label: "الحصة: 3:00 م (سماح حتى 3:15 م)", startHour: 15, startMinute: 0, lateThresholdMinute: 15, endHour: 16, endMinute: 0 },
  { id: "slot_4pm", label: "الحصة: 4:00 م (سماح حتى 4:15 م)", startHour: 16, startMinute: 0, lateThresholdMinute: 15, endHour: 17, endMinute: 0 },
  { id: "slot_5pm", label: "الحصة: 5:00 م (سماح حتى 5:15 م)", startHour: 17, startMinute: 0, lateThresholdMinute: 15, endHour: 18, endMinute: 0 },
  { id: "slot_6pm", label: "الحصة: 6:00 م (سماح حتى 6:15 م)", startHour: 18, startMinute: 0, lateThresholdMinute: 15, endHour: 19, endMinute: 0 },
  { id: "slot_7pm", label: "الحصة: 7:00 م (سماح حتى 7:15 م)", startHour: 19, startMinute: 0, lateThresholdMinute: 15, endHour: 20, endMinute: 0 },
  { id: "slot_8pm", label: "الحصة: 8:00 م (سماح حتى 8:15 م)", startHour: 20, startMinute: 0, lateThresholdMinute: 15, endHour: 21, endMinute: 0 },
];

/**
 * Converts a group time string (e.g. "01:00 م", "02:30 م", "3:00", "14:00")
 * to total minutes from midnight for exact scheduling calculations.
 */
export function parseGroupTimeToMinutes(timeStr?: string): number | null {
  if (!timeStr) return null;
  const clean = String(timeStr).trim();
  if (!clean) return null;

  // Check for Arabic/English AM/PM indicators
  const isPM = clean.includes("م") || clean.toLowerCase().includes("pm") || clean.includes("مساء");
  const isAM = clean.includes("ص") || clean.toLowerCase().includes("am") || clean.includes("صباح");

  // Extract numbers
  const digitsOnly = clean.replace(/[^\d:]/g, "");
  const parts = digitsOnly.split(":");
  if (parts.length === 0 || !parts[0]) return null;

  let hour = parseInt(parts[0], 10);
  const minute = parts.length > 1 ? parseInt(parts[1], 10) || 0 : 0;

  if (isNaN(hour)) return null;

  if (isPM && hour < 12) {
    hour += 12;
  } else if (isAM && hour === 12) {
    hour = 0;
  }

  return hour * 60 + minute;
}

/**
 * Determine if arrival time is "حضور" (on-time / early) or "تأخير" (late)
 * intelligently based on student's specific groupTime or active session slot.
 * 
 * Rules:
 * 1. If student has an assigned groupTime (e.g. 2:00 PM), any arrival up to 2:15 PM is "حضور".
 *    Arriving after 2:15 PM is "تأخير".
 * 2. If a specific slot is chosen in the scanner, any arrival before/during slot start + threshold is "حضور".
 * 3. In "auto" mode:
 *    - Arriving between :40 of previous hour and :15 past current hour is "حضور".
 *    - Arriving between :16 and :39 is "تأخير".
 */
export function evaluateAttendanceStatus(
  now: Date,
  slotId: string = "auto",
  groupTime?: string
): "حضور" | "تأخير" {
  const currentMinutesFromMidnight = now.getHours() * 60 + now.getMinutes();

  // 1. Highest precedence: Student's exact group time
  if (groupTime) {
    const studentStartMinutes = parseGroupTimeToMinutes(groupTime);
    if (studentStartMinutes !== null) {
      const graceThreshold = studentStartMinutes + 15; // 15-minute grace period
      if (currentMinutesFromMidnight <= graceThreshold) {
        return "حضور"; // On-time or early arrival
      }
      return "تأخير"; // Arrived past grace period
    }
  }

  // 2. Specific session slot selected in scanner
  if (slotId && slotId !== "auto") {
    const slot = PREDEFINED_SESSION_SLOTS.find((s) => s.id === slotId);
    if (slot) {
      const sessionStartMinutesFromMidnight = slot.startHour * 60 + slot.startMinute;
      const lateThresholdMinutesFromMidnight = sessionStartMinutesFromMidnight + slot.lateThresholdMinute;

      if (currentMinutesFromMidnight <= lateThresholdMinutesFromMidnight) {
        return "حضور";
      }
      return "تأخير";
    }
  }

  // 3. Smart Auto Mode (calculates based on center class cadence):
  const minutes = now.getMinutes();
  // Arrival from 40 min past hour (early for next class) up to 15 min past hour (on-time for current class)
  if (minutes <= 15 || minutes >= 40) {
    return "حضور";
  }
  return "تأخير";
}

/**
 * Normalizes barcode strings by trimming, stripping legacy prefixes (e.g. "card_"),
 * and removing Arabic diacritics / invisible formatting characters.
 */
export function normalizeBarcode(code: string | number | undefined | null): string {
  if (code === undefined || code === null) return "";
  return String(code)
    .trim()
    .replace(/^card_/i, "")
    .replace(/[\u064B-\u065F\u0670\u200E\u200F\u202A-\u202E\s]/g, "")
    .trim();
}

/**
 * Checks if a payment record is specifically a card fee (e.g. 30 EGP barcode card)
 * and NOT a monthly tuition subscription fee.
 */
export function isCardFeeRecord(rec: PaymentRecord | undefined, key?: string): boolean {
  if (!rec) return false;
  if (rec.isCardFee) return true;
  if (key && key.startsWith("card_")) return true;
  if (rec.note && (rec.note.includes("كارت") || rec.note.includes("كارنيه") || rec.note.includes("استخراج كارت"))) {
    return true;
  }
  return false;
}

/**
 * Robust monthly tuition payment lookup for a student.
 * EXCLUDES administrative card fees (30 EGP), returning only real monthly subscriptions.
 */
export function getStudentMonthlyPayment(
  monthPayments: Record<string, PaymentRecord> | undefined,
  barcode: string | number | undefined | null
): PaymentRecord | undefined {
  if (!monthPayments || barcode === undefined || barcode === null) return undefined;
  const rawKey = String(barcode).trim();
  const cleanKey = normalizeBarcode(rawKey);
  if (!cleanKey) return undefined;

  // 1. Direct raw check (must not be a card fee)
  const rawRec = monthPayments[rawKey];
  if (rawRec && !isCardFeeRecord(rawRec, rawKey)) {
    return rawRec;
  }

  // 2. Direct cleanKey check
  const cleanRec = monthPayments[cleanKey];
  if (cleanRec && !isCardFeeRecord(cleanRec, cleanKey)) {
    return cleanRec;
  }

  // 3. Fallback scan across all keys for this month
  for (const [k, rec] of Object.entries(monthPayments)) {
    if (!rec) continue;
    if (isCardFeeRecord(rec, k)) continue;
    if (normalizeBarcode(k) === cleanKey) {
      return rec;
    }
  }

  return undefined;
}

/**
 * Card fee payment lookup for a student (e.g. 30 EGP barcode card fee).
 */
export function getStudentCardPayment(
  monthPayments: Record<string, PaymentRecord> | undefined,
  barcode: string | number | undefined | null
): PaymentRecord | undefined {
  if (!monthPayments || barcode === undefined || barcode === null) return undefined;
  const rawKey = String(barcode).trim();
  const cleanKey = normalizeBarcode(rawKey);
  if (!cleanKey) return undefined;

  // Check card_ prefixed key
  const cardKey = `card_${cleanKey}`;
  if (monthPayments[cardKey]) return monthPayments[cardKey];

  // Scan across keys for card fee
  for (const [k, rec] of Object.entries(monthPayments)) {
    if (!rec) continue;
    if (isCardFeeRecord(rec, k) && normalizeBarcode(k) === cleanKey) {
      return rec;
    }
  }

  return undefined;
}

/**
 * Standard alias for retrieving the student's monthly tuition payment record.
 */
export function getStudentPayment(
  monthPayments: Record<string, PaymentRecord> | undefined,
  barcode: string | number | undefined | null
): PaymentRecord | undefined {
  return getStudentMonthlyPayment(monthPayments, barcode);
}

/**
 * Checks whether a student has paid their MONTHLY TUITION for the given month.
 * Note: Having only paid the 30 EGP card fee does NOT count as paying the monthly tuition.
 */
export function isStudentPaid(
  monthPayments: Record<string, PaymentRecord> | undefined,
  barcode: string | number | undefined | null
): boolean {
  return !!getStudentMonthlyPayment(monthPayments, barcode);
}

/**
 * Checks whether a student has paid their card fee for the given month.
 */
export function isStudentCardPaid(
  monthPayments: Record<string, PaymentRecord> | undefined,
  barcode: string | number | undefined | null
): boolean {
  return !!getStudentCardPayment(monthPayments, barcode);
}

/**
 * Returns a normalized payments map where all keys are indexed by clean barcodes,
 * while preserving legacy keys so lookup never fails.
 */
export function normalizePaymentMap(
  payments: Record<string, Record<string, PaymentRecord>> | undefined
): Record<string, Record<string, PaymentRecord>> {
  if (!payments || typeof payments !== "object") return {};
  const normalized: Record<string, Record<string, PaymentRecord>> = {};

  for (const [monthKey, recMap] of Object.entries(payments)) {
    if (!recMap || typeof recMap !== "object") continue;
    normalized[monthKey] = {};
    for (const [rawK, rec] of Object.entries(recMap)) {
      if (!rec) continue;
      const cleanK = normalizeBarcode(rawK);
      if (cleanK) {
        normalized[monthKey][cleanK] = {
          ...rec,
          barcode: cleanK,
        };
      }
      if (rawK !== cleanK) {
        normalized[monthKey][rawK] = rec;
      }
    }
  }
  return normalized;
}

/**
 * Returns the latest month that actually has recorded payments,
 * preventing an empty month like (2026-09) from opening when all records are in (2026-08).
 */
export function getLatestActiveMonthKey(
  payments: Record<string, Record<string, PaymentRecord>> | undefined
): string {
  if (!payments || typeof payments !== "object") return getCurrentMonthKey();
  const monthsWithRecords = Object.entries(payments)
    .filter(([_, recMap]) => recMap && Object.keys(recMap).length > 0)
    .map(([mKey]) => mKey)
    .sort()
    .reverse();

  if (monthsWithRecords.length > 0) {
    const cur = getCurrentMonthKey();
    if (payments[cur] && Object.keys(payments[cur]).length > 0) {
      return cur;
    }
    return monthsWithRecords[0];
  }
  return getCurrentMonthKey();
}

/**
 * Determine the default GroupDays automatically based on the day of the week.
 * Saturday (6), Monday (1), Wednesday (3) -> "سبت - إثنين - أربعاء"
 * Sunday (0), Tuesday (2), Thursday (4) -> "أحد - ثلاثاء - خميس"
 */
export function getDefaultGroupDaysForDate(d = new Date()): "سبت - إثنين - أربعاء" | "أحد - ثلاثاء - خميس" {
  try {
    const day = d.getDay();
    if (day === 0 || day === 2 || day === 4) {
      return "أحد - ثلاثاء - خميس";
    }
    return "سبت - إثنين - أربعاء";
  } catch {
    return "سبت - إثنين - أربعاء";
  }
}

/**
 * Calculates the paired alternate session date for reciprocal compensation.
 * Saturday (6) <-> Sunday (0)
 * Monday (1) <-> Tuesday (2)
 * Wednesday (3) <-> Thursday (4)
 */
export function getPairedAlternateDateKey(dateKeyStr: string): string | null {
  try {
    const parts = dateKeyStr.split("-");
    if (parts.length !== 3) return null;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    const d = new Date(year, month, day);
    if (isNaN(d.getTime())) return null;

    const dayOfWeek = d.getDay(); // 0: Sun, 1: Mon, 2: Tue, 3: Wed, 4: Thu, 5: Fri, 6: Sat

    // Helper to format date to YYYY-MM-DD
    const toKey = (targetDate: Date): string => {
      const y = targetDate.getFullYear();
      const m = String(targetDate.getMonth() + 1).padStart(2, "0");
      const dayNum = String(targetDate.getDate()).padStart(2, "0");
      return `${y}-${m}-${dayNum}`;
    };

    // 1. Saturday (6) <-> Sunday (0)
    if (dayOfWeek === 6) {
      const nextDay = new Date(d);
      nextDay.setDate(d.getDate() + 1);
      return toKey(nextDay);
    } else if (dayOfWeek === 0) {
      const prevDay = new Date(d);
      prevDay.setDate(d.getDate() - 1);
      return toKey(prevDay);
    }

    // 2. Monday (1) <-> Tuesday (2)
    if (dayOfWeek === 1) {
      const nextDay = new Date(d);
      nextDay.setDate(d.getDate() + 1);
      return toKey(nextDay);
    } else if (dayOfWeek === 2) {
      const prevDay = new Date(d);
      prevDay.setDate(d.getDate() - 1);
      return toKey(prevDay);
    }

    // 3. Wednesday (3) <-> Thursday (4)
    if (dayOfWeek === 3) {
      const nextDay = new Date(d);
      nextDay.setDate(d.getDate() + 1);
      return toKey(nextDay);
    } else if (dayOfWeek === 4) {
      const prevDay = new Date(d);
      prevDay.setDate(d.getDate() - 1);
      return toKey(prevDay);
    }

    return null;
  } catch {
    return null;
  }
}

export {
  checkStudentCompensationForDate,
  getStudentPreviousSessionStatus,
  formatArabicSessionDate,
} from "./attendanceCompensation";
export type { PreviousSessionInfo } from "./attendanceCompensation";

