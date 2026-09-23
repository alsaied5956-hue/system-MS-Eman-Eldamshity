import React, { useState, useMemo, useEffect } from "react";
import { Student, StudentExamRecord } from "../types";
import { getTodayKey, openWhatsApp } from "../utils/helpers";
import { playBeep } from "../utils/audio";
import {
  Award,
  Calendar,
  CheckCircle2,
  Clock,
  Edit2,
  FileSpreadsheet,
  FileText,
  Plus,
  Search,
  Share2,
  Star,
  Trash2,
  TrendingUp,
  X,
  AlertTriangle,
  BookOpen,
  ArrowUpDown,
} from "lucide-react";
import * as XLSX from "xlsx";

interface StudentExamsHistoryModalProps {
  student: Student | null;
  isOpen: boolean;
  onClose: () => void;
  onSaveExams: (
    barcode: string,
    updatedExams: StudentExamRecord[],
    pointsDelta?: number
  ) => void;
}

export const StudentExamsHistoryModal: React.FC<StudentExamsHistoryModalProps> = ({
  student,
  isOpen,
  onClose,
  onSaveExams,
}) => {
  if (!isOpen || !student) return null;

  // Initialize or backfill full exam history from totalExamScores if needed
  const initialExams = useMemo<StudentExamRecord[]>(() => {
    if (Array.isArray(student.examHistory) && student.examHistory.length > 0) {
      return [...student.examHistory];
    }
    // Fallback: If examHistory was not directly stored, construct from real scores
    if (Array.isArray(student.totalExamScores) && student.totalExamScores.length > 0) {
      const titles = ["التقييم الأول", "التقييم الثاني", "التقييم الثالث"];
      return student.totalExamScores.map((score, idx) => {
        const isLast = idx === student.totalExamScores.length - 1;
        const examTitle = isLast && student.lastExamTitle ? student.lastExamTitle : (titles[idx] || `تقييم ${idx + 1}`);
        let examScore = score;
        let examMax = 100;
        if (isLast && student.lastExamScore) {
          const match = student.lastExamScore.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/);
          if (match) {
            examScore = parseFloat(match[1]);
            examMax = parseFloat(match[2]);
          }
        }
        return {
          id: `exam_${student.barcode}_${idx + 1}`,
          examTitle,
          date: student.createdAt ? student.createdAt.slice(0, 10) : getTodayKey(),
          score: examScore,
          maxScore: examMax,
          percentage: score,
          notes: "سجل تقييم محفوظ",
        };
      });
    }
    return [];
  }, [student]);

  const [examsList, setExamsList] = useState<StudentExamRecord[]>(initialExams);

  useEffect(() => {
    setExamsList(initialExams);
  }, [initialExams]);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest" | "highest" | "lowest">("newest");

  // Form states for adding / editing exam
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingExamId, setEditingExamId] = useState<string | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formDate, setFormDate] = useState(getTodayKey());
  const [formScore, setFormScore] = useState<number | "">("");
  const [formMaxScore, setFormMaxScore] = useState<number>(20);
  const [formNotes, setFormNotes] = useState("");
  const [formSendWhatsApp, setFormSendWhatsApp] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Delete confirmation
  const [deletingExamId, setDeletingExamId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Summary statistics
  const stats = useMemo(() => {
    const count = examsList.length;
    if (count === 0) {
      return { count: 0, avg: 0, highest: 0, lowest: 0 };
    }
    const percentages = examsList.map((e) => e.percentage);
    const sum = percentages.reduce((acc, curr) => acc + curr, 0);
    const avg = Math.round(sum / count);
    const highest = Math.max(...percentages);
    const lowest = Math.min(...percentages);
    return { count, avg, highest, lowest };
  }, [examsList]);

  // Filtered and sorted exams
  const displayExams = useMemo(() => {
    let result = examsList.filter((e) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase().trim();
      return (
        (e.examTitle && e.examTitle.toLowerCase().includes(q)) ||
        (e.date && e.date.includes(q)) ||
        (e.notes && e.notes.toLowerCase().includes(q))
      );
    });

    result = [...result].sort((a, b) => {
      if (sortOrder === "newest") return b.date.localeCompare(a.date);
      if (sortOrder === "oldest") return a.date.localeCompare(b.date);
      if (sortOrder === "highest") return b.percentage - a.percentage;
      if (sortOrder === "lowest") return a.percentage - b.percentage;
      return 0;
    });

    return result;
  }, [examsList, searchQuery, sortOrder]);

  // Open add exam form
  const handleOpenAddForm = () => {
    setEditingExamId(null);
    setFormTitle(`امتحان رقم ${examsList.length + 1}`);
    setFormDate(getTodayKey());
    setFormScore("");
    setFormMaxScore(20);
    setFormNotes("");
    setFormSendWhatsApp(false);
    setFormError(null);
    setIsFormOpen(true);
  };

  // Open edit exam form
  const handleOpenEditForm = (exam: StudentExamRecord) => {
    setEditingExamId(exam.id);
    setFormTitle(exam.examTitle);
    setFormDate(exam.date || getTodayKey());
    setFormScore(exam.score);
    setFormMaxScore(exam.maxScore || 100);
    setFormNotes(exam.notes || "");
    setFormSendWhatsApp(false);
    setFormError(null);
    setIsFormOpen(true);
  };

  // Save exam (Add or Update)
  const handleSaveForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTitle.trim()) {
      setFormError("يرجى إدخال عنوان أو موضوع الامتحان");
      return;
    }
    if (formScore === "" || formScore === null || isNaN(Number(formScore))) {
      setFormError("يرجى إدخال درجة الطالب الفعلية");
      return;
    }
    const scoreNum = Number(formScore);
    const maxNum = Number(formMaxScore);

    if (scoreNum < 0) {
      setFormError("لا يمكن أن تكون الدرجة أقل من صفر");
      return;
    }
    if (maxNum <= 0) {
      setFormError("الدرجة العظمى يجب أن تكون أكبر من صفر");
      return;
    }
    if (scoreNum > maxNum) {
      setFormError(`الدرجة (${scoreNum}) لا يمكن أن تتعدى الدرجة العظمى (${maxNum})`);
      return;
    }

    const percentage = Math.round((scoreNum / maxNum) * 100);

    let updated: StudentExamRecord[];
    let bonusPoints = 0;

    if (editingExamId) {
      // Update existing
      updated = examsList.map((item) => {
        if (item.id === editingExamId) {
          return {
            ...item,
            examTitle: formTitle.trim(),
            date: formDate,
            score: scoreNum,
            maxScore: maxNum,
            percentage,
            notes: formNotes.trim() || undefined,
          };
        }
        return item;
      });
      showToast(`✅ تم تعديل درجات ${formTitle} بنجاح`);
    } else {
      // Add new exam
      const newRecord: StudentExamRecord = {
        id: `exam_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        examTitle: formTitle.trim(),
        date: formDate,
        score: scoreNum,
        maxScore: maxNum,
        percentage,
        notes: formNotes.trim() || undefined,
      };
      updated = [...examsList, newRecord];
      showToast(`🎉 تم رصد الامتحان بنجاح وحفظه في سجل الطالب`);
    }

    setExamsList(updated);
    onSaveExams(student.barcode, updated, 0);
    playBeep("success");
    setIsFormOpen(false);

    // Send WhatsApp if toggled
    if (formSendWhatsApp) {
      const parentPhone = student.parentPhone || student.phone;
      if (parentPhone) {
        let evalText = "ممتاز جداً 🌟";
        if (percentage < 60) evalText = "يحتاج متابعة وتكثيف المذاكرة ⚠️";
        else if (percentage < 80) evalText = "جيد 👍 مع خالص التمنيات بمزيد من التفوق";

        const msg = `نتيجة اختبار الرياضيات 📐\nالأستاذة إيمان الدمشيتي\n\nاسم الطالب/ة: ${student.name}\nالصف: ${student.groupGrade}\nالامتحان: ${formTitle.trim()}\nالتاريخ: ${formDate}\nالدرجة: ${scoreNum} من ${maxNum} (${percentage}%)\nالتقييم: ${evalText}\n\nشكراً لتعاونكم معنا 🌟`;
        openWhatsApp(parentPhone, msg);
      }
    }
  };

  // Delete Exam
  const handleDeleteExam = (examId: string) => {
    const updated = examsList.filter((e) => e.id !== examId);
    setExamsList(updated);
    onSaveExams(student.barcode, updated, 0);
    setDeletingExamId(null);
    showToast("🗑️ تم حذف الامتحان وتحديث سجل الطالب");
  };

  // Export to Excel
  const handleExportExcel = () => {
    const rows = examsList.map((e, idx) => ({
      "م": idx + 1,
      "اسم الطالب": student.name,
      "كود الباركود": student.barcode,
      "الصف الدراسي": student.groupGrade,
      "عنوان الاختبار": e.examTitle,
      "تاريخ الاختبار": e.date,
      "الدرجة المحصلة": e.score,
      "الدرجة النهائية": e.maxScore,
      "النسبة المئوية %": `${e.percentage}%`,
      "التقدير":
        e.percentage >= 90
          ? "ممتاز 🌟"
          : e.percentage >= 75
          ? "جيد جداً"
          : e.percentage >= 60
          ? "جيد"
          : "يحتاج تحسين",
      "ملاحظات": e.notes || "-",
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!views"] = [{ RTL: true }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, `امتحانات ${student.name}`);
    XLSX.writeFile(workbook, `سجل_امتحانات_${student.name}_${student.barcode}.xlsx`);
    showToast("📥 تم تصدير سجل امتحانات الطالب إلى Excel");
  };

  // Send Full WhatsApp Transcript
  const handleSendFullWhatsApp = () => {
    const parentPhone = student.parentPhone || student.phone;
    if (!parentPhone) {
      alert("⚠️ لا يوجد رقم هاتف مسجل لولي الأمر أو الطالب!");
      return;
    }

    let report = `📊 كشف الدرجات التفصيلي والشامل في الرياضيات 📐\nالأستاذة إيمان الدمشيتي\n\n`;
    report += `🔹 اسم الطالب/ة: ${student.name}\n`;
    report += `📚 الصف الدراسي: ${student.groupGrade}\n`;
    report += `📝 إجمالي الامتحانات المؤداة: ${stats.count} امتحان\n`;
    report += `📈 متوسط الدرجات العام: ${stats.avg}%\n`;
    report += `⭐ نقاط التميز: ${student.points || 0} نقطة\n\n`;
    report += `═════════════════════\n`;
    report += `سجل الاختبارات والنتائج:\n`;

    examsList.forEach((e, idx) => {
      report += `${idx + 1}. ${e.examTitle} (${e.date}): ${e.score}/${e.maxScore} (${e.percentage}%)\n`;
    });

    report += `═════════════════════\n`;
    report += `مع تحيات الأستاذة إيمان الدمشيتي 📐✨`;

    openWhatsApp(parentPhone, report);
  };

  // Print Student Report Card
  const handlePrint = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      alert("يرجى السماح بالنوافذ المنبثقة للطباعة");
      return;
    }

    const html = `
      <!DOCTYPE html>
      <html dir="rtl" lang="ar">
      <head>
        <meta charset="utf-8" />
        <title>كشف درجات الطالب - ${student.name}</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 25px; direction: rtl; color: #1e293b; }
          .header { text-align: center; border-bottom: 2px solid #0284c7; padding-bottom: 15px; margin-bottom: 20px; }
          .header h1 { margin: 0; color: #0369a1; font-size: 24px; }
          .header p { margin: 5px 0 0; color: #64748b; font-size: 14px; }
          .student-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 15px; margin-bottom: 20px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; }
          .student-card div { min-width: 200px; font-size: 14px; }
          .student-card strong { color: #0f172a; }
          .stats-row { display: flex; gap: 15px; margin-bottom: 20px; }
          .stat-box { flex: 1; background: #e0f2fe; border: 1px solid #bae6fd; border-radius: 8px; padding: 10px; text-align: center; }
          .stat-box .val { font-size: 20px; font-weight: bold; color: #0369a1; }
          .stat-box .lbl { font-size: 12px; color: #075985; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
          th, td { border: 1px solid #cbd5e1; padding: 8px 12px; text-align: right; }
          th { background-color: #f1f5f9; color: #0f172a; font-weight: bold; }
          tr:nth-child(even) { background-color: #f8fafc; }
          .badge { display: inline-block; padding: 3px 8px; border-radius: 6px; font-weight: bold; font-size: 12px; }
          .badge-green { background: #dcfce7; color: #166534; }
          .badge-yellow { background: #fef9c3; color: #854d0e; }
          .badge-red { background: #fee2e2; color: #991b1b; }
          .footer { margin-top: 30px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 10px; }
          @media print {
            body { padding: 0; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>ميس إيمان الدمشيتي - معلمة الرياضيات</h1>
          <p>كشف السجل الأكاديمي ودرجات الامتحانات التفصيلية</p>
        </div>

        <div class="student-card">
          <div><strong>اسم الطالب/ة:</strong> ${student.name}</div>
          <div><strong>كود الباركود:</strong> ${student.barcode}</div>
          <div><strong>الصف الدراسي:</strong> ${student.groupGrade}</div>
          <div><strong>المجموعة:</strong> ${student.groupDays} (${student.groupTime || "موعد ثابت"})</div>
        </div>

        <div class="stats-row">
          <div class="stat-box">
            <div class="val">${stats.count}</div>
            <div class="lbl">إجمالي الامتحانات</div>
          </div>
          <div class="stat-box">
            <div class="val">${stats.avg}%</div>
            <div class="lbl">متوسط الدرجات العام</div>
          </div>
          <div class="stat-box">
            <div class="val">${stats.highest}%</div>
            <div class="lbl">أعلى نسبة محققة</div>
          </div>
          <div class="stat-box">
            <div class="val">${student.points || 0} ⭐</div>
            <div class="lbl">إجمالي النقاط</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th style="width: 40px;">م</th>
              <th>عنوان / موضوع الامتحان</th>
              <th>تاريخ الامتحان</th>
              <th>الدرجة</th>
              <th>النسبة %</th>
              <th>التقدير</th>
              <th>ملاحظات</th>
            </tr>
          </thead>
          <tbody>
            ${examsList
              .map(
                (e, idx) => `
              <tr>
                <td>${idx + 1}</td>
                <td><strong>${e.examTitle}</strong></td>
                <td>${e.date}</td>
                <td>${e.score} / ${e.maxScore}</td>
                <td>
                  <span class="badge ${
                    e.percentage >= 85 ? "badge-green" : e.percentage >= 65 ? "badge-yellow" : "badge-red"
                  }">${e.percentage}%</span>
                </td>
                <td>${
                  e.percentage >= 90
                    ? "ممتاز 🌟"
                    : e.percentage >= 75
                    ? "جيد جداً"
                    : e.percentage >= 60
                    ? "جيد"
                    : "يحتاج تركيز"
                }</td>
                <td>${e.notes || "-"}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>

        <div class="footer">
          تم استخراج هذا التقرير رسمياً من منظومة متابعة ميس إيمان الدمشيتي بتاريخ ${getTodayKey()}
        </div>

        <script>
          window.onload = function() { window.print(); }
        </script>
      </body>
      </html>
    `;

    printWindow.document.write(html);
    printWindow.document.close();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200 font-tajawal">
      <div className="bg-[#0b1329] border border-indigo-500/30 w-full max-w-4xl max-h-[92vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-5 md:p-6 border-b border-indigo-500/20 bg-slate-950/50 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <Award className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg md:text-xl font-black text-slate-100">{student.name}</h2>
                <span className="font-mono text-xs px-2.5 py-0.5 rounded-lg bg-amber-400/10 border border-amber-400/30 text-amber-300 font-bold">
                  {student.barcode}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {student.groupGrade} • {student.groupDays} • {student.groupTime || "موعد ثابت"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrint}
              className="p-2.5 rounded-2xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition-all text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              title="طباعة كشف درجات الطالب"
            >
              <FileText className="w-4 h-4 text-sky-400" />
              <span className="hidden sm:inline">طباعة الكشف</span>
            </button>

            <button
              type="button"
              onClick={handleExportExcel}
              className="p-2.5 rounded-2xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 transition-all text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              title="تصدير إلى Excel"
            >
              <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
              <span className="hidden sm:inline">Excel</span>
            </button>

            <button
              type="button"
              onClick={handleSendFullWhatsApp}
              className="p-2.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white transition-all text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-lg shadow-emerald-600/20"
              title="إرسال كشف الدرجات لوالي الأمر عبر واتساب"
            >
              <Share2 className="w-4 h-4" />
              <span className="hidden sm:inline">واتساب ولي الأمر</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-2.5 rounded-2xl bg-slate-800/80 hover:bg-rose-950/80 hover:text-rose-300 text-slate-400 hover:border hover:border-rose-500/40 transition-all cursor-pointer"
              title="إغلاق"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Stats Row */}
        <div className="p-4 md:px-6 bg-slate-900/40 border-b border-indigo-500/10 grid grid-cols-2 sm:grid-cols-5 gap-2.5">
          <div className="bg-[#0f172a] p-3 rounded-2xl border border-indigo-500/20 text-center">
            <span className="text-[11px] text-slate-400 block font-medium">إجمالي الامتحانات</span>
            <span className="text-xl font-black text-amber-300 font-mono mt-0.5 block">
              {stats.count}
            </span>
          </div>

          <div className="bg-[#0f172a] p-3 rounded-2xl border border-indigo-500/20 text-center">
            <span className="text-[11px] text-slate-400 block font-medium">متوسط الدرجات</span>
            <span
              className={`text-xl font-black font-mono mt-0.5 block ${
                stats.avg >= 85
                  ? "text-emerald-400"
                  : stats.avg >= 65
                  ? "text-amber-400"
                  : "text-rose-400"
              }`}
            >
              {stats.avg}%
            </span>
          </div>

          <div className="bg-[#0f172a] p-3 rounded-2xl border border-indigo-500/20 text-center">
            <span className="text-[11px] text-slate-400 block font-medium">أعلى نتيجة</span>
            <span className="text-xl font-black text-emerald-400 font-mono mt-0.5 block">
              {stats.highest}%
            </span>
          </div>

          <div className="bg-[#0f172a] p-3 rounded-2xl border border-indigo-500/20 text-center">
            <span className="text-[11px] text-slate-400 block font-medium">أدنى نتيجة</span>
            <span className="text-xl font-black text-slate-300 font-mono mt-0.5 block">
              {stats.lowest}%
            </span>
          </div>

          <div className="bg-[#0f172a] p-3 rounded-2xl border border-indigo-500/20 text-center col-span-2 sm:col-span-1">
            <span className="text-[11px] text-slate-400 block font-medium">نقاط التميز ⭐</span>
            <span className="text-xl font-black text-amber-400 font-mono mt-0.5 flex items-center justify-center gap-1">
              <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
              {student.points || 0}
            </span>
          </div>
        </div>

        {/* Toast Feedback */}
        {toastMessage && (
          <div className="mx-6 mt-3 p-3 rounded-2xl bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 text-xs font-bold flex items-center gap-2 animate-in fade-in">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{toastMessage}</span>
          </div>
        )}

        {/* Controls Bar */}
        <div className="p-4 md:px-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[260px]">
            {/* Search */}
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-3 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="بحث في امتحانات الطالب (بالعنوان أو التاريخ)..."
                className="w-full bg-[#080d1e] border border-indigo-500/30 text-slate-100 text-xs pr-9 pl-4 py-2.5 rounded-2xl outline-none focus:border-amber-400 transition-all placeholder:text-slate-500"
              />
            </div>

            {/* Sort order */}
            <div className="flex items-center gap-1.5">
              <ArrowUpDown className="w-4 h-4 text-slate-400 shrink-0" />
              <select
                value={sortOrder}
                onChange={(e: any) => setSortOrder(e.target.value)}
                className="bg-[#080d1e] border border-indigo-500/30 text-slate-200 text-xs font-bold px-3 py-2.5 rounded-2xl outline-none"
              >
                <option value="newest">الأحدث أولاً</option>
                <option value="oldest">الأقدم أولاً</option>
                <option value="highest">الأعلى درجة</option>
                <option value="lowest">الأقل درجة</option>
              </select>
            </div>
          </div>

          <button
            type="button"
            onClick={handleOpenAddForm}
            className="px-4 py-2.5 rounded-2xl bg-gradient-to-r from-amber-400 to-amber-300 hover:from-amber-300 hover:to-yellow-200 text-slate-950 text-xs font-black transition-all flex items-center gap-1.5 shadow-lg shadow-amber-400/20 cursor-pointer hover:scale-105 active:scale-95"
          >
            <Plus className="w-4 h-4" />
            <span>➕ رصد امتحان جديد لهذا الطالب</span>
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-4 md:px-6 space-y-4">
          {/* Add / Edit Exam Form */}
          {isFormOpen && (
            <div className="bg-[#0d1633] border border-amber-400/40 rounded-3xl p-5 shadow-2xl animate-in zoom-in-95 duration-150 space-y-4">
              <div className="flex items-center justify-between border-b border-indigo-500/20 pb-3">
                <h3 className="text-sm font-black text-amber-300 flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-amber-400" />
                  <span>{editingExamId ? "تعديل درجات الامتحان" : "رصد امتحان واختبار جديد للطالب"}</span>
                </h3>
                <button
                  type="button"
                  onClick={() => setIsFormOpen(false)}
                  className="p-1 rounded-xl text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {formError && (
                <div className="p-3 rounded-2xl bg-rose-950/80 border border-rose-500/40 text-rose-300 text-xs font-bold flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <form onSubmit={handleSaveForm} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="sm:col-span-2">
                    <label className="text-[11px] text-slate-300 font-bold block mb-1">
                      عنوان أو موضوع الاختبار *
                    </label>
                    <input
                      type="text"
                      value={formTitle}
                      onChange={(e) => setFormTitle(e.target.value)}
                      placeholder="مثال: اختبار الجبر - الوحدة الأولى"
                      className="w-full bg-[#080d1e] border border-indigo-500/30 text-slate-100 text-xs px-3.5 py-2.5 rounded-2xl outline-none focus:border-amber-400 font-medium"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-slate-300 font-bold block mb-1">
                      تاريخ الاختبار *
                    </label>
                    <input
                      type="date"
                      value={formDate}
                      onChange={(e) => setFormDate(e.target.value)}
                      className="w-full bg-[#080d1e] border border-indigo-500/30 text-slate-100 text-xs px-3 py-2.5 rounded-2xl outline-none focus:border-amber-400 font-mono text-center"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] text-slate-300 font-bold block mb-1">
                        الدرجة *
                      </label>
                      <input
                        type="number"
                        step="0.5"
                        value={formScore}
                        onChange={(e) =>
                          setFormScore(e.target.value === "" ? "" : parseFloat(e.target.value))
                        }
                        placeholder="18"
                        className="w-full bg-[#080d1e] border border-indigo-500/30 text-amber-300 text-xs px-2.5 py-2.5 rounded-2xl outline-none focus:border-amber-400 font-bold text-center font-mono"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] text-slate-300 font-bold block mb-1">
                        من (العظمى) *
                      </label>
                      <input
                        type="number"
                        value={formMaxScore}
                        onChange={(e) => setFormMaxScore(parseInt(e.target.value, 10) || 10)}
                        className="w-full bg-[#080d1e] border border-indigo-500/30 text-slate-300 text-xs px-2.5 py-2.5 rounded-2xl outline-none focus:border-amber-400 font-mono text-center font-bold"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
                  <div className="sm:col-span-2">
                    <label className="text-[11px] text-slate-300 font-bold block mb-1">
                      ملاحظات على مستوى الطالب (اختياري)
                    </label>
                    <input
                      type="text"
                      value={formNotes}
                      onChange={(e) => setFormNotes(e.target.value)}
                      placeholder="مثال: إتقان ممتاز للمسائل الهندسية، يحتاج تركيز في التحليل..."
                      className="w-full bg-[#080d1e] border border-indigo-500/30 text-slate-100 text-xs px-3.5 py-2 rounded-2xl outline-none focus:border-amber-400"
                    />
                  </div>

                  <div>
                    {formScore !== "" && formMaxScore > 0 && (
                      <div className="p-2.5 rounded-2xl bg-slate-900 border border-indigo-500/20 text-center">
                        <span className="text-[10px] text-slate-400 block">النسبة المئوية المقدرة</span>
                        <span className="text-base font-black text-amber-300 font-mono">
                          {Math.round((Number(formScore) / Number(formMaxScore)) * 100)}%
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300 font-bold">
                    <input
                      type="checkbox"
                      checked={formSendWhatsApp}
                      onChange={(e) => setFormSendWhatsApp(e.target.checked)}
                      className="rounded accent-emerald-500 w-4 h-4 cursor-pointer"
                    />
                    <span>📲 إرسال إشعار فوري لولي الأمر عبر واتساب بهذه الدرجة</span>
                  </label>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsFormOpen(false)}
                      className="px-4 py-2 rounded-2xl bg-slate-800 text-slate-300 hover:text-white text-xs font-bold cursor-pointer"
                    >
                      إلغاء
                    </button>
                    <button
                      type="submit"
                      className="px-5 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black shadow-lg shadow-emerald-600/30 cursor-pointer"
                    >
                      {editingExamId ? "💾 حفظ التعديلات" : "➕ إضافة للسجل"}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          )}

          {/* Delete Confirmation Alert */}
          {deletingExamId && (
            <div className="p-4 rounded-3xl bg-rose-950/90 border border-rose-500/50 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-rose-300 text-xs font-bold">
                <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
                <span>هل أنت متأكد من حذف هذا الامتحان من سجل الطالب نهائياً؟</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDeletingExamId(null)}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteExam(deletingExamId)}
                  className="px-3.5 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-black cursor-pointer shadow-lg shadow-rose-600/30"
                >
                  نعم، احذف الامتحان
                </button>
              </div>
            </div>
          )}

          {/* Exams Table */}
          <div className="glass-panel rounded-3xl overflow-hidden border border-indigo-500/20 shadow-xl">
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-950/70 text-amber-300 font-extrabold border-b border-indigo-500/20">
                    <th className="p-3 text-center">#</th>
                    <th className="p-3">عنوان / موضوع الامتحان</th>
                    <th className="p-3 text-center">تاريخ الاختبار</th>
                    <th className="p-3 text-center">الدرجة الفعلية</th>
                    <th className="p-3 text-center">النسبة المئوية %</th>
                    <th className="p-3 text-center">التقدير العام</th>
                    <th className="p-3">ملاحظات المعلمة</th>
                    <th className="p-3 text-center">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-indigo-500/10 font-medium">
                  {displayExams.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-10 text-center text-slate-400 italic">
                        {searchQuery
                          ? `لا توجد اختبارات مطابقة لبحثك "${searchQuery}"`
                          : "لا توجد امتحانات مسجلة لهذا الطالب حتى الآن. اضغط على '➕ رصد امتحان جديد' للبدء."}
                      </td>
                    </tr>
                  ) : (
                    displayExams.map((exam, idx) => {
                      const pct = exam.percentage;
                      return (
                        <tr
                          key={exam.id || idx}
                          className="hover:bg-amber-500/5 transition-colors"
                        >
                          <td className="p-3 font-mono text-slate-400 text-center">{idx + 1}</td>
                          <td className="p-3 font-bold text-slate-100 flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-amber-400/80"></span>
                            <span>{exam.examTitle}</span>
                          </td>
                          <td className="p-3 font-mono text-slate-300 text-center">{exam.date}</td>
                          <td className="p-3 font-mono font-bold text-slate-200 text-center">
                            <span className="text-amber-300">{exam.score}</span>
                            <span className="text-slate-500 text-[11px] mx-1">/</span>
                            <span className="text-slate-400">{exam.maxScore}</span>
                          </td>
                          <td className="p-3 text-center">
                            <span
                              className={`font-black font-mono px-2.5 py-1 rounded-xl text-xs inline-block ${
                                pct >= 85
                                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                  : pct >= 65
                                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                                  : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                              }`}
                            >
                              {pct}%
                            </span>
                          </td>
                          <td className="p-3 text-center">
                            <span className="text-xs font-bold text-slate-300">
                              {pct >= 90
                                ? "ممتاز 🌟"
                                : pct >= 75
                                ? "جيد جداً 👍"
                                : pct >= 60
                                ? "جيد"
                                : "يحتاج تركيز ⚠️"}
                            </span>
                          </td>
                          <td className="p-3 text-slate-400 text-[11px] max-w-[200px] truncate">
                            {exam.notes || <span className="text-slate-600">-</span>}
                          </td>
                          <td className="p-3 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleOpenEditForm(exam)}
                                className="p-1.5 rounded-xl bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/30 cursor-pointer transition-all"
                                title="تعديل هذا الامتحان"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeletingExamId(exam.id)}
                                className="p-1.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 cursor-pointer transition-all"
                                title="حذف هذا الامتحان"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
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

        {/* Footer */}
        <div className="p-4 md:px-6 border-t border-indigo-500/20 bg-slate-950/60 flex items-center justify-between text-xs text-slate-400">
          <span>
            سجل الاختبارات والنتائج الأكاديمية • مسجل حالياً{" "}
            <strong className="text-amber-300 font-mono">{examsList.length}</strong> امتحان
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold transition-all cursor-pointer"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
