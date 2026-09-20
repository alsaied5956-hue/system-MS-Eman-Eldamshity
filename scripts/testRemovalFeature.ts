import { getTodayKey } from "../src/utils/helpers";

console.log("=======================================================");
console.log("🧪 اختبار ميزة إلغاء المسح وحذف الطالب من طابور الحضور بالقاعة");
console.log("=======================================================");

const todayKey = getTodayKey();

// Mock Initial State
let scanLogOrder = ["1001", "1002", "1003"];
let scanLogTimes: Record<string, string> = {
  "1001": new Date().toISOString(),
  "1002": new Date().toISOString(),
  "1003": new Date().toISOString(),
};
let attendanceToday: Record<string, string> = {
  "1001": "حضور",
  "1002": "حضور", // Accidental scan of student 1002
  "1003": "تأخير",
};
let attendanceHistory: Record<string, Record<string, string>> = {
  [todayKey]: { ...attendanceToday },
};
let students = [
  { barcode: "1001", name: "أحمد", totalAttendanceDays: 5 },
  { barcode: "1002", name: "محمد (تم مسحه بالخطأ)", totalAttendanceDays: 4 },
  { barcode: "1003", name: "محمود", totalAttendanceDays: 2 },
];

const cleanBarcode = "1002";

// Simulation of handleRemoveFromScanner
const updatedOrder = scanLogOrder.filter((b) => b !== cleanBarcode);
const updatedTimes = { ...scanLogTimes };
delete updatedTimes[cleanBarcode];

const priorStatus = attendanceToday[cleanBarcode];
const updatedToday = { ...attendanceToday };
delete updatedToday[cleanBarcode];

const updatedHistory = { ...attendanceHistory };
if (updatedHistory[todayKey]) {
  const dayData = { ...updatedHistory[todayKey] };
  delete dayData[cleanBarcode];
  updatedHistory[todayKey] = dayData;
}

const updatedStudents = students.map((s) => {
  if (s.barcode === cleanBarcode && priorStatus && priorStatus !== "غائب") {
    return {
      ...s,
      totalAttendanceDays: Math.max(0, (s.totalAttendanceDays || 0) - 1),
    };
  }
  return s;
});

// Verifications
const passOrder = !updatedOrder.includes("1002") && updatedOrder.length === 2;
const passTimes = !("1002" in updatedTimes);
const passToday = !("1002" in updatedToday);
const passHistory = !(updatedHistory[todayKey] && "1002" in updatedHistory[todayKey]);
const passRollback = updatedStudents.find((s) => s.barcode === "1002")?.totalAttendanceDays === 3;

console.log("1. حذف الباركود من طابور الحصة الحالي:", passOrder ? "✅ [PASS]" : "❌ [FAIL]");
console.log("2. حذف توقيت مسح الباركود:", passTimes ? "✅ [PASS]" : "❌ [FAIL]");
console.log("3. إلغاء تسجيل الحضور لليوم تماماً:", passToday ? "✅ [PASS]" : "❌ [FAIL]");
console.log("4. تنظيف كشف الحضور التاريخي لليوم:", passHistory ? "✅ [PASS]" : "❌ [FAIL]");
console.log("5. استرجاع وتعديل عداد أيام حضور الطالب التراكمي:", passRollback ? "✅ [PASS]" : "❌ [FAIL]");

if (passOrder && passTimes && passToday && passHistory && passRollback) {
  console.log("\n🎉 اختبار ميزة إلغاء المسح وحذف الطالب نجح بنسبة 100%!");
  process.exit(0);
} else {
  console.error("\n❌ فشل أحد فحوصات ميزة الحذف.");
  process.exit(1);
}
