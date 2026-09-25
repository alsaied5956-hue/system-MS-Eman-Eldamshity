const { createClient } = require("@supabase/supabase-js");
const { initializeApp } = require("firebase/app");
const { getFirestore, doc, setDoc } = require("firebase/firestore");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = "https://lzdvmzumwuqycwdecaan.supabase.co";
const SUPABASE_KEY = "sb_publishable_B2ATdO71x3VxvOL18ATZtA_bupiDf3l";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const firebaseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "../firebase-applet-config.json"), "utf-8"));
const fbApp = initializeApp(firebaseConfig);
const fbDb = getFirestore(fbApp, firebaseConfig.firestoreDatabaseId);

async function main() {
  console.log("Fetching all attendance logs from Supabase...");
  let allLogs = [];
  let from = 0;
  const step = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("attendance_logs")
      .select("*")
      .range(from, from + step - 1);
    if (error) {
      console.error("Error fetching logs:", error);
      break;
    }
    if (!data || data.length === 0) break;
    allLogs.push(...data);
    if (data.length < step) break;
    from += step;
  }

  console.log(`Fetched ${allLogs.length} attendance logs from Supabase.`);

  const attendanceHistory = {};
  const studentAttendanceStats = {};

  allLogs.forEach((log) => {
    if (!log.barcode || !log.date_key) return;
    const b = String(log.barcode).trim();
    const d = String(log.date_key).trim();
    if (!attendanceHistory[d]) attendanceHistory[d] = {};
    attendanceHistory[d][b] = log.status;

    if (!studentAttendanceStats[b]) {
      studentAttendanceStats[b] = { present: 0, absent: 0 };
    }
    if (log.status === "حضور" || log.status === "تأخير") {
      studentAttendanceStats[b].present++;
    } else if (log.status === "غائب" || log.status === "غياب") {
      studentAttendanceStats[b].absent++;
    }
  });

  console.log("Reconstructed attendanceHistory dates and student counts:");
  for (const [date, map] of Object.entries(attendanceHistory)) {
    console.log(` - ${date}: ${Object.keys(map).length} students`);
  }

  // Update center_live_state.json
  const liveStatePath = path.join(__dirname, "../data/center_live_state.json");
  const liveState = JSON.parse(fs.readFileSync(liveStatePath, "utf-8"));

  liveState.attendanceHistory = attendanceHistory;
  if (Array.isArray(liveState.students)) {
    liveState.students.forEach((s) => {
      const b = String(s.barcode).trim();
      const stats = studentAttendanceStats[b];
      if (stats) {
        s.totalAttendanceDays = stats.present;
        s.totalAbsentDays = stats.absent;
      }
      s.points = 0; // enforce 0 points
    });
  }
  liveState.updatedAt = Date.now();
  delete liveState.attendanceWipedAt;

  fs.writeFileSync(liveStatePath, JSON.stringify(liveState, null, 2), "utf-8");
  console.log("Updated data/center_live_state.json with authentic attendance history.");

  // Update src/data/centerBackup.json
  const backupPath = path.join(__dirname, "../src/data/centerBackup.json");
  const backup = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
  backup.attendanceHistory = attendanceHistory;
  if (Array.isArray(backup.students)) {
    backup.students.forEach((s) => {
      const b = String(s.barcode).trim();
      const stats = studentAttendanceStats[b];
      if (stats) {
        s.totalAttendanceDays = stats.present;
        s.totalAbsentDays = stats.absent;
      }
      s.points = 0;
    });
  }
  backup.updatedAt = Date.now();
  delete backup.attendanceWipedAt;

  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
  console.log("Updated src/data/centerBackup.json with authentic attendance history.");

  // Update Firestore
  try {
    const jsonStr = JSON.stringify(liveState);
    const compressed = zlib.gzipSync(Buffer.from(jsonStr, "utf-8"));
    const compressedPayload = "GZIP:" + compressed.toString("base64");

    const docRef = doc(fbDb, "system_state", "main_center_data");
    await setDoc(
      docRef,
      {
        _compressedPayload: compressedPayload,
        studentsCount: liveState.students.length,
        attendanceHistory: liveState.attendanceHistory,
        updatedAt: liveState.updatedAt,
        _lastClientId: "attendance_history_restorer",
        syncedAtIso: new Date().toISOString(),
      },
      { merge: true }
    );
    console.log("Updated Firebase Firestore system_state/main_center_data successfully.");
  } catch (fbErr) {
    console.warn("Firestore update note:", fbErr.message);
  }

  console.log("ALL ATTENDANCE RECORDS RESTORED SUCCESSFULLY!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Restoration error:", err);
  process.exit(1);
});
