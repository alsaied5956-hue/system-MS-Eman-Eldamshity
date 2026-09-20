import { generateCode128Svg, generateCode128DataUrl } from "../src/utils/barcode128";
import {
  parseGroupTimeToMinutes,
  evaluateAttendanceStatus,
  getPairedAlternateDateKey,
  cleanPhoneNumber,
  getDefaultGroupDaysForDate,
  getCurrentMonthKey,
  isStudentPaid,
  DEFAULT_GRADE_PRICES,
} from "../src/utils/helpers";
import { compactSystemPayload, hydrateSystemPayload } from "../src/utils/compression";
import { Student } from "../src/types";

interface TestResult {
  name: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, name: string, failureDetails?: string) {
  if (condition) {
    results.push({ name, passed: true });
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    results.push({ name, passed: false, details: failureDetails });
    console.error(`  ❌ [FAIL] ${name} - Details: ${failureDetails || "Assertion failed"}`);
  }
}

console.log("\n=======================================================");
console.log("   🧪 بدء الفحص الشامل واختبار كفاءة المنظومة بنسبة 100%");
console.log("=======================================================\n");

// -----------------------------------------------------------------
// 1. اختبار محرك باركود الليزر (Code-128 1D Barcode Generator)
// -----------------------------------------------------------------
console.log("🔹 1. اختبار محرك باركود الليزر (Code-128 Engine):");
try {
  const sampleBarcode = "1045";
  const svgOutput = generateCode128Svg(sampleBarcode, 40, 2);
  assert(
    typeof svgOutput === "string" && svgOutput.includes("<svg") && svgOutput.includes("<rect"),
    "توليد كود SVG سليم هندسياً لرمز الباركود 1045",
    `المخرجات لا تطابق بنية SVG: ${svgOutput.slice(0, 50)}`
  );

  const dataUrlOutput = generateCode128DataUrl(sampleBarcode);
  assert(
    dataUrlOutput.startsWith("data:image/svg+xml;base64,"),
    "توليد رابط DataURL مشفر بصيغة base64 جاهز للطباعة الفورية",
    "الرابط لا يبدأ بالبادئة القياسية"
  );
} catch (err: any) {
  assert(false, "محرك باركود الليزر فشل أثناء التشغيل", err?.message);
}

// -----------------------------------------------------------------
// 2. اختبار منطق الحضور، التأخير، وفترات السماح (Attendance & Tardiness)
// -----------------------------------------------------------------
console.log("\n🔹 2. اختبار تقييم الحضور والتأخير ومواعيد الحصص (Attendance Timing Logic):");
try {
  // اختبار تحويل الوقت
  const pmMinutes = parseGroupTimeToMinutes("04:00 م");
  assert(pmMinutes === 16 * 60, "تحويل وقت المجموعة '04:00 م' إلى دقائق بدقة (960 دقيقة)", `القيمة الناتجة: ${pmMinutes}`);

  const amMinutes = parseGroupTimeToMinutes("10:30 ص");
  assert(amMinutes === 10 * 60 + 30, "تحويل وقت المجموعة '10:30 ص' إلى دقائق بدقة (630 دقيقة)", `القيمة الناتجة: ${amMinutes}`);

  // اختبار الحضور في الموعد وضمن مهلة السماح (15 دقيقة)
  const baseDateOnTime = new Date(2026, 8, 20, 16, 10); // 4:10 PM (10 mins after 4:00 PM)
  const statusOnTime = evaluateAttendanceStatus(baseDateOnTime, "auto", "04:00 م");
  assert(
    statusOnTime === "حضور",
    "احتساب الطالب واصلاً 'حضور' في الموعد عند الوصول بعد موعده بـ 10 دقائق (ضمن مهلة الـ 15 دقيقة)",
    `النتيجة كانت: ${statusOnTime}`
  );

  // اختبار احتساب التأخير بعد انتهاء مهلة السماح (15 دقيقة)
  const baseDateLate = new Date(2026, 8, 20, 16, 25); // 4:25 PM (25 mins after 4:00 PM)
  const statusLate = evaluateAttendanceStatus(baseDateLate, "auto", "04:00 م");
  assert(
    statusLate === "تأخير",
    "احتساب الطالب 'تأخير' فورياً عند الوصول بعد موعده بـ 25 دقيقة (تجاوز مهلة السماح)",
    `النتيجة كانت: ${statusLate}`
  );

  // اختبار الحضور المبكر (قبل الموعد بـ 15 دقيقة)
  const baseDateEarly = new Date(2026, 8, 20, 15, 45); // 3:45 PM
  const statusEarly = evaluateAttendanceStatus(baseDateEarly, "auto", "04:00 م");
  assert(
    statusEarly === "حضور",
    "احتساب الطالب 'حضور' عند الوصول المبكر قبل موعد الحصة",
    `النتيجة كانت: ${statusEarly}`
  );
} catch (err: any) {
  assert(false, "فحص منطق الحضور والتأخير واجه خطأ", err?.message);
}

// -----------------------------------------------------------------
// 3. اختبار دورة أيام التعويض وحماية الطلاب من الغياب الخاطئ (Compensation Exemption)
// -----------------------------------------------------------------
console.log("\n🔹 3. اختبار دورة أيام التعويض التبادلية (Compensation Paired Days):");
try {
  const saturdayDate = "2026-09-19"; // Saturday
  const sundayAlt = getPairedAlternateDateKey(saturdayDate);
  assert(
    sundayAlt === "2026-09-20",
    "تحديد الأحد (2026-09-20) كاليوم البديل التبادلي لحصة السبت (2026-09-19)",
    `النتيجة كانت: ${sundayAlt}`
  );

  const sundayDate = "2026-09-20"; // Sunday
  const satAlt = getPairedAlternateDateKey(sundayDate);
  assert(
    satAlt === "2026-09-19",
    "تحديد السبت كاليوم البديل التبادلي لحصة الأحد",
    `النتيجة كانت: ${satAlt}`
  );

  const monDate = "2026-09-21"; // Monday
  const tueAlt = getPairedAlternateDateKey(monDate);
  assert(
    tueAlt === "2026-09-22",
    "تحديد الثلاثاء كاليوم البديل التبادلي لحصة الإثنين",
    `النتيجة كانت: ${tueAlt}`
  );
} catch (err: any) {
  assert(false, "فحص دورة أيام التعويض واجه خطأ", err?.message);
}

// -----------------------------------------------------------------
// 4. اختبار تنظيف وتوحيد أرقام الهواتف المصرية والواتساب (Phone Normalizer)
// -----------------------------------------------------------------
console.log("\n🔹 4. اختبار معالجة وتدقيق أرقام الهواتف للواتساب (WhatsApp Phone Normalization):");
try {
  const p1 = cleanPhoneNumber("01012345678");
  assert(p1 === "201012345678", "تحويل 01012345678 إلى الصيغة الدولية القياسية للواتساب 201012345678", `النتيجة: ${p1}`);

  const p2 = cleanPhoneNumber("+20 11 2345 6789");
  assert(p2 === "201123456789", "معالجة كود الدولة +20 والمسافات وتحويله لصيغة 2011 القياسية للواتساب", `النتيجة: ${p2}`);

  const p3 = cleanPhoneNumber("٠١٢٣٤٥٦٧٨٩٠");
  assert(p3 === "201234567890", "تحويل الأرقام المكتوبة بالرسم الهندي/العربي (٠١٢..) إلى أرقام لاتينية صحيحة مع بادئة الواتساب", `النتيجة: ${p3}`);
} catch (err: any) {
  assert(false, "فحص تنظيف أرقام الهواتف واجه خطأ", err?.message);
}

// -----------------------------------------------------------------
// 5. اختبار هيكلة البيانات، الضغط، وفك الضغط دون فقد أي حقل (Data Compression Integrity)
// -----------------------------------------------------------------
console.log("\n🔹 5. اختبار حزم وضغط وفك ضغط البيانات بدون فقدان (Payload Compression & Hydration):");
try {
  const mockStudents: Student[] = [
    {
      barcode: "1001",
      name: "زياد أحمد محمود",
      phone: "01011112222",
      parentPhone: "01033334444",
      groupGrade: "الصف الأول الإعدادي",
      groupDays: "سبت - إثنين - أربعاء",
      groupTime: "04:00 م",
      customMonthlyFee: 80,
      points: 25,
      totalAttendanceDays: 12,
      totalAbsentDays: 1,
      totalExamScores: [20, 19, 20],
      createdAt: new Date().toISOString(),
    },
  ];

  const compacted = compactSystemPayload({
    students: mockStudents,
    attendanceToday: { "1001": "حضور" },
    attendanceTodayDate: "2026-09-20",
    attendanceHistory: { "2026-09-18": { "1001": "حضور" } },
    payments: {},
    scanLogTimes: { "1001": new Date().toISOString() },
    scanLogOrder: ["1001"],
    usersList: [],
    groupPrices: DEFAULT_GRADE_PRICES,
    activeSessionSlotId: "auto",
    platformMessages: [],
  });

  const hydrated = hydrateSystemPayload<any>(compacted);
  const hydratedStudent = hydrated.students?.[0];

  assert(
    hydratedStudent &&
      hydratedStudent.barcode === "1001" &&
      hydratedStudent.name === "زياد أحمد محمود" &&
      hydratedStudent.groupTime === "04:00 م" &&
      hydratedStudent.customMonthlyFee === 80,
    "الحفاظ الكامل على بيانات الطالب (الاسم، الباركود، موعد المجموعة، المصروفات المخصصة) بعد الضغط وفك الضغط",
    `البيانات المستعادة: ${JSON.stringify(hydratedStudent)}`
  );
} catch (err: any) {
  assert(false, "فحص حزم وضغط البيانات واجه خطأ", err?.message);
}

// -----------------------------------------------------------------
// 6. اختبار مدفوعات الطلاب وتحديد حالة السداد (Financial & Payments)
// -----------------------------------------------------------------
console.log("\n🔹 6. اختبار نظام الاشتراكات والمدفوعات (Payments & Billing):");
try {
  const monthKey = getCurrentMonthKey();
  const mockPaymentsMonth = {
    "1001": {
      amount: 100,
      paidAt: new Date().toISOString(),
      receivedBy: "eman",
      month: monthKey,
    },
  };

  const isPaid1001 = isStudentPaid(mockPaymentsMonth as any, "1001");
  const isPaid1002 = isStudentPaid(mockPaymentsMonth as any, "1002");

  assert(isPaid1001 === true, "التعرف الصحيح على الطالب المسدد للاشتراك الشهري (1001)", `النتيجة: ${isPaid1001}`);
  assert(isPaid1002 === false, "التعرف الصحيح على الطالب غير المسدد (1002)", `النتيجة: ${isPaid1002}`);
} catch (err: any) {
  assert(false, "فحص نظام المدفوعات واجه خطأ", err?.message);
}

// -----------------------------------------------------------------
// طباعة التقرير النهائي للاختبار
// -----------------------------------------------------------------
console.log("\n=======================================================");
const totalPassed = results.filter((r) => r.passed).length;
const totalFailed = results.filter((r) => !r.passed).length;
console.log(`📊 النتيجة النهائية للاختبار: ${totalPassed} نجاح من أصل ${results.length} فحص.`);

if (totalFailed === 0) {
  console.log("🎉 جميع الاختبارات البرمجية والتشغيلية نجحت بنسبة 100%! المنظومة مستقرة تماماً وجاهزة للعمل الفعلي.");
} else {
  console.error(`⚠️ يوجد ${totalFailed} فحص غير مكتمل.`);
  process.exit(1);
}
console.log("=======================================================\n");
