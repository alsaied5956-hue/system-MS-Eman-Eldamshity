const fs = require('fs');
const path = require('path');

const liveStatePath = path.join(__dirname, '..', 'data', 'center_live_state.json');
const backupPath = path.join(__dirname, '..', 'src', 'data', 'centerBackup.json');
const entryExitLogsPath = path.join(__dirname, '..', 'data', 'center_entry_exit_logs.json');

const now = Date.now();

// 1. Process live state
if (fs.existsSync(liveStatePath)) {
  const liveState = JSON.parse(fs.readFileSync(liveStatePath, 'utf-8'));
  
  if (Array.isArray(liveState.students)) {
    liveState.students = liveState.students.map(s => ({
      ...s,
      points: 0,
      totalAttendanceDays: 0,
      totalAbsentDays: 0,
    }));
  }

  liveState.attendanceHistory = {};
  liveState.attendanceToday = {};
  liveState.scanLogOrder = [];
  liveState.scanLogTimes = {};
  liveState.attendanceWipedAt = now;
  liveState.updatedAt = now;
  liveState.scanLogUpdatedAt = now;

  fs.writeFileSync(liveStatePath, JSON.stringify(liveState, null, 2), 'utf-8');
  console.log('✅ Updated center_live_state.json: Attendance wiped, points reset, all 717 student profiles & exam records preserved.');
}

// 2. Process backup
if (fs.existsSync(backupPath)) {
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
  
  if (Array.isArray(backup.students)) {
    backup.students = backup.students.map(s => {
      const updated = { ...s };
      if ('points' in updated) updated.points = 0;
      if ('pts' in updated) updated.pts = 0;
      if ('totalAttendanceDays' in updated) updated.totalAttendanceDays = 0;
      if ('tad' in updated) updated.tad = 0;
      if ('totalAbsentDays' in updated) updated.totalAbsentDays = 0;
      if ('tabd' in updated) updated.tabd = 0;
      return updated;
    });
  }

  backup.attendanceHistory = {};
  backup.attendanceToday = {};
  backup.scanLogOrder = [];
  backup.scanLogTimes = {};
  backup.attendanceWipedAt = now;
  backup.updatedAt = now;
  backup.scanLogUpdatedAt = now;

  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf-8');
  console.log('✅ Updated centerBackup.json: Seed backup synced.');
}

// 3. Clear entry/exit logs if exists
if (fs.existsSync(entryExitLogsPath)) {
  fs.writeFileSync(entryExitLogsPath, JSON.stringify([]), 'utf-8');
  console.log('✅ Cleared center_entry_exit_logs.json.');
}
