import React, { useState, useMemo } from "react";
import { Student, GradeName, GroupDays, GRADE_ORDER } from "../types";
import { getTodayKey, openWhatsApp, sortStudentsByGradeAndName, getDefaultGroupDaysForDate } from "../utils/helpers";
import { matchStudentSearch } from "../utils/search";
import { exportAttendanceHistoryToExcel } from "../utils/excel";
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
} from "lucide-react";

interface DailyAttendanceReportProps {
  students: Student[];
  attendanceHistory: Record<string, Record<string, string>>;
  onUpdateStatus: (barcode: string, dateKey: string, newStatus: string) => void;
  onDeleteDateRecords?: (dateKey: string) => void;
  onOpenPdfModal: (type: "attendance", targetDate?: string, targetAttendanceMap?: Record<string, string>) => void;
}

type StatusFilterType = "ALL" | "حضور" | "تأخير" | "غياب" | "إذن" | "لم يسجل";

export const DailyAttendanceReport: React.FC<DailyAttendanceReportProps> = ({
  students,
  attendanceHistory,
  onUpdateStatus,
  onDeleteDateRecords,
  onOpenPdfModal,
}) => {
  const todayKey = getTodayKey();
  const [selectedDate, setSelectedDate] = useState<string>(todayKey);
  const [filterGrade, setFilterGrade] = useState<string>("ALL");
  const [filterDays, setFilterDays] = useState<string>(() => {
    try {
      return getDefaultGroupDaysForDate(new Date());
    } catch {
      return "ALL";
    }
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("ALL");

  const isFutureDate = selectedDate > todayKey;

  // List of all dates that actually have attendance records
  const recordedDates = useMemo(() => {
    return Object.keys(attendanceHistory)
      .filter((d) => attendanceHistory[d] && Object.keys(attendanceHistory[d]).length > 0)
      .sort((a, b) => b.localeCompare(a));
  }, [attendanceHistory]);

  // Automatically sync day-group filter when user changes date
  const handleDateChange = (newDate: string) => {
    setSelectedDate(newDate);
    try {
      const parts = newDate.split("-");
      if (parts.length === 3) {
        const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        if (!isNaN(d.getTime())) {
          setFilterDays(getDefaultGroupDaysForDate(d));
        }
      }
    } catch (err) {
      console.warn("Date parse error:", err);
    }
  };

  const [editingStudent, setEditingStudent] = useState<{ barcode: string; name: string; currentStatus: string } | null>(null);
  const [newStatusSelect, setNewStatusSelect] = useState("حضور");

  const dateAttendanceMap = useMemo(() => {
    return attendanceHistory[selectedDate] || {};
  }, [attendanceHistory, selectedDate]);

  // Base list of students matching grade and group days
  const baseStudents = useMemo(() => {
    const base = students.filter((s) => {
      if (filterGrade !== "ALL" && s.groupGrade !== filterGrade) return false;
      if (filterDays !== "ALL") {
        if (s.groupDays === filterDays) return true;
        // Include other-group students ONLY if they actually attended on this specific date (compensation session)
        const st = dateAttendanceMap[s.barcode];
        if (st === "حضور" || st === "تأخير") {
          return true;
        }
        return false;
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
  }, [students, filterGrade, filterDays, searchQuery, dateAttendanceMap]);

  // Comprehensive metric calculation with zero leakage
  const { presentCount, lateCount, absentCount, excusedCount, unrecordedCount, totalCount } = useMemo(() => {
    let present = 0;
    let late = 0;
    let absent = 0;
    let excused = 0;

    baseStudents.forEach((s) => {
      const st = dateAttendanceMap[s.barcode];
      if (st === "حضور") present++;
      else if (st === "تأخير") late++;
      else if (st === "غياب" || st === "غائب") absent++;
      else if (st === "إذن") excused++;
    });

    const total = baseStudents.length;
    const unrecorded = Math.max(0, total - (present + late + absent + excused));

    return {
      totalCount: total,
      presentCount: present,
      lateCount: late,
      absentCount: absent,
      excusedCount: excused,
      unrecordedCount: unrecorded,
    };
  }, [baseStudents, dateAttendanceMap]);

  // Calculate percentages cleanly
  const presentPercent = totalCount > 0 ? Math.round((presentCount / totalCount) * 100) : 0;
  const latePercent = totalCount > 0 ? Math.round((lateCount / totalCount) * 100) : 0;
  const absentPercent = totalCount > 0 ? Math.round((absentCount / totalCount) * 100) : 0;
  const excusedPercent = totalCount > 0 ? Math.round((excusedCount / totalCount) * 100) : 0;
  const unrecordedPercent = totalCount > 0 ? Math.round((unrecordedCount / totalCount) * 100) : 0;

  // Filter students by selected status (if user clicked quick-filter)
  const displayedStudents = useMemo(() => {
    if (statusFilter === "ALL") return baseStudents;

    return baseStudents.filter((s) => {
      const raw = dateAttendanceMap[s.barcode];
      if (statusFilter === "حضور") return raw === "حضور";
      if (statusFilter === "تأخير") return raw === "تأخير";
      if (statusFilter === "غياب") return raw === "غياب" || raw === "غائب";
      if (statusFilter === "إذن") return raw === "إذن";
      if (statusFilter === "لم يسجل") return !raw;
      return true;
    });
  }, [baseStudents, dateAttendanceMap, statusFilter]);

  const handleSaveStatus = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStudent) return;
    onUpdateStatus(editingStudent.barcode, selectedDate, newStatusSelect);
    setEditingStudent(null);
  };

  return (
    <div className="space-y-6">
      {/* Recorded Dates Pill Selector */}
      {recordedDates.length > 0 && (
        <div className="glass-panel p-3.5 rounded-2xl flex flex-wrap items-center gap-2 font-tajawal text-xs shadow-md">
          <span className="text-amber-300 font-bold flex items-center gap-1.5 shrink-0">
            <Calendar className="w-3.5 h-3.5 text-amber-400" />
            <span>الأيام المسجل لها حضور فعلي بالنظام:</span>
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {recordedDates.map((dKey) => {
              const count = Object.keys(attendanceHistory[dKey] || {}).length;
              const isCurrent = dKey === selectedDate;
              return (
                <button
                  key={dKey}
                  type="button"
                  onClick={() => handleDateChange(dKey)}
                  className={`px-3 py-1 rounded-xl font-mono text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                    isCurrent
                      ? "bg-amber-400 text-slate-950 shadow-md shadow-amber-400/20"
                      : "bg-[#080d1e] border border-indigo-500/30 text-slate-300 hover:text-white hover:border-amber-400/50"
                  }`}
                >
                  <span>{dKey}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-md ${
                      isCurrent ? "bg-slate-900 text-amber-300 font-bold" : "bg-indigo-500/20 text-slate-400"
                    }`}
                  >
                    {count} سجل
                  </span>
                </button>
              );
            })}
          </div>
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

      {/* Attendance Table */}
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
                  const rawStatus = dateAttendanceMap[student.barcode];
                  const status =
                    rawStatus === "غائب" || rawStatus === "غياب"
                      ? "غياب"
                      : rawStatus || "لم يسجل";

                  let statusBg = "bg-slate-800 text-slate-400 border-slate-700";
                  if (status === "حضور") statusBg = "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
                  else if (status === "تأخير") statusBg = "bg-amber-500/20 text-amber-300 border-amber-500/40";
                  else if (status === "غياب") statusBg = "bg-rose-500/20 text-rose-300 border-rose-500/40";
                  else if (status === "إذن") statusBg = "bg-sky-500/20 text-sky-300 border-sky-500/40";

                  return (
                    <tr key={student.barcode} className="hover:bg-indigo-500/10 transition-colors font-medium">
                      <td className="p-3.5 font-mono text-slate-400">{idx + 1}</td>
                      <td className="p-3.5 font-mono text-amber-300 font-bold">{student.barcode}</td>
                      <td className="p-3.5 font-bold text-slate-100">{student.name}</td>
                      <td className="p-3.5 text-slate-300">{student.groupGrade}</td>
                      <td className="p-3.5 text-slate-400">
                        <div className="flex items-center gap-1.5">
                          <span>{student.groupDays}</span>
                          {filterDays !== "ALL" && student.groupDays !== filterDays && (
                            <span className="text-[10px] bg-sky-500/20 text-sky-300 border border-sky-500/30 px-2 py-0.5 rounded-full font-bold">
                              🔄 تعويض
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-3.5">
                        <span className={`px-3 py-1 rounded-full text-xs font-bold border inline-block ${statusBg}`}>
                          {status}
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

      {/* Edit Status Modal */}
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
