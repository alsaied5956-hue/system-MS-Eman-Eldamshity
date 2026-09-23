const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { initializeApp, getApps } = require('firebase/app');
const { getFirestore, doc, setDoc } = require('firebase/firestore');

async function syncToFirestore() {
  const livePath = path.join(__dirname, '..', 'data', 'center_live_state.json');
  const liveData = JSON.parse(fs.readFileSync(livePath, 'utf-8'));

  const configPath = path.join(__dirname, '..', 'firebase-applet-config.json');
  const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
  const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

  const jsonStr = JSON.stringify(liveData);
  const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf-8'));
  const compressedString = 'GZIP:' + compressed.toString('base64');

  const nowTime = Date.now();
  const docRef = doc(db, 'system_state', 'main_center_data');

  await setDoc(docRef, {
    _compressedPayload: compressedString,
    studentsCount: liveData.students.length,
    paymentsCount: Object.values(liveData.payments || {}).reduce((acc, m) => acc + Object.keys(m || {}).length, 0),
    updatedAt: nowTime,
    scanLogUpdatedAt: nowTime,
    _lastClientId: 'teacher_master_reset',
    _lastClientTimestamp: nowTime,
    syncedAtIso: new Date().toISOString(),
    attendanceWipedAt: liveData.attendanceWipedAt || nowTime,
  }, { merge: true });

  console.log('✅ Successfully pushed clean state to Firestore cloud!');
  process.exit(0);
}

syncToFirestore().catch((err) => {
  console.error(err);
  process.exit(1);
});
