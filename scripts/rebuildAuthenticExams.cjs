const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc } = require('firebase/firestore');

const url = 'https://lzdvmzumwuqycwdecaan.supabase.co';
const key = 'sb_publishable_B2ATdO71x3VxvOL18ATZtA_bupiDf3l';
const sb = createClient(url, key);

function isTeacherEntry(notes) {
  if (!notes) return false;
  if (notes.includes('النسخة الاحتياطية')) return false;
  return notes.includes('رصد درجة') || notes.includes('تعديل') || notes.includes('alsaied');
}

async function run() {
  console.log('1. Fetching students from Supabase...');
  let allStudents = [];
  let from = 0;
  while (true) {
    const { data } = await sb.from('students').select('*').range(from, from + 999);
    if (!data || data.length === 0) break;
    allStudents = allStudents.concat(data);
    from += 1000;
    if (data.length < 1000) break;
  }
  const idToBarcode = new Map();
  allStudents.forEach(s => idToBarcode.set(s.id, String(s.barcode).trim()));
  console.log(`Found ${allStudents.length} students in Supabase.`);

  console.log('2. Fetching all homework/exam records from Supabase...');
  let allHw = [];
  from = 0;
  while (true) {
    const { data } = await sb.from('homework').select('*').order('created_at', { ascending: true }).range(from, from + 999);
    if (!data || data.length === 0) break;
    allHw = allHw.concat(data);
    from += 1000;
    if (data.length < 1000) break;
  }
  console.log(`Fetched ${allHw.length} homework/exam records.`);

  console.log('3. Grouping and deduplicating exams with teacher priority...');
  const studentExams = new Map();
  allHw.forEach(h => {
    const b = idToBarcode.get(h.student_id);
    if (!b || h.score === null || h.score === undefined) return;
    if (!studentExams.has(b)) studentExams.set(b, new Map());
    const examMap = studentExams.get(b);

    const title = (h.title || 'امتحان').trim();
    const isDirect = isTeacherEntry(h.notes);
    const prev = examMap.get(title);

    const score = Number(h.score);
    const maxScore = Number(h.max_score) || (score <= 10 ? 10 : score <= 15 ? 15 : score <= 20 ? 20 : 100);
    const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : score;
    const date = h.date_key || (h.created_at ? h.created_at.slice(0, 10) : '2026-09-08');

    const record = {
      id: h.id,
      examTitle: title,
      date,
      score,
      maxScore,
      percentage,
      notes: h.notes || undefined,
      createdAt: h.created_at,
      isDirect,
    };

    if (!prev) {
      examMap.set(title, record);
    } else {
      if (isDirect && !prev.isDirect) {
        // Teacher direct entry always wins over bulk backup import
        examMap.set(title, record);
      } else if (!isDirect && prev.isDirect) {
        // Keep the direct teacher entry!
      } else {
        // Both same quality: latest timestamp wins
        if (new Date(h.created_at) >= new Date(prev.createdAt)) {
          examMap.set(title, record);
        }
      }
    }
  });

  console.log(`Processed authentic exams for ${studentExams.size} students.`);

  // 4. Update data/center_live_state.json
  const livePath = 'data/center_live_state.json';
  if (fs.existsSync(livePath)) {
    const liveState = JSON.parse(fs.readFileSync(livePath, 'utf8'));
    let matchedCount = 0;
    liveState.students = (liveState.students || []).map(s => {
      const b = String(s.barcode).trim();
      const examMap = studentExams.get(b);
      if (!examMap || examMap.size === 0) {
        return {
          ...s,
          examHistory: [],
          totalExamScores: [],
          lastExamTitle: undefined,
          lastExamScore: undefined,
        };
      }

      const sortedExams = Array.from(examMap.values()).sort((a, b) => {
        const dDiff = a.date.localeCompare(b.date);
        if (dDiff !== 0) return dDiff;
        return a.createdAt.localeCompare(b.createdAt);
      });

      const cleanHistory = sortedExams.map(({ isDirect, createdAt, ...rest }) => rest);
      const scores = cleanHistory.map(e => e.percentage);
      const last = cleanHistory[cleanHistory.length - 1];

      matchedCount++;
      return {
        ...s,
        examHistory: cleanHistory,
        totalExamScores: scores,
        lastExamTitle: last.examTitle,
        lastExamScore: `${last.score}/${last.maxScore} (${last.percentage}%)`,
      };
    });

    liveState.updatedAt = Date.now();
    liveState._lastClientTimestamp = Date.now();
    fs.writeFileSync(livePath, JSON.stringify(liveState, null, 2), 'utf8');
    console.log(`Updated ${matchedCount} students in ${livePath}.`);

    // 5. Sync to Firestore system_state/main_center_data
    try {
      const zlib = require('zlib');
      const firebaseConfig = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8'));
      const app = initializeApp(firebaseConfig);
      const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
      const jsonStr = JSON.stringify(liveState);
      const compressed = 'GZIP:' + zlib.gzipSync(Buffer.from(jsonStr, 'utf8')).toString('base64');
      
      const docRef = doc(db, 'system_state', 'main_center_data');
      await setDoc(docRef, {
        _compressedPayload: compressed,
        studentsCount: liveState.students.length,
        updatedAt: liveState.updatedAt,
        _lastClientId: 'authentic_rebuild_script',
        syncedAtIso: new Date().toISOString(),
      }, { merge: true });
      console.log('Successfully synced authentic student exam records to Firestore system_state/main_center_data!');
    } catch (fsErr) {
      console.warn('Firestore sync note in script:', fsErr.message);
    }
  }

  console.log('Done rebuilding authentic exams!');
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal error in rebuildAuthenticExams:', err);
  process.exit(1);
});
