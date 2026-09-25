import React, { useState, useMemo, useEffect } from "react";
import { Student, GradeName, GroupDays, GRADE_ORDER } from "../types";
import { getTodayKey, openWhatsApp, sortStudentsByGradeAndName, checkStudentCompensationForDate } from "../utils/helpers";
import { matchStudentSearch } from "../utils/search";
import { exportAttendanceHistoryToExcel, exportAllAttendanceHistoryToExcel } from "../utils/excel";
import {
  Calendar,
  FileSpreadsheet,
  FileText,
  Edit3,
  Search,
  X,
  AlertCircle,
  Clock,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Users,
  Trash2,
  CalendarX,
  Check,
  TrendingUp,
  BarChart3,
  History,
  Eye,
  Send,
  Layers,
  Award,
  ShieldCheck,
  Info,
  CalendarDays,
} from "lucide-react";

interface DailyAttendanceReportProps {
  students: Student[];
  attendanceHistory: Record<string, Record<string, string>>;
  onUpdateStatus: (barcode: string, dateKey: string, newStatus: string) => void;
  onDeleteDateRecords?: (dateKey: string) => void;
  onOpenPdfModal: (type: "attendance", targetDate?: string, targetAttendanceMap?: Record<string, string>) => void;
}

type StatusFilterType = "ALL" | "حضور" | "تأخير" | "تم تعويض اليوم" | "عوض الحصة" | "غياب" | "إذن" | "لم يسجل";
type ViewModeType = "daily" | "all-time";
type RateFilterType = "ALL" | "EXCELLENT" | "AVERAGE" | "WARNING";

interface StudentCumulativeRecord {
  student: Student;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  excusedCount: number;
  totalRecordedDays: number;
  attendanceRate: number;
  lastAttendedDate: string;
  dateLogs: { date: string; status: string }[];
}

export const DailyAttendanceReport: React.FC<DailyAttendanceReportProps> = ({
  students,
  attendanceHistory,
  onUpdateStatus,
  onDeleteDateRecords,
  onOpenPdfModal,
}) => {
  const todayKey = getTodayKey();

  // All dates that actually have attendance records, newest first
  const recordedDates = useMemo(() => {
    return Object.keys(attendanceHistory)
      .filter((d) => attendanceHistory[d] && Object.keys(attendanceHistory[d]).length > 0)
      .sort((a, b) => b.localeCompare(a));
  }, [attendanceHistory]);

  // Main View Toggle: Daily Session Report vs All-Time Cumulative Ledger
  const [viewMode, setViewMode] = useState<ViewModeType>("daily");

  // Selected date defaults to today's date strictly (تقرير جلسة اليوم)
  const [selectedDate, setSelectedDate] = useState<string>(todayKey);

  // Daily Filters
  const [filterGrade, setFilterGrade] = useState<string>("ALL");
  const [filterDays, setFilterDays] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("ALL");

  // Cumulative All-Time Filters
  const [cumulativeGrade, setCumulativeGrade] = useState<string>("ALL");
  const [cumulativeDays, setCumulativeDays] = useState<string>("ALL");
  const [cumulativeRateFilter, setCumulativeRateFilter] = useState<RateFilterType>("ALL");
  const [cumulativeSearch, setCumulativeSearch] = useState("");

  // Modals state
  const [editingStudent, setEditingStudent] = useState<{ barcode: string; name: string; currentStatus: string } | null>(null);
  const [newStatusSelect, setNewStatusSelect] = useState("حضور");
  const [viewingHistoryStudent, setViewingHistoryStudent] = useState<StudentCumulativeRecord | null>(null);

  const isFutureDate = selectedDate > todayKey;

  const handleDateChange = (newDate: string) => {
    setSelectedDate(newDate);
  };

  const dateAttendanceMap = useMemo(() => {
    return attendanceHistory[selectedDate] || {};
  }, [attendanceHistory, selectedDate]);

  // Base list of students matching daily grade and group days:
  // Strict Group Integrity: Students remain strictly in their enrolled group days.
  // A student in "أحد - ثلاثاء - خميس" will NEVER be moved into "سبت - إثنين - أربعاء"!
  const baseStudents = useMemo(() => {
    const base = students.filter((s) => {
      if (filterGrade !== "ALL" && s.groupGrade !== filterGrade) return false;
      if (filterDays !== "ALL") {
        return s.groupDays === filterDays;
      }
      return true;
    });

    if (searchQuery.trim()) {
      const scored: { student: Student; score: number }[] = [];
      for (const s of base) {
        const { match, score } = matchStudentSearch(s, searchQuery);
        if (match) {
          scored.push({ student: s, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.map((item) => item.student);
    }

    return sortStudentsByGradeAndName(base);
  }, [students, filterGrade, filterDays, searchQuery]);

  // Daily Metrics Calculation
  const { presentCount, lateCount, compensatedCount, absentCount, excusedCount, unrecordedCount, totalCount } = useMemo(() => {
    let present = 0;
    let late = 0;
    let compensated = 0;
    let absent = 0;
    let excused = 0;

    baseStudents.forEach((s) => {
      let st = dateAttendanceMap[s.barcode];
      if (!st || st === "غائب" || st === "غياب") {
        const comp = checkStudentCompensationForDate(s, selectedDate, attendanceHistory);
        if (comp.hasCompensated) {
          st = "تم تعويض اليوم";
        }
      } else if (st === "عوض الحصة" || st === "معوض") {
        st = "تم تعويض اليوم";
      }

      if (st === "حضور") present++;
      else if (st === "تأخير") late++;
      else if (st === "تم تعويض اليوم" || st === "عوض الحصة" || st === "معوض") compensated++;
      else if (st === "غياب" || st === "غائب") absent++;
      else if (st === "إذن") excused++;
    });

    const total = baseStudents.length;
    const unrecorded = Math.max(0, total - (present + late + compensated + absent + excused));

    return {
      totalCount: total,
      presentCount: present,
      lateCount: late,
      compensatedCount: compensated,
      absentCount: absent,
      excusedCount: excused,
      unrecordedCount: unrecorded,
    };
  }, [baseStudents, dateAttendanceMap, selectedDate, attendanceHistory]);

  const presentPercent = totalCount > 0 ? Math.round((presentCount / totalCount) * 100) : 0;
  const latePercent = totalCount > 0 ? Math.round((lateCount / totalCount) * 100) : 0;
  const compensatedPercent = totalCount > 0 ? Math.round((compensatedCount / totalCount) * 100) : 0;
  const absentPercent = totalCount > 0 ? Math.round((absentCount / totalCount) * 100) : 0;
  const excusedPercent = totalCount > 0 ? Math.round((excusedCount / totalCount) * 100) : 0;
  const unrecordedPercent = totalCount > 0 ? Math.round((unrecordedCount / totalCount) * 100) : 0;

  // Filter students by selected status for daily view
  const displayedStudents = useMemo(() => {
    if (statusFilter === "ALL") return baseStudents;

    return baseStudents.filter((s) => {
      let raw = dateAttendanceMap[s.barcode];
      if (!raw || raw === "غائب" || raw === "غياب") {
        const comp = checkStudentCompensationForDate(s, selectedDate, attendanceHistory);
        if (comp.hasCompensated) {
          raw = "تم تعويض اليوم";
        }
      } else if (raw === "عوض الحصة" || raw === "معوض") {
        raw = "تم تعويض اليوم";
      }

      if (statusFilter === "حضور") return raw === "حضور";
      if (statusFilter === "تأخير") return raw === "تأخير";
      if (statusFilter === "تم تعويض اليوم" || statusFilter === "عوض الحصة") {
        return raw === "تم تعويض اليوم" || raw === "عوض الحصة" || raw === "معوض";
      }
      if (statusFilter === "غياب") return raw === "غياب" || raw === "غائب";
      if (statusFilter === "إذن") return raw === "إذن";
      if (statusFilter === "لم يسجل") return !raw;
      return true;
    });
  }, [baseStudents, dateAttendanceMap, statusFilter, selectedDate, attendanceHistory]);

  // =========================================================================
  // 🌟 CUMULATIVE ALL-TIME ATTENDANCE LEDGER COMPUTATION (Since Day 1)
  // =========================================================================
  const cumulativeData = useMemo(() => {
    const allActiveDates = Object.keys(attendanceHistory)
      .filter((d) => attendanceHistory[d] && Object.keys(attendanceHistory[d]).length > 0)
      .sort((a, b) => b.localeCompare(a)); // newest first

    let platformTotalPresentScans = 0;
    let platformTotalLateScans = 0;
    let platformTotalAbsentScans = 0;

    const list: StudentCumulativeRecord[] = students.map((s) => {
      let present = 0;
      let late = 0;
      let absent = 0;
      let excused = 0;
      let lastDate = "";
      const dateLogs: { date: string; status: string }[] = [];

      allActiveDates.forEach((d) => {
        let st = attendanceHistory[d]?.[s.barcode];
        if (st) {
          if (st === "غائب" || st === "غياب") {
            const comp = checkStudentCompensationForDate(s, d, attendanceHistory);
            if (comp.hasCompensated) {
              st = "عوض الحصة";
            }
          }

          dateLogs.push({ date: d, status: st });
          if (st === "حضور" || st === "عوض الحصة" || st === "معوض") {
            present++;
            if (!lastDate) lastDate = d;
          } else if (st === "تأخير") {
            late++;
            if (!lastDate) lastDate = d;
          } else if (st === "غائب" || st === "غياب") {
            absent++;
          } else if (st === "إذن") {
            excused++;
          }
        }
      });

      // Synchronize with authentic stored count on student profile if higher
      const effectivePresent = Math.max(present, s.totalAttendanceDays || 0);
      const effectiveAbsent = Math.max(absent, s.totalAbsentDays || 0);
      const totalRec = effectivePresent + late + effectiveAbsent + excused;
      const rate = totalRec > 0 ? Math.round(((effectivePresent + late) / totalRec) * 100) : 0;

      platformTotalPresentScans += effectivePresent;
      platformTotalLateScans += late;
      platformTotalAbsentScans += effectiveAbsent;

      return {
        student: s,
        presentCount: effectivePresent,
        lateCount: late,
        absentCount: effectiveAbsent,
        excusedCount: excused,
        totalRecordedDays: totalRec,
        attendanceRate: rate,
        lastAttendedDate: lastDate || (s.lastExamTitle ? "سجل امتحانات" : "-"),
        dateLogs,
      };
    });

    const totalStudentsCount = students.length;
    const totalPlatformScans = platformTotalPresentScans + platformTotalLateScans + platformTotalAbsentScans;
    const platformAverageRate = totalPlatformScans > 0
      ? Math.round(((platformTotalPresentScans + platformTotalLateScans) / totalPlatformScans) * 100)
      : 0;

    const excellentCount = list.filter((r) => r.totalRecordedDays > 0 && r.attendanceRate >= 90).length;
    const warningCount = list.filter((r) => r.totalRecordedDays > 0 && r.attendanceRate < 75).length;

    return {
      list,
      allActiveDates,
      totalSessionDays: allActiveDates.length,
      totalStudentsCount,
      platformTotalPresentScans,
      platformTotalLateScans,
      platformTotalAbsentScans,
      platformAverageRate,
      excellentCount,
      warningCount,
    };
  }, [students, attendanceHistory]);

  // Filtered cumulative students for display
  const displayedCumulativeStudents = useMemo(() => {
    let result = cumulativeData.list.filter((r) => {
      const s = r.student;
      if (cumulativeGrade !== "ALL" && s.groupGrade !== cumulativeGrade) return false;
      if (cumulativeDays !== "ALL" && s.groupDays !== cumulativeDays) return false;

      if (cumulativeRateFilter === "EXCELLENT") {
        return r.attendanceRate >= 90;
      }
      if (cumulativeRateFilter === "AVERAGE") {
        return r.attendanceRate >= 75 && r.attendanceRate < 90;
      }
      if (cumulativeRateFilter === "WARNING") {
        return r.totalRecordedDays > 0 && r.attendanceRate < 75;
      }

      return true;
    });

    if (cumulativeSearch.trim()) {
      const scored: { item: StudentCumulativeRecord; score: number }[] = [];
      for (const item of result) {
        const { match, score } = matchStudentSearch(item.student, cumulativeSearch);
        if (match) {
          scored.push({ item, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.map((s) => s.item);
    }

    // Sort by grade, then name
    result.sort((a, b) => {
      const gOrderA = GRADE_ORDER.indexOf(a.student.groupGrade as any);
      const gOrderB = GRADE_ORDER.indexOf(b.student.groupGrade as any);
      if (gOrderA !== gOrderB) return gOrderA - gOrderB;
      return a.student.name.localeCompare(b.student.name, "ar");
    });

    return result;
  }, [cumulativeData.list, cumulativeGrade, cumulativeDays, cumulativeRateFilter, cumulativeSearch]);

  const handleSaveStatus = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStudent) return;
    onUpdateStatus(editingStudent.barcode, selectedDate, newStatusSelect);
    setEditingStudent(null);
  };

  const handleSendCumulativeWhatsApp = (rec: StudentCumulativeRecord) => {
    const s = rec.student;
    const phone = s.parentPhone || s.phone || "";
    const msg = `📊 تقرير الحضور والغياب التراكمي الشامل 📐\nالأستاذة إيمان الدمشيتي - مادة الرياضيات\n\nعزيزي ولي أمر الطالب/ة: (${s.name})\nالصف: ${s.groupGrade} - مجموعة: ${s.groupDays}\n\nإليكم السجل التراكمي منذ بدء العام الدراسي:\n🟢 عدد مرات الحضور: ${rec.presentCount} حصة\n🟡 عدد مرات التأخير: ${rec.lateCount} حصة\n🔴 عدد مرات الغياب: ${rec.absentCount} حصة\n⚪ أعذار مقبولة: ${rec.excusedCount}\n📈 نسبة الالتزام بالحضور: ${rec.attendanceRate}%\n📅 آخر حضور مسجل: ${rec.lastAttendedDate}\n\nنسعد دائماً بمتابعتكم وتفوق أبنائنا.`;
    openWhatsApp(phone, msg);
  };

  return (
    <div className="space-y-6">
      {/* 🧭 Master View Mode Switcher Header */}
      <div className="glass-panel p-3.5 rounded-3xl flex flex-wrap items-center justify-between gap-4 border border-indigo-500/30 shadow-xl bg-gradient-to-r from-slate-900/90 via-indigo-950/40 to-slate-900/90">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-amber-400/10 border border-amber-400/30 flex items-center justify-center text-amber-400 shadow-inner">
            {viewMode === "daily" ? <Calendar className="w-5 h-5" /> : <BarChart3 className="w-5 h-5" />}
          </div>
          <div>
            <h2 className="text-sm md:text-base font-extrabold text-white font-tajawal flex items-center gap-2">
              <span>{viewMode === "daily" ? "سجل الحضور اليومي وجلسات الفصول" : "السجل التراكمي الشامل لجميع الطلاب"}</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-mono font-bold">
                {cumulativeData.totalSessionDays} جلسة مسجلة
              </span>
            </h2>
            <p className="text-xs text-slate-400 font-tajawal">
              {viewMode === "daily"
                ? `عرض تفصيلي للطلاب وحالتهم بتاريخ الجلسة المحددة (${selectedDate})`
                : `إحصائيات ونسب الحضور والغياب لكل الـ ${students.length} طالب المسجلين على المنصة منذ بداية العمل`}
            </p>
          </div>
        </div>

        {/* Tab Toggle Buttons */}
        <div className="flex items-center bg-[#060a17] p-1 rounded-2xl border border-indigo-500/40 font-tajawal text-xs font-bold shadow-inner">
          <button
            type="button"
            onClick={() => setViewMode("daily")}
            className={`px-4 py-2 rounded-xl transition-all cursor-pointer flex items-center gap-2 ${
              viewMode === "daily"
                ? "bg-amber-400 text-slate-950 shadow-md shadow-amber-400/20 font-black"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <CalendarDays className="w-3.5 h-3.5" />
            <span>تقرير جلسة اليوم المحدد</span>
          </button>

          <button
            type="button"
            onClick={() => setViewMode("all-time")}
            className={`px-4 py-2 rounded-xl transition-all cursor-pointer flex items-center gap-2 ${
              viewMode === "all-time"
                ? "bg-gradient-to-r from-indigo-500 to-indigo-600 text-white shadow-md shadow-indigo-500/20 font-black"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>السجل التراكمي الشامل (لكل الطلاب)</span>
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 🌟 VIEW 1: DAILY SESSION ATTENDANCE VIEW */}
      {/* ========================================================================= */}
      {viewMode === "daily" && (
        <div className="space-y-6 animate-in fade-in duration-300">
          {/* Notice if viewing a different date than today */}
          {selectedDate !== todayKey && Object.keys(dateAttendanceMap).length > 0 && (
            <div className="bg-indigo-950/40 border border-indigo-500/30 p-3.5 rounded-2xl flex items-center justify-between gap-3 text-indigo-200 text-xs font-tajawal shadow-sm">
              <div className="flex items-center gap-2.5">
                <Info className="w-4 h-4 text-indigo-400 shrink-0" />
                <span>
                  أنت تشاهد حالياً سجل جلسة تاريخ: <strong className="text-amber-300 font-mono text-sm px-1.5">{selectedDate}</strong> وبها{" "}
                  <strong className="text-emerald-400 font-mono">{Object.keys(dateAttendanceMap).length} طالب</strong> مسجل.
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleDateChange(todayKey)}
                className="px-3 py-1 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs transition-colors shrink-0 cursor-pointer"
              >
                العودة لجلسة اليوم
              </button>
            </div>
          )}

          {/* Future Date Notification Banner */}
          {isFutureDate && (
            <div className="bg-sky-950/40 border border-sky-500/40 p-4 rounded-3xl flex items-start sm:items-center gap-3.5 text-sky-200 shadow-lg">
              <AlertCircle className="w-5 h-5 text-sky-400 shrink-0 mt-0.5 sm:mt-0" />
              <div className="flex-1 font-tajawal text-xs md:text-sm">
                <p className="font-extrabold text-sky-300">
                  📅 تاريخ مستقبلي ({selectedDate}) — الجلسة لم تبدأ بعد
                </p>
                <p className="text-slate-400 text-xs mt-0.5">
                  أنت تشاهد حالياً قائمة الطلاب المقيدين في مجموعة هذا اليوم ({filterDays}). لم يتم رصد حضور فعلي بعد وسيتم التحديث التلقائي فور بدء المسح بالسكانر.
                </p>
              </div>
            </div>
          )}

          {/* No Attendance Recorded for this Date Banner */}
          {Object.keys(dateAttendanceMap).length === 0 && !isFutureDate && (
            <div className="glass-panel p-5 rounded-3xl border border-amber-500/30 bg-amber-500/5 text-center font-tajawal shadow-lg">
              <CalendarX className="w-8 h-8 text-amber-400 mx-auto mb-2 opacity-80" />
              <h4 className="text-sm font-bold text-slate-100 mb-1">
                لا يوجد سجل حضور مسجل لتاريخ ({selectedDate})
              </h4>
              <p className="text-xs text-slate-400 max-w-lg mx-auto leading-relaxed">
                لم تُعقد جلسات دراسية أو لم يتم رصد حضور للطلاب في هذا التاريخ (0 مسجلين كحضور/غياب). يمكنك الانتقال لأحد الأيام المسجلة من الشريط أعلاه.
              </p>
            </div>
          )}

          {/* Balanced Stat Cards (Total = Present + Late + Absent + Excused + Unrecorded) */}
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
            {/* Card 1: Total Selected */}
            <div
              onClick={() => setStatusFilter("ALL")}
              className={`glass-card p-3.5 rounded-3xl text-center shadow-lg cursor-pointer transition-all duration-300 ${
                statusFilter === "ALL" ? "border-amber-400 ring-2 ring-amber-400/30" : "hover:border-amber-400/40"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5 text-slate-400 font-tajawal text-xs font-medium mb-1">
                <Users className="w-3.5 h-3.5 text-amber-400" />
                <span>الطلاب</span>
              </div>
              <p className="text-2xl font-black text-amber-300 font-mono">{totalCount}</p>
              <span className="text-[10px] text-amber-300/70 font-bold font-mono">100% المجموعة</span>
            </div>

            {/* Card 2: Present */}
            <div
              onClick={() => setStatusFilter("حضور")}
              className={`glass-card p-3.5 rounded-3xl text-center shadow-lg cursor-pointer transition-all duration-300 ${
                statusFilter === "حضور" ? "border-emerald-400 ring-2 ring-emerald-400/30" : "hover:border-emerald-400/40"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5 text-emerald-400 font-tajawal text-xs font-medium mb-1">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>🟢 حضور</span>
              </div>
              <p className="text-2xl font-black text-emerald-400 font-mono">{presentCount}</p>
              <span className="text-[10px] text-emerald-400/80 font-bold font-mono">{presentPercent}%</span>
            </div>

            {/* Card 3: Late */}
            <div
              onClick={() => setStatusFilter("تأخير")}
              className={`glass-card p-3.5 rounded-3xl text-center shadow-lg cursor-pointer transition-all duration-300 ${
                statusFilter === "تأخير" ? "border-amber-400 ring-2 ring-amber-400/30" : "hover:border-amber-400/40"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5 text-amber-400 font-tajawal text-xs font-medium mb-1">
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                <span>🟡 تأخير</span>
              </div>
              <p className="text-2xl font-black text-amber-400 font-mono">{lateCount}</p>
              <span className="text-[10px] text-amber-400/80 font-bold font-mono">{latePercent}%</span>
            </div>

            {/* Card 4: Absent */}
            <div
              onClick={() => setStatusFilter("غياب")}
              className={`glass-card p-3.5 rounded-3xl text-center shadow-lg cursor-pointer transition-all duration-300 ${
                statusFilter === "غياب" ? "border-rose-400 ring-2 ring-rose-400/30" : "hover:border-rose-400/40"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5 text-rose-400 font-tajawal text-xs font-medium mb-1">
                <XCircle className="w-3.5 h-3.5 text-rose-400" />
                <span>🔴 غياب</span>
              </div>
              <p className="text-2xl font-black text-rose-400 font-mono">{absentCount}</p>
              <span className="text-[10px] text-rose-400/80 font-bold font-mono">{absentPercent}%</span>
            </div>

            {/* Card 5: Excused */}
            <div
              onClick={() => setStatusFilter("إذن")}
              className={`glass-card p-3.5 rounded-3xl text-center shadow-lg cursor-pointer transition-all duration-300 ${
                statusFilter === "إذن" ? "border-sky-400 ring-2 ring-sky-400/30" : "hover:border-sky-400/40"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5 text-sky-400 font-tajawal text-xs font-medium mb-1">
                <Clock className="w-3.5 h-3.5 text-sky-400" />
                <span>⚪ إذن/عذر</span>
              </div>
              <p className="text-2xl font-black text-sky-400 font-mono">{excusedCount}</p>
              <span className="text-[10px] text-sky-400/80 font-bold font-mono">{excusedPercent}%</span>
            </div>

            {/* Card 6: Unrecorded / Pending */}
            <div
              onClick={() => setStatusFilter("لم يسجل")}
              className={`glass-card p-3.5 rounded-3xl text-center shadow-lg cursor-pointer transition-all duration-300 ${
                statusFilter === "لم يسجل" ? "border-slate-400 ring-2 ring-slate-400/30" : "hover:border-slate-500/40"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5 text-slate-400 font-tajawal text-xs font-medium mb-1">
                <HelpCircle className="w-3.5 h-3.5 text-slate-400" />
                <span>بانتظار الرصد</span>
              </div>
              <p className="text-2xl font-black text-slate-300 font-mono">{unrecordedCount}</p>
              <span className="text-[10px] text-slate-400 font-bold font-mono">{unrecordedPercent}%</span>
            </div>
          </div>

          {/* Filter and Action Bar */}
          <div className="glass-panel p-4 md:p-5 rounded-3xl flex flex-wrap items-center justify-between gap-3.5 shadow-xl">
            <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[300px] font-tajawal">
              {/* Date Picker */}
              <div className="flex items-center gap-2 bg-[#080d1e] border border-indigo-500/30 px-3.5 py-2.5 rounded-2xl">
                <Calendar className="w-4 h-4 text-amber-400" />
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => handleDateChange(e.target.value)}
                  className="bg-transparent text-xs font-bold text-slate-100 outline-none cursor-pointer"
                />
              </div>

              {/* Filter Grade */}
              <select
                value={filterGrade}
                onChange={(e) => setFilterGrade(e.target.value)}
                className="bg-[#080d1e] border border-indigo-500/30 text-slate-100 text-xs font-bold px-3.5 py-2.5 rounded-2xl outline-none"
              >
                <option value="ALL" className="bg-slate-900 text-white">كل الصفوف الدراسية</option>
                {GRADE_ORDER.map((g) => (
                  <option key={g} value={g} className="bg-slate-900 text-white">
                    {g}
                  </option>
                ))}
              </select>

              {/* Filter Days */}
              <select
                value={filterDays}
                onChange={(e) => setFilterDays(e.target.value)}
                className="bg-[#080d1e] border border-indigo-500/30 text-slate-100 text-xs font-bold px-3.5 py-2.5 rounded-2xl outline-none"
              >
                <option value="ALL" className="bg-slate-900 text-white">كل الأيام</option>
                <option value="سبت - إثنين - أربعاء" className="bg-slate-900 text-white">سبت - إثنين - أربعاء</option>
                <option value="أحد - ثلاثاء - خميس" className="bg-slate-900 text-white">أحد - ثلاثاء - خميس</option>
              </select>

              {/* Seamless Search Input */}
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-amber-400 absolute right-3.5 top-3.5 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="بحث بالاسم أو الباركود..."
                  className="w-full bg-[#080d1e] border border-indigo-500/30 text-slate-100 text-xs pr-9 pl-8 py-2.5 rounded-2xl outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400/30 transition-all placeholder:text-slate-500 font-medium"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="absolute left-2.5 top-2.5 p-0.5 text-slate-400 hover:text-white"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Export and Action Buttons */}
            <div className="flex items-center gap-2 font-tajawal">
              {onDeleteDateRecords && Object.keys(dateAttendanceMap).length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`هل أنت متأكد تماماً من رغبتك في مسح كافة سجلات الحضور المسجلة لتاريخ (${selectedDate})؟`)) {
                      onDeleteDateRecords(selectedDate);
                    }
                  }}
                  className="px-3.5 py-2.5 rounded-2xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm cursor-pointer"
                  title="مسح سجل هذا اليوم بالكامل من النظام"
                >
                  <Trash2 className="w-4 h-4 text-rose-400" />
                  <span>مسح سجل اليوم</span>
                </button>
              )}

              <button
                onClick={() => exportAttendanceHistoryToExcel(displayedStudents, dateAttendanceMap, selectedDate)}
                className="px-3.5 py-2.5 rounded-2xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-400/30 text-emerald-300 text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                <span>تصدير Excel</span>
              </button>

              <button
                onClick={() => onOpenPdfModal("attendance", selectedDate, dateAttendanceMap)}
                className="px-4 py-2.5 rounded-2xl bg-gradient-to-r from-amber-400 via-amber-300 to-yellow-200 hover:from-amber-300 hover:to-yellow-100 text-slate-950 text-xs font-bold transition-all flex items-center gap-1.5 shadow-lg shadow-amber-500/20 cursor-pointer"
              >
                <FileText className="w-4 h-4" />
                <span>📄 تصدير PDF مقسم لكل صف ({selectedDate})</span>
              </button>
            </div>
          </div>

          {/* Quick Status Filter Tabs */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs font-tajawal font-bold">
            <span className="text-slate-400 ml-1">عرض:</span>
            <button
              onClick={() => setStatusFilter("ALL")}
              className={`px-3 py-1.5 rounded-xl border transition-all ${
                statusFilter === "ALL"
                  ? "bg-amber-400/20 text-amber-300 border-amber-400/50"
                  : "bg-slate-900/60 text-slate-400 border-indigo-900/40 hover:text-slate-200"
              }`}
            >
              الكل ({totalCount})
            </button>
            <button
              onClick={() => setStatusFilter("حضور")}
              className={`px-3 py-1.5 rounded-xl border transition-all ${
                statusFilter === "حضور"
                  ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/50"
                  : "bg-slate-900/60 text-slate-400 border-indigo-900/40 hover:text-slate-200"
              }`}
            >
              🟢 حضور ({presentCount})
            </button>
            <button
              onClick={() => setStatusFilter("تأخير")}
              className={`px-3 py-1.5 rounded-xl border transition-all ${
                statusFilter === "تأخير"
                  ? "bg-amber-500/20 text-amber-300 border-amber-500/50"
                  : "bg-slate-900/60 text-slate-400 border-indigo-900/40 hover:text-slate-200"
              }`}
            >
              🟡 تأخير ({lateCount})
            </button>
            <button
              onClick={() => setStatusFilter("تم تعويض اليوم")}
              className={`px-3 py-1.5 rounded-xl border transition-all ${
                statusFilter === "تم تعويض اليوم" || statusFilter === "عوض الحصة"
                  ? "bg-cyan-500/25 text-cyan-300 border-cyan-500/50 font-bold"
                  : "bg-slate-900/60 text-slate-400 border-indigo-900/40 hover:text-slate-200"
              }`}
            >
              🔵 تم تعويض اليوم ({compensatedCount})
            </button>
            <button
              onClick={() => setStatusFilter("غياب")}
              className={`px-3 py-1.5 rounded-xl border transition-all ${
                statusFilter === "غياب"
                  ? "bg-rose-500/20 text-rose-300 border-rose-500/50"
                  : "bg-slate-900/60 text-slate-400 border-indigo-900/40 hover:text-slate-200"
              }`}
            >
              🔴 غياب ({absentCount})
            </button>
            <button
              onClick={() => setStatusFilter("إذن")}
              className={`px-3 py-1.5 rounded-xl border transition-all ${
                statusFilter === "إذن"
                  ? "bg-sky-500/20 text-sky-300 border-sky-500/50"
                  : "bg-slate-900/60 text-slate-400 border-indigo-900/40 hover:text-slate-200"
              }`}
            >
              ⚪ إذن ({excusedCount})
            </button>
            <button
              onClick={() => setStatusFilter("لم يسجل")}
              className={`px-3 py-1.5 rounded-xl border transition-all ${
                statusFilter === "لم يسجل"
                  ? "bg-slate-700/50 text-slate-200 border-slate-500/50"
                  : "bg-slate-900/60 text-slate-400 border-indigo-900/40 hover:text-slate-200"
              }`}
            >
              بانتظار الرصد ({unrecordedCount})
            </button>
          </div>

          {/* Daily Attendance Table */}
          <div className="glass-panel rounded-3xl overflow-hidden shadow-2xl">
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse text-xs md:text-sm font-tajawal">
                <thead>
                  <tr className="bg-slate-900/90 text-amber-400 font-bold border-b border-indigo-500/30">
                    <th className="p-3.5">م</th>
                    <th className="p-3.5">الباركود</th>
                    <th className="p-3.5">اسم الطالب</th>
                    <th className="p-3.5">الصف الدراسي</th>
                    <th className="p-3.5">المجموعة</th>
                    <th className="p-3.5">حالة الحضور بتاريـخ ({selectedDate})</th>
                    <th className="p-3.5">رقم ولي الأمر</th>
                    <th className="p-3.5 text-center">إجراء وتعديل الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-indigo-950/50">
                  {displayedStudents.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-8 text-center text-slate-400 italic">
                        {searchQuery
                          ? `لا يوجد نتائج مطابقة للبحث "${searchQuery}"`
                          : "لا يوجد طلاب مطابقين للتصفية المحددة."}
                      </td>
                    </tr>
                  ) : (
                    displayedStudents.map((student, idx) => {
                      let rawStatus = dateAttendanceMap[student.barcode];
                      let isCompensatedToday = false;
                      if (!rawStatus || rawStatus === "غائب" || rawStatus === "غياب") {
                        const comp = checkStudentCompensationForDate(student, selectedDate, attendanceHistory);
                        if (comp.hasCompensated) {
                          rawStatus = "تم تعويض اليوم";
                          isCompensatedToday = true;
                        }
                      } else if (rawStatus === "عوض الحصة" || rawStatus === "معوض" || rawStatus === "تم تعويض اليوم") {
                        rawStatus = "تم تعويض اليوم";
                        isCompensatedToday = true;
                      }

                      const status =
                        rawStatus === "غائب" || rawStatus === "غياب"
                          ? "غياب"
                          : rawStatus || "لم يسجل";

                      let statusBg = "bg-slate-800 text-slate-400 border-slate-700";
                      let statusText = status;
                      if (status === "حضور") {
                        statusBg = "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
                        statusText = "حضور";
                      } else if (status === "تأخير") {
                        statusBg = "bg-amber-500/20 text-amber-300 border-amber-500/40";
                        statusText = "تأخير";
                      } else if (isCompensatedToday || status === "تم تعويض اليوم") {
                        statusBg = "bg-cyan-500/25 text-cyan-300 border-cyan-500/50 font-extrabold";
                        statusText = "تم تعويض اليوم";
                      } else if (status === "غياب") {
                        statusBg = "bg-rose-500/20 text-rose-300 border-rose-500/40";
                        statusText = "غياب";
                      } else if (status === "إذن") {
                        statusBg = "bg-sky-500/20 text-sky-300 border-sky-500/40";
                        statusText = "إذن";
                      }

                      return (
                        <tr key={student.barcode} className="hover:bg-indigo-500/10 transition-colors font-medium">
                          <td className="p-3.5 font-mono text-slate-400">{idx + 1}</td>
                          <td className="p-3.5 font-mono text-amber-300 font-bold">{student.barcode}</td>
                          <td className="p-3.5 font-bold text-slate-100">{student.name}</td>
                          <td className="p-3.5 text-slate-300">{student.groupGrade}</td>
                          <td className="p-3.5 text-slate-400">
                            <span>{student.groupDays}</span>
                          </td>
                          <td className="p-3.5">
                            <span
                              className={`px-3 py-1 rounded-full text-xs font-bold border inline-block ${statusBg}`}
                              title={isCompensatedToday ? "معفي من الغياب - حضر في موعد الحصة البديلة تعويضاً" : undefined}
                            >
                              {statusText}
                            </span>
                          </td>
                          <td className="p-3.5 font-mono text-slate-300">{student.parentPhone}</td>
                          <td className="p-3.5">
                            <div className="flex items-center justify-center gap-2">
                              <button
                                onClick={() => {
                                  setEditingStudent({
                                    barcode: student.barcode,
                                    name: student.name,
                                    currentStatus: status,
                                  });
                                  setNewStatusSelect(status === "لم يسجل" ? "حضور" : status);
                                }}
                                className="px-2.5 py-1.5 rounded-xl bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-300 text-[11px] font-bold flex items-center gap-1 cursor-pointer transition-all"
                              >
                                <Edit3 className="w-3 h-3" />
                                <span>تعديل</span>
                              </button>

                              <button
                                onClick={() =>
                                  openWhatsApp(
                                    student.parentPhone || student.phone || "",
                                    `تنبيه من منظومة الأستاذة إيمان الدمشيتي 📐\nنفيدكم بأن حالة الطالب/ة (${student.name}) بتاريخ ${selectedDate} هي: (${status}).`
                                  )
                                }
                                className="px-2.5 py-1.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-[11px] font-bold cursor-pointer transition-all"
                              >
                                📲 واتساب
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 🌟 VIEW 2: ALL-TIME CUMULATIVE ATTENDANCE LEDGER (منذ بداية المنظومة) */}
      {/* ========================================================================= */}
      {viewMode === "all-time" && (
        <div className="space-y-6 animate-in fade-in duration-300">
          {/* Cumulative Master Metric Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
            {/* Stat 1: Total Students */}
            <div className="glass-card p-3.5 rounded-3xl text-center shadow-lg border border-amber-500/30 bg-amber-500/5">
              <div className="flex items-center justify-center gap-1.5 text-amber-400 font-tajawal text-xs font-bold mb-1">
                <Users className="w-3.5 h-3.5" />
                <span>إجمالي الطلاب</span>
              </div>
              <p className="text-2xl font-black text-amber-300 font-mono">{cumulativeData.totalStudentsCount}</p>
              <span className="text-[10px] text-slate-400 font-tajawal">جميع المقيدين</span>
            </div>

            {/* Stat 2: Total Sessions */}
            <div className="glass-card p-3.5 rounded-3xl text-center shadow-lg border border-indigo-500/30 bg-indigo-500/5">
              <div className="flex items-center justify-center gap-1.5 text-indigo-400 font-tajawal text-xs font-bold mb-1">
                <Calendar className="w-3.5 h-3.5" />
                <span>الجلسات المعقودة</span>
              </div>
              <p className="text-2xl font-black text-indigo-300 font-mono">{cumulativeData.totalSessionDays}</p>
              <span className="text-[10px] text-slate-400 font-tajawal">أيام حضور فعلية</span>
            </div>

            {/* Stat 3: Total Present */}
            <div className="glass-card p-3.5 rounded-3xl text-center shadow-lg border border-emerald-500/30 bg-emerald-500/5">
              <div className="flex items-center justify-center gap-1.5 text-emerald-400 font-tajawal text-xs font-bold mb-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>إجمالي الحضور</span>
              </div>
              <p className="text-2xl font-black text-emerald-400 font-mono">{cumulativeData.platformTotalPresentScans}</p>
              <span className="text-[10px] text-emerald-300/80 font-tajawal">حضور فعلي مسجل</span>
            </div>

            {/* Stat 4: Average Attendance Rate */}
            <div className="glass-card p-3.5 rounded-3xl text-center shadow-lg border border-sky-500/30 bg-sky-500/5">
              <div className="flex items-center justify-center gap-1.5 text-sky-400 font-tajawal text-xs font-bold mb-1">
                <TrendingUp className="w-3.5 h-3.5" />
                <span>متوسط الحضور العام</span>
              </div>
              <p className="text-2xl font-black text-sky-300 font-mono">{cumulativeData.platformAverageRate}%</p>
              <span className="text-[10px] text-sky-400/80 font-tajawal">نسبة الالتزام بالمنصة</span>
            </div>

            {/* Stat 5: Excellent Attendance (>= 90%) */}
            <div
              onClick={() => setCumulativeRateFilter(cumulativeRateFilter === "EXCELLENT" ? "ALL" : "EXCELLENT")}
              className={`glass-card p-3.5 rounded-3xl text-center shadow-lg cursor-pointer transition-all ${
                cumulativeRateFilter === "EXCELLENT"
                  ? "border-emerald-400 ring-2 ring-emerald-400/30 bg-emerald-500/10"
                  : "border-emerald-500/20 hover:border-emerald-400/40"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5 text-emerald-400 font-tajawal text-xs font-bold mb-1">
                <Award className="w-3.5 h-3.5 text-amber-400" />
                <span>كبار الملتزمين (90%+)</span>
              </div>
              <p className="text-2xl font-black text-emerald-400 font-mono">{cumulativeData.excellentCount}</p>
              <span className="text-[10px] text-emerald-400/80 font-tajawal">انقر للتصفية</span>
            </div>

            {/* Stat 6: Absence Warning (< 75%) */}
            <div
              onClick={() => setCumulativeRateFilter(cumulativeRateFilter === "WARNING" ? "ALL" : "WARNING")}
              className={`glass-card p-3.5 rounded-3xl text-center shadow-lg cursor-pointer transition-all ${
                cumulativeRateFilter === "WARNING"
                  ? "border-rose-400 ring-2 ring-rose-400/30 bg-rose-500/10"
                  : "border-rose-500/20 hover:border-rose-400/40"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5 text-rose-400 font-tajawal text-xs font-bold mb-1">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>إنذار الغياب (&lt;75%)</span>
              </div>
              <p className="text-2xl font-black text-rose-400 font-mono">{cumulativeData.warningCount}</p>
              <span className="text-[10px] text-rose-400/80 font-tajawal">انقر للتصفية</span>
            </div>
          </div>

          {/* Cumulative Filters and Action Bar */}
          <div className="glass-panel p-4 md:p-5 rounded-3xl flex flex-wrap items-center justify-between gap-3.5 shadow-xl">
            <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[300px] font-tajawal">
              {/* Grade Filter */}
              <select
                value={cumulativeGrade}
                onChange={(e) => setCumulativeGrade(e.target.value)}
                className="bg-[#080d1e] border border-indigo-500/30 text-slate-100 text-xs font-bold px-3.5 py-2.5 rounded-2xl outline-none"
              >
                <option value="ALL" className="bg-slate-900 text-white">كل الصفوف الدراسية</option>
                {GRADE_ORDER.map((g) => (
                  <option key={g} value={g} className="bg-slate-900 text-white">
                    {g}
                  </option>
                ))}
              </select>

              {/* Group Days Filter */}
              <select
                value={cumulativeDays}
                onChange={(e) => setCumulativeDays(e.target.value)}
                className="bg-[#080d1e] border border-indigo-500/30 text-slate-100 text-xs font-bold px-3.5 py-2.5 rounded-2xl outline-none"
              >
                <option value="ALL" className="bg-slate-900 text-white">كل الأيام</option>
                <option value="سبت - إثنين - أربعاء" className="bg-slate-900 text-white">سبت - إثنين - أربعاء</option>
                <option value="أحد - ثلاثاء - خميس" className="bg-slate-900 text-white">أحد - ثلاثاء - خميس</option>
              </select>

              {/* Rate Filter */}
              <select
                value={cumulativeRateFilter}
                onChange={(e) => setCumulativeRateFilter(e.target.value as any)}
                className="bg-[#080d1e] border border-indigo-500/30 text-slate-100 text-xs font-bold px-3.5 py-2.5 rounded-2xl outline-none"
              >
                <option value="ALL" className="bg-slate-900 text-white">جميع معدلات الحضور</option>
                <option value="EXCELLENT" className="bg-slate-900 text-white">🟢 ممتاز (90% فأكثر)</option>
                <option value="AVERAGE" className="bg-slate-900 text-white">🟡 متوسط (75% - 89%)</option>
                <option value="WARNING" className="bg-slate-900 text-white">🔴 معرض للإنذار (أقل من 75%)</option>
              </select>

              {/* Search */}
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-amber-400 absolute right-3.5 top-3.5 pointer-events-none" />
                <input
                  type="text"
                  value={cumulativeSearch}
                  onChange={(e) => setCumulativeSearch(e.target.value)}
                  placeholder="بحث باسم الطالب، الباركود، أو الهاتف..."
                  className="w-full bg-[#080d1e] border border-indigo-500/30 text-slate-100 text-xs pr-9 pl-8 py-2.5 rounded-2xl outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400/30 transition-all placeholder:text-slate-500 font-medium"
                />
                {cumulativeSearch && (
                  <button
                    type="button"
                    onClick={() => setCumulativeSearch("")}
                    className="absolute left-2.5 top-2.5 p-0.5 text-slate-400 hover:text-white"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Export Actions for Cumulative Data */}
            <div className="flex items-center gap-2 font-tajawal">
              <button
                type="button"
                onClick={() => exportAllAttendanceHistoryToExcel(students, attendanceHistory)}
                className="px-4 py-2.5 rounded-2xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-400/30 text-emerald-300 text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm cursor-pointer"
                title="تصدير ملف إكسيل كامل يحتوي سجل حضور وغياب كل طالب بالتفصيل عبر كافة الأيام"
              >
                <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                <span>تصدير السجل التراكمي الشامل Excel</span>
              </button>

              <button
                type="button"
                onClick={() => onOpenPdfModal("attendance", undefined, undefined)}
                className="px-4 py-2.5 rounded-2xl bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500 text-white text-xs font-bold transition-all flex items-center gap-1.5 shadow-lg shadow-indigo-500/20 cursor-pointer"
              >
                <FileText className="w-4 h-4" />
                <span>📄 تقرير PDF مجمع للطلاب</span>
              </button>
            </div>
          </div>

          {/* Cumulative Table */}
          <div className="glass-panel rounded-3xl overflow-hidden shadow-2xl">
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse text-xs md:text-sm font-tajawal">
                <thead>
                  <tr className="bg-slate-900/90 text-amber-400 font-bold border-b border-indigo-500/30">
                    <th className="p-3.5">م</th>
                    <th className="p-3.5">الباركود</th>
                    <th className="p-3.5">اسم الطالب</th>
                    <th className="p-3.5">الصف الدراسي</th>
                    <th className="p-3.5">المجموعة</th>
                    <th className="p-3.5 text-center">أيام الحضور</th>
                    <th className="p-3.5 text-center">التأخير</th>
                    <th className="p-3.5 text-center">الغياب</th>
                    <th className="p-3.5 text-center">الأعذار</th>
                    <th className="p-3.5 text-center min-w-[130px]">نسبة الالتزام بالحضور</th>
                    <th className="p-3.5">آخر حضور مسجل</th>
                    <th className="p-3.5 text-center">الإجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-indigo-950/50">
                  {displayedCumulativeStudents.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="p-8 text-center text-slate-400 italic">
                        {cumulativeSearch
                          ? `لا توجد نتائج مطابقة للبحث "${cumulativeSearch}"`
                          : "لا يوجد طلاب مطابقين لخيارات التصفية المحددة."}
                      </td>
                    </tr>
                  ) : (
                    displayedCumulativeStudents.map((rec, idx) => {
                      const s = rec.student;
                      let rateColor = "text-rose-400 bg-rose-500/10 border-rose-500/30";
                      let barColor = "bg-rose-500";
                      if (rec.attendanceRate >= 90) {
                        rateColor = "text-emerald-300 bg-emerald-500/10 border-emerald-500/30";
                        barColor = "bg-emerald-400";
                      } else if (rec.attendanceRate >= 75) {
                        rateColor = "text-amber-300 bg-amber-500/10 border-amber-500/30";
                        barColor = "bg-amber-400";
                      }

                      return (
                        <tr key={s.barcode} className="hover:bg-indigo-500/10 transition-colors font-medium">
                          <td className="p-3.5 font-mono text-slate-400">{idx + 1}</td>
                          <td className="p-3.5 font-mono text-amber-300 font-bold">{s.barcode}</td>
                          <td className="p-3.5 font-bold text-slate-100">{s.name}</td>
                          <td className="p-3.5 text-slate-300">{s.groupGrade}</td>
                          <td className="p-3.5 text-slate-400">{s.groupDays}</td>

                          {/* Present Count */}
                          <td className="p-3.5 text-center">
                            <span className="px-2.5 py-1 rounded-xl bg-emerald-500/20 text-emerald-300 font-mono font-bold border border-emerald-500/30 text-xs">
                              {rec.presentCount}
                            </span>
                          </td>

                          {/* Late Count */}
                          <td className="p-3.5 text-center">
                            <span className="px-2.5 py-1 rounded-xl bg-amber-500/20 text-amber-300 font-mono font-bold border border-amber-500/30 text-xs">
                              {rec.lateCount}
                            </span>
                          </td>

                          {/* Absent Count */}
                          <td className="p-3.5 text-center">
                            <span className="px-2.5 py-1 rounded-xl bg-rose-500/20 text-rose-300 font-mono font-bold border border-rose-500/30 text-xs">
                              {rec.absentCount}
                            </span>
                          </td>

                          {/* Excused Count */}
                          <td className="p-3.5 text-center">
                            <span className="px-2.5 py-1 rounded-xl bg-sky-500/20 text-sky-300 font-mono font-bold border border-sky-500/30 text-xs">
                              {rec.excusedCount}
                            </span>
                          </td>

                          {/* Attendance Rate with Bar */}
                          <td className="p-3.5 text-center">
                            <div className="flex flex-col items-center gap-1">
                              <span className={`px-2 py-0.5 rounded-full font-mono text-xs font-bold border ${rateColor}`}>
                                {rec.attendanceRate}%
                              </span>
                              <div className="w-20 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                                  style={{ width: `${Math.min(100, Math.max(0, rec.attendanceRate))}%` }}
                                />
                              </div>
                            </div>
                          </td>

                          {/* Last Attended */}
                          <td className="p-3.5 font-mono text-slate-300 text-xs">
                            {rec.lastAttendedDate}
                          </td>

                          {/* Actions */}
                          <td className="p-3.5">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setViewingHistoryStudent(rec)}
                                className="px-2.5 py-1.5 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-[11px] font-bold flex items-center gap-1 cursor-pointer transition-all"
                                title="عرض كشف الحضور التفصيلي لكل التواريخ"
                              >
                                <Eye className="w-3 h-3" />
                                <span>تفاصيل الأيام</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => handleSendCumulativeWhatsApp(rec)}
                                className="px-2.5 py-1.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-[11px] font-bold flex items-center gap-1 cursor-pointer transition-all"
                                title="إرسال تقرير الحضور التراكمي الشامل لولي الأمر عبر واتساب"
                              >
                                <Send className="w-3 h-3" />
                                <span>واتساب</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 🌟 MODAL: Student Detailed Attendance Log Modal */}
      {/* ========================================================================= */}
      {viewingHistoryStudent && (
        <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-[#0f172a] border border-amber-500/40 p-6 rounded-3xl max-w-2xl w-full shadow-2xl space-y-4 font-tajawal max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-indigo-900/50 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-amber-400/10 border border-amber-400/30 flex items-center justify-center text-amber-400">
                  <History className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-white">
                    سجل الحضور والغياب التفصيلي للطالب: <span className="text-amber-400">{viewingHistoryStudent.student.name}</span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    كود: <span className="font-mono text-amber-300">{viewingHistoryStudent.student.barcode}</span> | {viewingHistoryStudent.student.groupGrade} ({viewingHistoryStudent.student.groupDays})
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setViewingHistoryStudent(null)}
                className="p-1.5 text-slate-400 hover:text-white rounded-xl bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Quick Stat Highlights */}
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              <div className="bg-[#080d1e] p-2 rounded-xl border border-emerald-500/30">
                <span className="text-slate-400 text-[10px] block">🟢 الحضور</span>
                <span className="text-base font-mono font-bold text-emerald-400">{viewingHistoryStudent.presentCount}</span>
              </div>
              <div className="bg-[#080d1e] p-2 rounded-xl border border-amber-500/30">
                <span className="text-slate-400 text-[10px] block">🟡 التأخير</span>
                <span className="text-base font-mono font-bold text-amber-400">{viewingHistoryStudent.lateCount}</span>
              </div>
              <div className="bg-[#080d1e] p-2 rounded-xl border border-rose-500/30">
                <span className="text-slate-400 text-[10px] block">🔴 الغياب</span>
                <span className="text-base font-mono font-bold text-rose-400">{viewingHistoryStudent.absentCount}</span>
              </div>
              <div className="bg-[#080d1e] p-2 rounded-xl border border-sky-500/30">
                <span className="text-slate-400 text-[10px] block">📈 نسبة الالتزام</span>
                <span className="text-base font-mono font-bold text-sky-300">{viewingHistoryStudent.attendanceRate}%</span>
              </div>
            </div>

            {/* Dates List */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              <h4 className="text-xs font-bold text-slate-300 mb-2">تفاصيل الجلسات المسجلة:</h4>
              {viewingHistoryStudent.dateLogs.length === 0 ? (
                <p className="text-xs text-slate-500 italic text-center py-6">
                  لا توجد سجلات حضور مسجلة لهذا الطالب حتى الآن.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {viewingHistoryStudent.dateLogs.map((log) => {
                    const st = log.status === "غائب" ? "غياب" : log.status;
                    let badgeClass = "bg-slate-800 text-slate-400 border-slate-700";
                    if (st === "حضور") badgeClass = "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
                    else if (st === "تأخير") badgeClass = "bg-amber-500/20 text-amber-300 border-amber-500/40";
                    else if (st === "غياب") badgeClass = "bg-rose-500/20 text-rose-300 border-rose-500/40";
                    else if (st === "إذن") badgeClass = "bg-sky-500/20 text-sky-300 border-sky-500/40";

                    return (
                      <div
                        key={log.date}
                        className="flex items-center justify-between p-3 rounded-xl bg-[#080d1e] border border-indigo-950 hover:border-indigo-800/60 text-xs transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <Calendar className="w-3.5 h-3.5 text-amber-400" />
                          <span className="font-mono text-slate-200 font-bold">{log.date}</span>
                        </div>
                        <span className={`px-3 py-1 rounded-full text-xs font-bold border ${badgeClass}`}>
                          {st}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-2 pt-3 border-t border-indigo-900/50">
              <button
                type="button"
                onClick={() => handleSendCumulativeWhatsApp(viewingHistoryStudent)}
                className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black shadow-md flex items-center gap-1.5 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>إرسال تقرير الحضور لولي الأمر (واتساب)</span>
              </button>

              <button
                type="button"
                onClick={() => setViewingHistoryStudent(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold hover:bg-slate-700 cursor-pointer"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 🌟 MODAL: Edit Status Modal (Daily View) */}
      {/* ========================================================================= */}
      {editingStudent && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#121926] border border-amber-500/40 p-6 rounded-2xl max-w-md w-full shadow-2xl space-y-4 animate-in fade-in zoom-in-95 font-tajawal">
            <h3 className="text-base font-extrabold text-amber-400 border-b border-amber-500/20 pb-2">
              🔄 تعديل حالة حضور الطالب
            </h3>
            <div className="text-xs space-y-2 text-slate-300">
              <p>
                اسم الطالب: <span className="font-bold text-white">{editingStudent.name}</span>
              </p>
              <p>
                التاريخ: <span className="font-mono text-amber-300">{selectedDate}</span>
              </p>
            </div>

            <form onSubmit={handleSaveStatus} className="space-y-4 pt-2">
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-300">اختر الحالة الجديدة:</label>
                <select
                  value={newStatusSelect}
                  onChange={(e) => setNewStatusSelect(e.target.value)}
                  className="w-full bg-[#090e17] border border-amber-500/40 text-slate-100 px-3 py-2.5 rounded-xl font-bold text-sm outline-none"
                >
                  <option value="حضور">🟢 حضور (في الموعد)</option>
                  <option value="تأخير">🟡 تأخير</option>
                  <option value="عوض الحصة">🔵 عوض الحصة (حضور تعويضي)</option>
                  <option value="غياب">🔴 غياب</option>
                  <option value="إذن">⚪ إذن مسبق / عذر</option>
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingStudent(null)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold hover:bg-slate-700"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs font-black shadow-md"
                >
                  تحديث وحفظ الحالة
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
