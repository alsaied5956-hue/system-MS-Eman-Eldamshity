import { Student } from "../types";
import { getTodayKey, getPairedAlternateDateKey, formatArabicDate } from "./helpers";

export interface PreviousSessionInfo {
  status: "حضور" | "تأخير" | "غائب" | "معوض" | "إذن" | "جديد";
  label: string;
  badgeText: string;
  color: "emerald" | "amber" | "rose" | "cyan" | "purple" | "slate";
  date: string;
  formattedDate: string;
}

/**
 * Returns clean formatted Arabic weekday + day + month for dates (e.g. "السبت 23 سبتمبر")
 */
export function formatArabicSessionDate(dateStr?: string): string {
  if (!dateStr) return "";
  try {
    const parts = dateStr.split("-");
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString("ar-EG", {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
      }
    }
    return formatArabicDate(dateStr);
  } catch {
    return dateStr;
  }
}

/**
 * Checks whether a student has compensated a specific class date:
 * Example: A student belongs to Sunday group ("أحد - ثلاثاء - خميس"),
 * and he attended yesterday (Saturday, the paired alternate date).
 * In this case, on Sunday he must NOT be marked as absent ("غائب"), but "عوض الحصة"!
 */
export function checkStudentCompensationForDate(
  student: Student,
  targetDate: string,
  attendanceHistory: Record<string, Record<string, string>> = {},
  attendanceToday: Record<string, string> = {}
): {
  hasCompensated: boolean;
  alternateDate?: string;
  alternateStatus?: string;
  reason?: string;
} {
  if (!student || !student.barcode) {
    return { hasCompensated: false };
  }
  const cleanB = String(student.barcode).trim();

  // 1. Direct explicit status check on the target date
  const directStatus = attendanceHistory[targetDate]?.[cleanB] || (targetDate === getTodayKey() ? attendanceToday[cleanB] : undefined);
  if (directStatus === "عوض الحصة" || directStatus === "معوض" || directStatus === "حضر تعويض" || directStatus === "تعويض") {
    return {
      hasCompensated: true,
      alternateDate: getPairedAlternateDateKey(targetDate) || undefined,
      alternateStatus: directStatus,
      reason: "مسجل تعويض رسمياً في هذه الحصة",
    };
  }

  // 2. Paired reciprocal alternate day check (e.g. Saturday <-> Sunday, Mon <-> Tue, Wed <-> Thu)
  const pairedKey = getPairedAlternateDateKey(targetDate);
  if (pairedKey) {
    const pairedStatus =
      attendanceHistory[pairedKey]?.[cleanB] ||
      (pairedKey === getTodayKey() ? attendanceToday[cleanB] : undefined);

    if (pairedStatus === "حضور" || pairedStatus === "تأخير") {
      const pairedDateName = formatArabicSessionDate(pairedKey);
      return {
        hasCompensated: true,
        alternateDate: pairedKey,
        alternateStatus: pairedStatus,
        reason: `حضر في موعد الحصة البديلة (${pairedDateName})`,
      };
    }
  }

  return { hasCompensated: false };
}

/**
 * Evaluates the student's status in the LAST session (الحصة اللي فاتت)
 * Looks through past dates strictly before currentDate (newest first).
 *
 * Checks:
 * 1. Was the student "غائب" (Absent)?
 * 2. Was the student "معوض" (Compensated / عوض الحصة)?
 * 3. Was the student "متأخر" (Late)?
 * 4. Was the student "حضور" (Present)?
 * 5. Or is this their first session ("جديد")?
 */
export function getStudentPreviousSessionStatus(
  student: Student,
  attendanceHistory: Record<string, Record<string, string>> = {},
  currentDate: string = getTodayKey()
): PreviousSessionInfo {
  if (!student || !student.barcode) {
    return {
      status: "جديد",
      label: "لا يوجد سجل سابق",
      badgeText: "⚪ جديد",
      color: "slate",
      date: "",
      formattedDate: "",
    };
  }

  const cleanB = String(student.barcode).trim();

  // Sort past dates in descending order (newest first)
  const pastDates = Object.keys(attendanceHistory)
    .filter((d) => d < currentDate && attendanceHistory[d] && Object.keys(attendanceHistory[d]).length > 0)
    .sort((a, b) => b.localeCompare(a));

  if (pastDates.length === 0) {
    return {
      status: "جديد",
      label: "أول حصة له (جديد)",
      badgeText: "⚪ جديد",
      color: "slate",
      date: "",
      formattedDate: "",
    };
  }

  // 1. First Pass: Look for the most recent past date where the student has an explicit record
  for (const d of pastDates) {
    const dayMap = attendanceHistory[d];
    if (!dayMap) continue;

    const rawStatus = dayMap[cleanB];
    if (rawStatus) {
      const formattedDate = formatArabicSessionDate(d);

      // A. Explicit Compensation
      if (
        rawStatus === "عوض الحصة" ||
        rawStatus === "معوض" ||
        rawStatus === "حضر تعويض" ||
        rawStatus === "تعويض"
      ) {
        return {
          status: "معوض",
          label: `معوض الحصة السابقة (${formattedDate})`,
          badgeText: "🔵 معوض (عوض)",
          color: "cyan",
          date: d,
          formattedDate,
        };
      }

      // B. Absent (Check if compensated on paired alternate date!)
      if (rawStatus === "غائب" || rawStatus === "غياب") {
        const paired = getPairedAlternateDateKey(d);
        if (
          paired &&
          (attendanceHistory[paired]?.[cleanB] === "حضور" ||
           attendanceHistory[paired]?.[cleanB] === "تأخير")
        ) {
          const altDateName = formatArabicSessionDate(paired);
          return {
            status: "معوض",
            label: `عوض الحصة السابقة (حضر ${altDateName})`,
            badgeText: "🔵 معوض (عوض)",
            color: "cyan",
            date: d,
            formattedDate,
          };
        }

        return {
          status: "غائب",
          label: `غائب الحصة السابقة (${formattedDate})`,
          badgeText: "🔴 غائب",
          color: "rose",
          date: d,
          formattedDate,
        };
      }

      // C. Late
      if (rawStatus === "تأخير") {
        return {
          status: "تأخير",
          label: `متأخر الحصة السابقة (${formattedDate})`,
          badgeText: "🟡 متأخر",
          color: "amber",
          date: d,
          formattedDate,
        };
      }

      // D. Present
      if (rawStatus === "حضور") {
        return {
          status: "حضور",
          label: `حاضر الحصة السابقة (${formattedDate})`,
          badgeText: "🟢 حاضر",
          color: "emerald",
          date: d,
          formattedDate,
        };
      }

      // E. Excused
      if (rawStatus === "إذن") {
        return {
          status: "إذن",
          label: `إذن الحصة السابقة (${formattedDate})`,
          badgeText: "🟣 إذن",
          color: "purple",
          date: d,
          formattedDate,
        };
      }
    }
  }

  // 2. Second Pass: If no direct record was found, check if student's group had a session
  // where the student was unscanned (which effectively means absent or compensated)
  for (const d of pastDates) {
    const dayMap = attendanceHistory[d];
    if (!dayMap) continue;

    // Check if other students in the same grade had records on date d
    const hasGradeActivity = Object.keys(dayMap).length >= 5;
    if (hasGradeActivity) {
      const formattedDate = formatArabicSessionDate(d);

      // Check if student compensated this session on paired alternate date
      const paired = getPairedAlternateDateKey(d);
      if (
        paired &&
        (attendanceHistory[paired]?.[cleanB] === "حضور" ||
         attendanceHistory[paired]?.[cleanB] === "تأخير")
      ) {
        const altDateName = formatArabicSessionDate(paired);
        return {
          status: "معوض",
          label: `عوض الحصة السابقة (حضر ${altDateName})`,
          badgeText: "🔵 معوض (عوض)",
          color: "cyan",
          date: d,
          formattedDate,
        };
      }

      return {
        status: "غائب",
        label: `غائب الحصة السابقة (${formattedDate})`,
        badgeText: "🔴 غائب",
        color: "rose",
        date: d,
        formattedDate,
      };
    }
  }

  return {
    status: "جديد",
    label: "أول حصة له (جديد)",
    badgeText: "⚪ جديد",
    color: "slate",
    date: "",
    formattedDate: "",
  };
}
