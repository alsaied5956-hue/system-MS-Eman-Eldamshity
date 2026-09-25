import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Student,
  StudentExamRecord,
  PaymentRecord,
  UserAccount,
  GradeName,
  GroupDays,
  TabType,
  PendingWhatsAppMessage,
  PlatformMessage,
} from "./types";
import {
  loadInitialData,
  saveStudentsData,
  saveAttendanceTodayData,
  saveAttendanceAndStudentsBatch,
  saveAttendanceHistoryData,
  saveAttendanceDeletedKey,
  saveClearSessionScansForGrade,
  saveScanLogData,
  savePaymentsData,
  saveGroupPricesData,
  saveUsersData,
  savePendingWhatsAppMessages,
  saveSingleGradeWhatsAppLink,
  markWhatsAppMessageSent,
  markAllWhatsAppMessagesSent,
  deletePendingWhatsAppMessage,
  clearAllPendingWhatsAppMessages,
  subscribeToCloudData,
  subscribeToSyncStatus,
  flushPendingSyncToCloud,
  forceCloudFullRefresh,
  getSyncStatus,
  clearAllSystemData,
  loadLocalData,
  syncDataToCloud,
  saveToLocalStorage,
  purgeTombstoneBarcode,
  autoPushLocalDiskOnStartup,
  pullLatestCloudDataImmediately,
  hydrateFromIndexedDB,
  SyncStatus,
  checkIsLocalServerHubAvailable,
} from "./utils/storage";
import {
  getTodayKey,
  getCurrentMonthKey,
  formatArabicDate,
  formatTimeArabic,
  isStudentPaid,
  getPairedAlternateDateKey,
  checkStudentCompensationForDate,
} from "./utils/helpers";
import {
  subscribeToGroupFinished,
  subscribeToPaymentChanges,
  subscribeToStudentChanges,
  subscribeToExamGradeChanges,
  subscribeToLiveScans,
  subscribeToMultiDevicePing,
  broadcastMultiDevicePong,
  fetchFullDirectoryFromSupabase,
} from "./utils/supabaseClient";
import {
  subscribeToFirebaseLiveScans,
  subscribeToFirebasePayments,
  subscribeToFirebaseGroups,
  subscribeToFirebaseAttendanceStatus,
  subscribeToFirebaseDeletions,
  RealtimeDeletionPayload,
} from "./utils/firebaseRealtime";
import { getPersistentDeviceId, getPersistentDeviceName } from "./utils/deviceClient";
import {
  dualSyncLiveScan,
  dualSyncGroupFinished,
  dualSyncAttendanceStatusChange,
  dualSyncPaymentRecord,
  dualSyncPaymentUpdate,
  dualSyncPaymentDelete,
  dualSyncExamGrade,
  dualSyncStudentSave,
  dualSyncStudentDelete,
  dualSyncAttendanceDelete,
  dualSyncBulkStudents,
} from "./utils/dualSync";
import { useGlobalRealtimeSync } from "./hooks/useGlobalRealtimeSync";
import {
  cloudAddStudent,
  cloudUpdateStudent,
  cloudDeleteStudent,
  cloudBulkImportStudents,
  cloudRecordAttendance,
  cloudFinishGroupAttendance,
  cloudChangeAttendanceStatus,
  cloudDeleteAttendance,
  cloudRecordPayment,
  cloudUpdatePayment,
  cloudDeletePayment,
  cloudRecordExamGrade,
  cloudUpdateGroupPrices,
  cloudUpdateUsers,
  cloudFetchSystemConfigs,
} from "./services/supabaseMutationService";
import { Navbar } from "./components/Navbar";
import { Sidebar } from "./components/Sidebar";
import { AttendanceScanner } from "./components/AttendanceScanner";
import { AddStudentTab } from "./components/AddStudentTab";
import { DailyAttendanceReport } from "./components/DailyAttendanceReport";
import { CumulativeGradesReport } from "./components/CumulativeGradesReport";
import { PayExpensesTab } from "./components/PayExpensesTab";
import { FinancialsTab } from "./components/FinancialsTab";
import { ExamGradesTab } from "./components/ExamGradesTab";
import { EarlyWarningTab } from "./components/EarlyWarningTab";
import { CertificatesTab } from "./components/CertificatesTab";
import { ExcelIntegrationTab } from "./components/ExcelIntegrationTab";
import { PlatformMessagingTab } from "./components/PlatformMessagingTab";
import { WhatsAppDirectTab } from "./components/WhatsAppDirectTab";
import { ManageStudentsTab } from "./components/ManageStudentsTab";
import { UsersTab } from "./components/UsersTab";
import { SettingsTab } from "./components/SettingsTab";
import { AuthOverlay } from "./components/AuthOverlay";
import { PrintPDFModal } from "./components/PrintPDFModal";
import { PrintCardsModal } from "./components/PrintCardsModal";
import { PendingWhatsAppOutboxModal } from "./components/PendingWhatsAppOutboxModal";
import { MultiDeviceSyncModal } from "./components/MultiDeviceSyncModal";
import { BulkHomeworkModal } from "./components/BulkHomeworkModal";
import { HomeworkTrackerTab } from "./components/HomeworkTrackerTab";
import { pushLiveAttendanceEvent, pushLiveAttendanceBatch } from "./utils/liveEventStream";
import { CheckCircle2, WifiOff, RefreshCw, X, MessageSquare, Send } from "lucide-react";

export default function App() {
  // Strict Session-Only Authentication Persistence (Force Re-login on App Restart)
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(() => {
    if (typeof window !== "undefined") {
      try {
        // Clean any legacy persistent keys from localStorage
        localStorage.removeItem("center_current_user");
        const saved = sessionStorage.getItem("center_current_user");
        if (saved) {
          const u = JSON.parse(saved);
          if (u && u.username) return u;
        }
      } catch {}
    }
    return null;
  });
  const [activeTab, setActiveTab] = useState<TabType>("attendance-scan");
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    isOnline: true,
    isSyncing: false,
    hasPendingSync: false,
    lastSyncTime: null,
  });
  const [syncBanner, setSyncBanner] = useState<{
    show: boolean;
    type: "online-synced" | "offline-mode";
    message: string;
  } | null>(null);

  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return window.innerWidth >= 1024;
    }
    return true;
  });

  // Dedicated per-tab isolated scroll positions
  const mainScrollRef = useRef<HTMLElement>(null);
  const tabScrollPositions = useRef<Record<string, number>>({});

  // Tab switcher that saves scroll position and preserves sidebar state
  const handleSelectTab = useCallback((tab: TabType) => {
    if (mainScrollRef.current) {
      tabScrollPositions.current[activeTab] = mainScrollRef.current.scrollTop;
    }
    setActiveTab(tab);
    if (mainScrollRef.current) {
      mainScrollRef.current.scrollTop = tabScrollPositions.current[tab] || 0;
    }
  }, [activeTab]);

  const [activeSessionSlotId, setActiveSessionSlotId] = useState<string>("auto");
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(true);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("app_theme");
      if (saved === "light" || saved === "dark") return saved;
    }
    return "dark";
  });
  const [isCardsModalOpen, setIsCardsModalOpen] = useState(false);
  const [isMultiDeviceSyncModalOpen, setIsMultiDeviceSyncModalOpen] = useState(false);
  const [isBulkHomeworkModalOpen, setIsBulkHomeworkModalOpen] = useState(false);

  // Sync theme to root DOM and localStorage
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", theme);
      document.body.setAttribute("data-theme", theme);
      if (theme === "light") {
        document.documentElement.classList.remove("dark");
        document.documentElement.classList.add("light");
        document.body.classList.remove("dark");
        document.body.classList.add("light");
      } else {
        document.documentElement.classList.remove("light");
        document.documentElement.classList.add("dark");
        document.body.classList.remove("light");
        document.body.classList.add("dark");
      }
      localStorage.setItem("app_theme", theme);
    }
  }, [theme]);

  // Core Datasets with guaranteed initial default arrays/objects loaded immediately on 0ms first render
  const [students, setStudents] = useState<Student[]>(() => loadInitialData().students || []);
  const [attendanceToday, setAttendanceToday] = useState<Record<string, string>>(() => loadInitialData().attendanceToday || {});
  const [attendanceHistory, setAttendanceHistory] = useState<Record<string, Record<string, string>>>(() => loadInitialData().attendanceHistory || {});
  const [scanLogOrder, setScanLogOrder] = useState<string[]>(() => loadInitialData().scanLogOrder || []);
  const [scanLogTimes, setScanLogTimes] = useState<Record<string, string>>(() => loadInitialData().scanLogTimes || {});
  const [payments, setPayments] = useState<Record<string, Record<string, PaymentRecord>>>(() => loadInitialData().payments || {});
  const [groupPrices, setGroupPrices] = useState<Record<GradeName, number>>(() => loadInitialData().groupPrices || ({} as Record<GradeName, number>));
  const [usersList, setUsersList] = useState<UserAccount[]>(() => loadInitialData().usersList || []);
  const [platformMessages, setPlatformMessages] = useState<PlatformMessage[]>(() => loadInitialData().platformMessages || []);
  const [pendingWhatsAppMessages, setPendingWhatsAppMessages] = useState<PendingWhatsAppMessage[]>(() => loadInitialData().pendingWhatsAppMessages || []);
  const [gradeWhatsAppLinks, setGradeWhatsAppLinks] = useState<Record<string, string>>(() => loadInitialData().gradeWhatsAppLinks || {});
  const [isWhatsAppOutboxOpen, setIsWhatsAppOutboxOpen] = useState<boolean>(false);

  // Print PDF Modal State
  const [printModal, setPrintModal] = useState<{
    open: boolean;
    type: "attendance" | "exams" | "all" | "unpaid";
    targetDate?: string;
    targetAttendanceMap?: Record<string, string>;
  }>({
    open: false,
    type: "all",
  });

  // 1. Initial Local Data Load (Instant Speed 0ms) + Guaranteed Auto-Push of Local Disk Data to Cloud
  useEffect(() => {
    const data = loadInitialData();
    if (data) {
      setStudents(data.students || []);
      setAttendanceToday(data.attendanceToday || {});
      setAttendanceHistory(data.attendanceHistory || {});
      setScanLogOrder(data.scanLogOrder || []);
      setScanLogTimes(data.scanLogTimes || {});
      setPayments(data.payments || {});
      setGroupPrices(data.groupPrices || ({} as Record<GradeName, number>));
      setUsersList(data.usersList || []);
      setPlatformMessages(data.platformMessages || []);
      setPendingWhatsAppMessages(data.pendingWhatsAppMessages || []);
      setGradeWhatsAppLinks(data.gradeWhatsAppLinks || {});
      if (data.activeSessionSlotId) {
        setActiveSessionSlotId(data.activeSessionSlotId);
      }
    }

    // Restore full historical snapshot from IndexedDB if localStorage was capped by quota
    hydrateFromIndexedDB().catch(() => {});

    // 1. Fetch authoritative student directory, today's attendance, and payments from Supabase
    fetchFullDirectoryFromSupabase().then((res) => {
      if (res && Array.isArray(res.students)) {
        // Authoritative student list directly from Supabase - no stale cache resurrection
        const authoritativeList = res.students as Student[];
        setStudents(authoritativeList);
        appStudentsRef.current = authoritativeList;
        // Save authoritative students locally without overwriting the cloud with stale local attendance
        saveStudentsData(authoritativeList);

        if (res.attendanceToday && Object.keys(res.attendanceToday).length > 0) {
          setAttendanceToday((prev) => {
            const next = { ...prev, ...res.attendanceToday };
            attendanceTodayRef.current = next;
            return next;
          });
        }

        if (res.payments && Object.keys(res.payments).length > 0) {
          setPayments((prev) => {
            const nextPayments = { ...prev };
            for (const [m, recs] of Object.entries(res.payments)) {
              nextPayments[m] = { ...(nextPayments[m] || {}), ...recs };
            }
            paymentsRef.current = nextPayments;
            return nextPayments;
          });
        }

        if (res.attendanceHistory && Object.keys(res.attendanceHistory).length > 0) {
          const today = getTodayKey();
          const cleanHistory = { ...res.attendanceHistory };
          for (const d of Object.keys(cleanHistory)) {
            if (d > today) delete cleanHistory[d];
          }
          setAttendanceHistory(cleanHistory);
          attendanceHistoryRef.current = cleanHistory;
        }

        if (res.groupPrices && Object.keys(res.groupPrices).length > 0) {
          setGroupPrices(res.groupPrices as any);
        }

        if (res.usersList && res.usersList.length > 0) {
          setUsersList(res.usersList);
        }
      }
    }).catch(() => {});

    // Fetch authoritative system configs (groupPrices, usersList) from Supabase
    cloudFetchSystemConfigs().then((configs) => {
      if (configs.groupPrices && Object.keys(configs.groupPrices).length > 0) {
        setGroupPrices(configs.groupPrices);
      }
      if (configs.usersList && configs.usersList.length > 0) {
        setUsersList(configs.usersList);
      }
    }).catch(() => {});

    // 2. Immediately pull latest cloud state if device was turned off/offline
    pullLatestCloudDataImmediately().catch(() => {});
    // 3. Automatically send whatever was saved on local disk to Cloud if pending
    autoPushLocalDiskOnStartup().catch(() => {});
  }, []);

  // 2. Subscribe to sync status & offline/online events
  useEffect(() => {
    const unsubscribeSync = subscribeToSyncStatus((status) => {
      setSyncStatus(status);
    });

    const handleSyncCompleted = (e?: Event) => {
      const customEvent = e as CustomEvent<any>;
      const isWiped = customEvent?.detail?.wipedLocalStorage;
      setSyncBanner({
        show: true,
        type: "online-synced",
        message: isWiped
          ? "☁️ تم حفظ وتسجيل كافة التعديلات على السحابة (Firebase) ومسح الذاكرة المحلية للجهاز بنجاح!"
          : "تم الاتصال بالسحابة وتأكيد حفظ البيانات بنجاح!",
      });
      setTimeout(() => {
        setSyncBanner(null);
      }, 5000);
    };

    const handleOffline = () => {
      setSyncBanner({
        show: true,
        type: "offline-mode",
        message: "⚠️ أنت الآن في وضع الأوفلاين (بدون نت) - يتم الحفظ مؤقتاً على الذاكرة المحلية، وسيتم رفع التعديلات للسحابة ومسحها فور عودة الإنترنت.",
      });
    };

    const handleOnline = () => {
      setSyncBanner({
        show: true,
        type: "online-synced",
        message: "⚡ تم استعادة الاتصال بالإنترنت - جاري رفع التعديلات فوراً للسحابة ومسحها من الذاكرة المحلية...",
      });
    };

    const handleQueueUpdated = () => {
      const local = loadInitialData();
      setPendingWhatsAppMessages(local.pendingWhatsAppMessages || []);
    };

    const handlePlatformMessagesUpdated = () => {
      const local = loadInitialData();
      setPlatformMessages(local.platformMessages || []);
    };

    window.addEventListener("cloud-sync-completed", handleSyncCompleted);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    window.addEventListener("whatsapp-queue-updated", handleQueueUpdated);
    window.addEventListener("platform-messages-updated", handlePlatformMessagesUpdated);

    return () => {
      unsubscribeSync();
      window.removeEventListener("cloud-sync-completed", handleSyncCompleted);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("whatsapp-queue-updated", handleQueueUpdated);
      window.removeEventListener("platform-messages-updated", handlePlatformMessagesUpdated);
    };
  }, []);

  // 3. Real-time Firebase Sync in background
  useEffect(() => {
    const unsubscribe = subscribeToCloudData(
      (cloudData) => {
        if (cloudData) {
          if (Array.isArray(cloudData.students)) {
            const localDel = new Set((loadLocalData().deletedBarcodes || []).map((b) => String(b).trim()));
            const remoteDel = new Set((cloudData.deletedBarcodes || []).map((b) => String(b).trim()));
            const allDel = new Set([...localDel, ...remoteDel]);

            setStudents((prev) => {
              // Never resurrect deleted students
              const cleanPrev = prev.filter((s) => !allDel.has(String(s.barcode).trim()));
              const prevBarcodes = new Set(cleanPrev.map((s) => String(s.barcode).trim()));

              // Only accept cloud students if not deleted and not already existing
              const toAdd = cloudData.students!.filter(
                (cs) => cs && cs.barcode && !allDel.has(String(cs.barcode).trim()) && !prevBarcodes.has(String(cs.barcode).trim())
              );

              if (toAdd.length === 0 && cleanPrev.length === prev.length) {
                return prev;
              }
              const next = [...cleanPrev, ...toAdd];
              appStudentsRef.current = next;
              return next;
            });
          }
          if (cloudData.attendanceToday) {
            setAttendanceToday((prev) => {
              const merged = { ...cloudData.attendanceToday, ...prev };
              for (const [b, st] of Object.entries(cloudData.attendanceToday!)) {
                if (st === "حضور" || st === "تأخير") merged[b] = st;
              }
              attendanceTodayRef.current = merged;
              return merged;
            });
          }
          if (cloudData.attendanceHistory) {
            setAttendanceHistory((prev) => {
              const merged = { ...prev };
              for (const [dKey, dayMap] of Object.entries(cloudData.attendanceHistory!)) {
                merged[dKey] = { ...(merged[dKey] || {}), ...(dayMap || {}) };
              }
              attendanceHistoryRef.current = merged;
              return merged;
            });
          }
          if (Array.isArray(cloudData.scanLogOrder)) {
            setScanLogOrder((prev) => {
              const combined = Array.from(new Set([...cloudData.scanLogOrder!, ...prev]));
              scanLogOrderRef.current = combined;
              return combined;
            });
          }
          if (cloudData.scanLogTimes) {
            setScanLogTimes((prev) => {
              const combined = { ...(cloudData.scanLogTimes || {}), ...prev };
              scanLogTimesRef.current = combined;
              return combined;
            });
          }
          if (cloudData.payments) setPayments(cloudData.payments);
          if (cloudData.groupPrices) setGroupPrices(cloudData.groupPrices);
          if (cloudData.usersList) setUsersList(cloudData.usersList);
          if (cloudData.platformMessages) setPlatformMessages(cloudData.platformMessages);
          if (cloudData.pendingWhatsAppMessages) setPendingWhatsAppMessages(cloudData.pendingWhatsAppMessages);
          if (cloudData.gradeWhatsAppLinks) setGradeWhatsAppLinks(cloudData.gradeWhatsAppLinks);
          if (cloudData.activeSessionSlotId) setActiveSessionSlotId(cloudData.activeSessionSlotId);
        }
      },
      () => {
        // Ignored in offline fallback
      }
    );

    const handleLocalBroadcast = (e: Event) => {
      const customEvent = e as CustomEvent<any>;
      if (customEvent.detail) {
        // Prevent infinite re-render loop on mutations initiated within the same window
        if (customEvent.detail._originLocal) {
          return;
        }
        const d = customEvent.detail;
        if (Array.isArray(d.students)) {
          const localDel = new Set((loadLocalData().deletedBarcodes || []).map((b) => String(b).trim()));
          const remoteDel = new Set((d.deletedBarcodes || []).map((b) => String(b).trim()));
          const allDel = new Set([...localDel, ...remoteDel]);

          setStudents((prev) => {
            const cleanPrev = prev.filter((s) => !allDel.has(String(s.barcode).trim()));
            const prevMap = new Map<string, Student>();
            cleanPrev.forEach((s) => prevMap.set(String(s.barcode).trim(), s));

            d.students.forEach((remoteS: any) => {
              if (!remoteS || !remoteS.barcode) return;
              const cleanB = String(remoteS.barcode).trim();
              if (allDel.has(cleanB)) return;
              const existing = prevMap.get(cleanB);
              if (!existing) {
                prevMap.set(cleanB, remoteS);
              } else {
                // Merge student details so edits to existing students propagate seamlessly
                prevMap.set(cleanB, {
                  ...existing,
                  ...remoteS,
                  totalExamScores: (remoteS.totalExamScores?.length || 0) >= (existing.totalExamScores?.length || 0)
                    ? remoteS.totalExamScores
                    : existing.totalExamScores,
                  examHistory: (remoteS.examHistory?.length || 0) >= (existing.examHistory?.length || 0)
                    ? remoteS.examHistory
                    : existing.examHistory,
                });
              }
            });

            const next = Array.from(prevMap.values());
            appStudentsRef.current = next;
            return next;
          });
        }
        if (d.attendanceToday) {
          setAttendanceToday((prev) => {
            const merged = { ...d.attendanceToday, ...prev };
            for (const [b, st] of Object.entries(d.attendanceToday)) {
              if (st === "حضور" || st === "تأخير") merged[b] = st as string;
            }
            attendanceTodayRef.current = merged;
            return merged;
          });
        }
        if (d.attendanceHistory) {
          setAttendanceHistory((prev) => {
            const merged = { ...prev };
            for (const [dKey, dayMap] of Object.entries(d.attendanceHistory)) {
              merged[dKey] = { ...(merged[dKey] || {}), ...(dayMap as any || {}) };
            }
            attendanceHistoryRef.current = merged;
            return merged;
          });
        }
        if (Array.isArray(d.scanLogOrder)) {
          setScanLogOrder((prev) => {
            const combined = Array.from(new Set([...d.scanLogOrder, ...prev]));
            scanLogOrderRef.current = combined;
            return combined;
          });
        }
        if (d.scanLogTimes) {
          setScanLogTimes((prev) => {
            const combined = { ...(d.scanLogTimes || {}), ...prev };
            scanLogTimesRef.current = combined;
            return combined;
          });
        }
        if (d.payments) setPayments(d.payments);
        if (d.groupPrices) setGroupPrices(d.groupPrices);
        if (d.usersList) setUsersList(d.usersList);
        if (d.platformMessages) setPlatformMessages(d.platformMessages);
        if (d.pendingWhatsAppMessages) setPendingWhatsAppMessages(d.pendingWhatsAppMessages);
        if (d.gradeWhatsAppLinks) setGradeWhatsAppLinks(d.gradeWhatsAppLinks);
        if (d.activeSessionSlotId) setActiveSessionSlotId(d.activeSessionSlotId);
      }
    };

    window.addEventListener("center-data-updated", handleLocalBroadcast);

    return () => {
      unsubscribe();
      window.removeEventListener("center-data-updated", handleLocalBroadcast);
    };
  }, []);

  // Manual Trigger for Cloud Sync
  const handleManualSync = async () => {
    const result = await forceCloudFullRefresh();
    if (result.success) {
      setSyncBanner({
        show: true,
        type: "online-synced",
        message: result.message,
      });
      setTimeout(() => setSyncBanner(null), 4000);
    } else {
      setSyncBanner({
        show: true,
        type: "offline-mode",
        message: result.message,
      });
      setTimeout(() => setSyncBanner(null), 6000);
    }
  };

  // Synchronous references for rock-solid concurrency during high-speed scanning (100 students / 5 min)
  const appStudentsRef = useRef(students);
  appStudentsRef.current = students;
  const attendanceTodayRef = useRef(attendanceToday);
  attendanceTodayRef.current = attendanceToday;
  const attendanceHistoryRef = useRef(attendanceHistory);
  attendanceHistoryRef.current = attendanceHistory;
  const scanLogOrderRef = useRef(scanLogOrder);
  scanLogOrderRef.current = scanLogOrder;
  const scanLogTimesRef = useRef(scanLogTimes);
  scanLogTimesRef.current = scanLogTimes;
  const paymentsRef = useRef(payments);
  paymentsRef.current = payments;

  // ⚡ Universal Supabase Realtime CDC Mirroring Engine: Listens to all Postgres changes
  const handleRealtimeSyncNotice = useCallback((notice: { message: string; type?: "online-synced" | "offline-mode" }) => {
    setSyncBanner({
      show: true,
      type: notice.type || "online-synced",
      message: notice.message,
    });
    setTimeout(() => setSyncBanner(null), 4500);
  }, []);

  const globalRealtimeStatus = useGlobalRealtimeSync({
    setStudents,
    appStudentsRef,
    setAttendanceToday,
    attendanceTodayRef,
    setAttendanceHistory,
    attendanceHistoryRef,
    setScanLogOrder,
    scanLogOrderRef,
    setScanLogTimes,
    scanLogTimesRef,
    setPayments,
    paymentsRef,
    setGroupPrices,
    setUsersList,
    onSyncNotice: handleRealtimeSyncNotice,
  });

  // ⚡ Central Supabase Realtime Hub: Listen to Group Finalization, Payments, and Students across all devices (<20ms)
  useEffect(() => {
    // Deduplication tracker across Supabase WebSocket & Firebase Realtime Database
    const recentHandledEvents = new Map<string, number>();
    const isRecentlyProcessed = (key: string, windowMs: number = 2500): boolean => {
      const now = Date.now();
      const last = recentHandledEvents.get(key);
      if (last && now - last < windowMs) return true;
      recentHandledEvents.set(key, now);
      return false;
    };

    const handleIncomingGroupFinished = (payload: any) => {
      if (payload.sourceDeviceId && payload.sourceDeviceId === currentDevId) return;
      const dedupeKey = `group_${payload.dateKey}_${payload.grade}_${payload.days}`;
      if (isRecentlyProcessed(dedupeKey)) return;

      setSyncBanner({
        show: true,
        type: "online-synced",
        message: `⚡ تم إنهاء وتثبيت حضور مجموعة (${payload.grade} - ${payload.days}) بواسطة (${payload.finishedBy || "الماسح"})!`,
      });
      setTimeout(() => setSyncBanner(null), 5000);

      const todayKey = getTodayKey();
      if (payload.dateKey === todayKey) {
        setAttendanceToday((prev) => {
          const next = { ...prev };
          payload.absentBarcodes.forEach((b: string) => (next[b] = "غائب"));
          payload.lateBarcodes.forEach((b: string) => (next[b] = "تأخير"));
          payload.presentBarcodes.forEach((b: string) => (next[b] = "حضور"));
          attendanceTodayRef.current = next;
          return next;
        });
      }

      setAttendanceHistory((prev) => {
        const dayMap = { ...(prev[payload.dateKey] || {}) };
        payload.absentBarcodes.forEach((b: string) => (dayMap[b] = "غائب"));
        payload.lateBarcodes.forEach((b: string) => (dayMap[b] = "تأخير"));
        payload.presentBarcodes.forEach((b: string) => (dayMap[b] = "حضور"));
        const nextHist = { ...prev, [payload.dateKey]: dayMap };
        attendanceHistoryRef.current = nextHist;
        return nextHist;
      });
    };

    const unsubGroup = subscribeToGroupFinished(handleIncomingGroupFinished);
    const unsubFbGroup = subscribeToFirebaseGroups(handleIncomingGroupFinished);

    const handleIncomingPaymentChange = (payload: any) => {
      if (payload.sourceDeviceId && payload.sourceDeviceId === currentDevId) return;
      const dedupeKey = `pay_${payload.monthKey}_${payload.barcode}_${payload.action}`;
      if (isRecentlyProcessed(dedupeKey)) return;

      setSyncBanner({
        show: true,
        type: "online-synced",
        message: `⚡ تحديث مالي فوري: تم ${payload.action === "delete" ? "حذف سداد" : "تسجيل سداد"} شهر (${payload.monthKey}) للطالب (${payload.barcode})!`,
      });
      setTimeout(() => setSyncBanner(null), 4000);

      setPayments((prev) => {
        const updated = { ...prev };
        if (payload.action === "delete") {
          if (updated[payload.monthKey]) {
            const m = { ...updated[payload.monthKey] };
            delete m[payload.barcode];
            updated[payload.monthKey] = m;
          }
        } else {
          const m = { ...(updated[payload.monthKey] || {}) };
          m[payload.barcode] = {
            barcode: payload.barcode,
            month: payload.monthKey,
            monthKey: payload.monthKey,
            amount: payload.amount,
            date: payload.date,
            time: payload.time,
            note: payload.note,
            recordedBy: payload.recordedBy,
          };
          updated[payload.monthKey] = m;
        }
        paymentsRef.current = updated;
        savePaymentsData(updated);
        return updated;
      });
    };

    const unsubPayment = subscribeToPaymentChanges(handleIncomingPaymentChange);
    const unsubFbPayment = subscribeToFirebasePayments(handleIncomingPaymentChange);

    const unsubStudent = subscribeToStudentChanges((payload) => {
      if (payload.action === "add" && payload.studentData) {
        setStudents((prev) => {
          if (prev.some((s) => s.barcode === payload.barcode)) return prev;
          const next = [payload.studentData, ...prev];
          appStudentsRef.current = next;
          saveStudentsData(next);
          return next;
        });
      } else if (payload.action === "update" && payload.studentData) {
        setStudents((prev) => {
          const next = prev.map((s) => (s.barcode === payload.barcode ? payload.studentData : s));
          appStudentsRef.current = next;
          saveStudentsData(next);
          return next;
        });
      } else if (payload.action === "delete") {
        setStudents((prev) => {
          const next = prev.filter((s) => s.barcode !== payload.barcode);
          appStudentsRef.current = next;
          saveStudentsData(next, payload.barcode);
          return next;
        });
      }
    });

    const unsubExamGrade = subscribeToExamGradeChanges((payload) => {
      setStudents((prev) => {
        const next = prev.map((s) => {
          if (s.barcode === payload.barcode) {
            const pct = payload.percentage;
            const scoreFormatted = `${payload.score}/${payload.maxScore} (${pct}%)`;
            const pointsBonus = pct === 100 ? 20 : pct >= 90 ? 10 : pct >= 75 ? 5 : 0;
            
            const newExamRec = {
              id: `exam_${s.barcode}_${Date.now()}`,
              examTitle: payload.examTitle,
              date: payload.dateKey || getTodayKey(),
              score: payload.score,
              maxScore: payload.maxScore,
              percentage: pct,
            };
            const currentHistory = Array.isArray(s.examHistory) ? [...s.examHistory] : [];
            const existingIdx = currentHistory.findIndex((e) => e.examTitle === payload.examTitle);
            if (existingIdx >= 0) {
              currentHistory[existingIdx] = newExamRec;
            } else {
              currentHistory.push(newExamRec);
            }
            const scores = currentHistory.map((e) => e.percentage);

            return {
              ...s,
              lastExamTitle: payload.examTitle,
              lastExamScore: scoreFormatted,
              totalExamScores: scores,
              examHistory: currentHistory,
              points: 0,
            };
          }
          return s;
        });
        appStudentsRef.current = next;
        return next;
      });
    });

    const currentDevId = getPersistentDeviceId();
    const currentDevName = getPersistentDeviceName();

    // ⚡ Instant Multi-Device Live Scan Reception (Dual Supabase WebSocket + Firebase RTDB)
    const handleIncomingLiveScan = (payload: any) => {
      if (payload.sourceDeviceId && payload.sourceDeviceId === currentDevId) {
        return;
      }

      const b = String(payload.barcode).trim();
      const dedupeKey = `scan_${b}_${payload.status}`;
      if (isRecentlyProcessed(dedupeKey)) {
        return;
      }

      const status = payload.status === "تأخير" ? "تأخير" : "حضور";
      const timeIso = payload.timeIso || new Date().toISOString();
      const dateKey = getTodayKey();

      setAttendanceToday((prev) => {
        const next = { ...prev, [b]: status };
        attendanceTodayRef.current = next;
        return next;
      });
      setAttendanceHistory((prev) => {
        const dayMap = { ...(prev[dateKey] || {}) };
        dayMap[b] = status;
        const next = { ...prev, [dateKey]: dayMap };
        attendanceHistoryRef.current = next;
        return next;
      });
      setScanLogOrder((prev) => (prev.includes(b) ? prev : [b, ...prev]));
      setScanLogTimes((prev) => ({ ...prev, [b]: timeIso }));

      setStudents((prev) => {
        const next = prev.map((s) => {
          if (s.barcode === b) {
            return {
              ...s,
              totalAttendanceDays: (s.totalAttendanceDays || 0) + 1,
            };
          }
          return s;
        });
        appStudentsRef.current = next;
        return next;
      });

      // Persist to local storage so subsequent scans from this device already include this scan
      try {
        const local = loadLocalData();
        const updatedLocal = {
          ...local,
          attendanceToday: { ...(local.attendanceToday || {}), [b]: status },
          attendanceHistory: {
            ...(local.attendanceHistory || {}),
            [dateKey]: { ...((local.attendanceHistory || {})[dateKey] || {}), [b]: status },
          },
          scanLogOrder: (local.scanLogOrder || []).includes(b) ? local.scanLogOrder : [b, ...(local.scanLogOrder || [])],
          scanLogTimes: { ...(local.scanLogTimes || {}), [b]: timeIso },
        };
        saveToLocalStorage(updatedLocal, false);
      } catch {}

      setSyncBanner({
        show: true,
        type: "online-synced",
        message: `⚡ مسح لحظي من (${payload.scannedBy || "جهاز مساعد"}): تم تسجيل ${status} للطالب (${payload.name}) في تمام (${payload.timeDisplay || "الآن"})!`,
      });
      setTimeout(() => setSyncBanner(null), 4500);
    };

    const unsubLiveScan = subscribeToLiveScans(handleIncomingLiveScan);
    const unsubFbLiveScan = subscribeToFirebaseLiveScans(handleIncomingLiveScan);

    const unsubFbAttendanceStatus = subscribeToFirebaseAttendanceStatus((payload) => {
      if (payload.sourceDeviceId && payload.sourceDeviceId === currentDevId) return;
      const b = String(payload.barcode).trim();
      const st = payload.status === "تأخير" ? "تأخير" : payload.status === "حضور" ? "حضور" : "غياب";
      setAttendanceToday((prev) => {
        const next = { ...prev, [b]: st };
        attendanceTodayRef.current = next;
        return next;
      });
      if (payload.dateKey) {
        setAttendanceHistory((prev) => {
          const dayMap = { ...(prev[payload.dateKey] || {}) };
          dayMap[b] = st === "غياب" ? "غائب" : st;
          const next = { ...prev, [payload.dateKey]: dayMap };
          attendanceHistoryRef.current = next;
          return next;
        });
      }
    });

    // ⚡ Real-Time Cross-Device Record Deletion Listener (Firebase Realtime Database)
    // Instantly removes deleted Students, Payments, and Attendance records from DOM/State without page refresh
    const handleIncomingFirebaseDeletion = (payload: RealtimeDeletionPayload) => {
      if (payload.sourceDeviceId && payload.sourceDeviceId === currentDevId) return;
      const b = String(payload.barcode).trim();
      const dedupeKey = `del_${payload.type}_${b}_${payload.monthKey || ""}_${payload.dateKey || ""}`;
      if (isRecentlyProcessed(dedupeKey)) return;

      if (payload.type === "student") {
        setStudents((prev) => {
          const next = prev.filter((s) => String(s.barcode).trim() !== b);
          appStudentsRef.current = next;
          saveStudentsData(next, b);
          return next;
        });
        setAttendanceToday((prev) => {
          if (!prev[b]) return prev;
          const next = { ...prev };
          delete next[b];
          attendanceTodayRef.current = next;
          return next;
        });
        setScanLogOrder((prev) => prev.filter((code) => code !== b));
        setSyncBanner({
          show: true,
          type: "online-synced",
          message: `🗑️ مزامنة فورية: تم حذف الطالب (${b}) من جهاز آخر!`,
        });
        setTimeout(() => setSyncBanner(null), 4000);
      } else if (payload.type === "payment" && payload.monthKey) {
        setPayments((prev) => {
          if (!prev[payload.monthKey!] || !prev[payload.monthKey!][b]) return prev;
          const updated = { ...prev };
          const m = { ...updated[payload.monthKey!] };
          delete m[b];
          updated[payload.monthKey!] = m;
          paymentsRef.current = updated;
          savePaymentsData(updated, `${payload.monthKey}_${b}`);
          return updated;
        });
        setSyncBanner({
          show: true,
          type: "online-synced",
          message: `🗑️ مزامنة فورية: تم حذف سداد شهر (${payload.monthKey}) للطالب (${b}) من جهاز آخر!`,
        });
        setTimeout(() => setSyncBanner(null), 4000);
      } else if (payload.type === "attendance") {
        const dKey = payload.dateKey || getTodayKey();
        setAttendanceToday((prev) => {
          if (!prev[b]) return prev;
          const next = { ...prev };
          delete next[b];
          attendanceTodayRef.current = next;
          return next;
        });
        setAttendanceHistory((prev) => {
          if (!prev[dKey] || !prev[dKey][b]) return prev;
          const next = { ...prev };
          const dayMap = { ...next[dKey] };
          delete dayMap[b];
          next[dKey] = dayMap;
          attendanceHistoryRef.current = next;
          return next;
        });
        setScanLogOrder((prev) => prev.filter((code) => code !== b));
        saveAttendanceDeletedKey(b, dKey);
        setSyncBanner({
          show: true,
          type: "online-synced",
          message: `🗑️ مزامنة فورية: تم حذف تسجيل الحضور للطالب (${b}) من جهاز آخر!`,
        });
        setTimeout(() => setSyncBanner(null), 4000);
      }
    };

    const unsubFbDeletion = subscribeToFirebaseDeletions(handleIncomingFirebaseDeletion);

    // ⚡ Local & SSE Record Deletion Bridge
    const onRealtimeRecordDeleted = (e: Event) => {
      const customEvent = e as CustomEvent<any>;
      if (customEvent.detail) {
        const d = customEvent.detail;
        handleIncomingFirebaseDeletion({
          type: (d.recordType || d.type) as any,
          barcode: d.barcode,
          monthKey: d.monthKey,
          dateKey: d.dateKey,
          id: d.id,
          sourceDeviceId: d.sourceDeviceId,
          timestamp: d.timestamp || Date.now(),
        });
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("realtime-record-deleted", onRealtimeRecordDeleted);
    }

    // ⚡ Multi-Device Diagnostic Ping Responder
    const unsubPing = subscribeToMultiDevicePing((payload) => {
      if (payload.sourceDeviceId && payload.sourceDeviceId !== currentDevId) {
        broadcastMultiDevicePong({
          pingId: payload.pingId,
          targetDeviceId: payload.sourceDeviceId,
          responderDeviceId: currentDevId,
          responderDeviceName: currentDevName,
          timestamp: Date.now(),
        });
      }
    });

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("realtime-record-deleted", onRealtimeRecordDeleted);
      }
      unsubGroup();
      unsubFbGroup();
      unsubPayment();
      unsubFbPayment();
      unsubStudent();
      unsubExamGrade();
      unsubLiveScan();
      unsubFbLiveScan();
      unsubFbAttendanceStatus();
      unsubFbDeletion();
      unsubPing();
    };
  }, []);

  // Handler: Scan Attendance Record with strict Cloud-First commit and 0ms race-condition-free ref updates
  const handleRecordAttendance = useCallback(async (
    barcode: string,
    status: "حضور" | "تأخير",
    timeIso: string,
    student: Student
  ) => {
    const cleanBarcode = String(barcode).trim();
    if (!cleanBarcode) return;

    const todayKey = getTodayKey();

    try {
      // 1. Check prior status before updating state
      const priorStatus = attendanceTodayRef.current[cleanBarcode];
      const fullStudent =
        (appStudentsRef.current || students).find(
          (s) => String(s.barcode).trim() === cleanBarcode
        ) || student;

      // 2. Optimistic UI Update: Immediately update state in 0ms (zero input lag)
      if (!scanLogOrderRef.current.includes(cleanBarcode)) {
        scanLogOrderRef.current = [cleanBarcode, ...scanLogOrderRef.current];
      }
      scanLogTimesRef.current = {
        ...scanLogTimesRef.current,
        [cleanBarcode]: timeIso,
      };
      attendanceTodayRef.current = {
        ...attendanceTodayRef.current,
        [cleanBarcode]: status,
      };
      attendanceHistoryRef.current = {
        ...attendanceHistoryRef.current,
        [todayKey]: {
          ...(attendanceHistoryRef.current[todayKey] || {}),
          [cleanBarcode]: status,
        },
      };

      let updatedStudents = appStudentsRef.current;
      
      // Increment attendance days if student was not already marked present today
      if (!priorStatus || priorStatus === "غائب") {
        updatedStudents = appStudentsRef.current.map((s) => {
          if (String(s.barcode).trim() === cleanBarcode) {
            return {
              ...s,
              totalAttendanceDays: (s.totalAttendanceDays || 0) + 1,
            };
          }
          return s;
        });
        appStudentsRef.current = updatedStudents;
        setStudents(updatedStudents);
      }

      // Functional React state updates
      setAttendanceToday((prev) => ({ ...prev, [cleanBarcode]: status }));
      setAttendanceHistory((prev) => ({
        ...prev,
        [todayKey]: {
          ...(prev[todayKey] || {}),
          [cleanBarcode]: status,
        },
      }));
      setScanLogOrder((prev) => (prev.includes(cleanBarcode) ? prev : [cleanBarcode, ...prev]));
      setScanLogTimes((prev) => ({ ...prev, [cleanBarcode]: timeIso }));

      // Dual-Sync to Firebase immediately with sourceDeviceId
      dualSyncLiveScan({
        barcode: cleanBarcode,
        name: fullStudent.name,
        grade: fullStudent.groupGrade,
        days: fullStudent.groupDays,
        status,
        timeIso,
        timeDisplay: new Date(timeIso).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }),
        isPaid: isStudentPaid(payments?.[getCurrentMonthKey()], cleanBarcode),
        scannedBy: currentUser?.username || "الماسح",
        studentFallback: fullStudent,
        sourceDeviceId: getPersistentDeviceId(),
      });

      // Instant local save with batching using authoritative refs
      saveAttendanceAndStudentsBatch(
        attendanceTodayRef.current,
        scanLogOrderRef.current,
        scanLogTimesRef.current,
        updatedStudents,
        false,
        true
      );

      // ⚡ Atomic High-Speed Broadcast to Server Hub (< 2ms) (if local server active)
      if (checkIsLocalServerHubAvailable()) {
        fetch("/api/sync/live-scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            barcode: cleanBarcode,
            status,
            timeIso,
            name: fullStudent?.name || `طالب ${cleanBarcode}`,
            grade: fullStudent?.groupGrade || "",
            days: fullStudent?.groupDays || "",
            scannedBy: currentUser?.username || "الماسح",
            sourceDeviceId: getPersistentDeviceId(),
          }),
        }).catch(() => {});
      }

      // ⚡ Asynchronous Cloud Persistence: non-blocking background write
      cloudRecordAttendance(
        cleanBarcode,
        status,
        timeIso,
        fullStudent?.name || `طالب ${cleanBarcode}`,
        currentUser?.username || "الماسح",
        fullStudent
      ).catch((err) => {
        console.warn("[App] Asynchronous cloud scan error:", err);
      });
    } catch (err: any) {
      console.error("[App] Failed to commit scan attendance:", err);
    }
  }, [payments, currentUser]);

  // Handler: Manual sync for group attendance session in one single operation
  const handleSyncGroupSession = useCallback(async () => {
    return await flushPendingSyncToCloud(true);
  }, []);

  // Handler: Finish and Lock Group Session with optimistic UI update and single parallel bulk commit
  const handleFinishGroup = useCallback(async (
    grade: GradeName,
    days: GroupDays,
    absentList: { student: Student; message: string; type?: "غائب" }[],
    lateList: { student: Student; message: string; type?: "تأخير" }[],
    crossDayList?: { student: Student; message: string; type?: "عكس_أيام" }[]
  ) => {
    // 1️⃣ Live Event Pipeline: Coordinated batch push to `live_events/today` in background
    setTimeout(() => {
      const batchEvents = [
        ...(absentList || []).map((a) => ({
          studentId: a.student.barcode,
          status: "غائب" as const,
          timestamp: Date.now(),
        })),
        ...(lateList || []).map((l) => ({
          studentId: l.student.barcode,
          status: "تأخير" as const,
          timestamp: Date.now(),
        })),
      ];
      if (batchEvents.length > 0) {
        pushLiveAttendanceBatch(batchEvents);
      }
    }, 0);

    const groupStudents = (appStudentsRef.current || students).filter(
      (s) => s.groupGrade === grade && s.groupDays === days
    );

    const absentBarcodesList = (absentList || []).map((a) => String(a.student.barcode).trim());
    const lateBarcodesList = (lateList || []).map((l) => String(l.student.barcode).trim());
    const todayKey = getTodayKey();

    const updatedToday = { ...attendanceTodayRef.current, ...attendanceToday };
    const absentBarcodes = new Set(absentBarcodesList);
    const lateBarcodes = new Set(lateBarcodesList);
    
    // Explicitly update status for EVERY student registered in this group
    groupStudents.forEach((student) => {
      const b = String(student.barcode).trim();
      const priorStatus = attendanceTodayRef.current[b] || attendanceToday[b];

      // حماية طالب التعويض: التحقق إن كان الطالب قد عوض الحصة بالحضور في اليوم البديل (مثلاً السبت بدلاً من الأحد)
      const compCheck = checkStudentCompensationForDate(
        student,
        todayKey,
        attendanceHistoryRef.current,
        attendanceTodayRef.current
      );

      if (compCheck.hasCompensated) {
        // الطالب حضر تعويض في اليوم البديل -> لا يسجل غائب بل يسجل "عوض الحصة"
        updatedToday[b] = "عوض الحصة";
        absentBarcodes.delete(b);
      } else if (absentBarcodes.has(b)) {
        if (priorStatus === "حضور" || priorStatus === "تأخير" || priorStatus === "عوض الحصة" || priorStatus === "معوض") {
          updatedToday[b] = priorStatus;
        } else {
          updatedToday[b] = "غائب";
        }
      } else if (lateBarcodes.has(b)) {
        updatedToday[b] = "تأخير";
      } else {
        updatedToday[b] = priorStatus === "تأخير" ? "تأخير" : (priorStatus === "عوض الحصة" || priorStatus === "معوض" ? "عوض الحصة" : "حضور");
      }
    });

    (crossDayList || []).forEach((item) => {
      const b = String(item.student.barcode).trim();
      updatedToday[b] = attendanceToday[b] === "تأخير" ? "تأخير" : "حضور";
    });

    const presentBarcodesList = groupStudents
      .map((s) => String(s.barcode).trim())
      .filter((b) => updatedToday[b] === "حضور");

    // Include cross-day / compensation students in the official attendance batch
    const crossDayStudents = (crossDayList || []).map((item) => item.student);
    const allSessionStudents = [...groupStudents, ...crossDayStudents];
    const crossDayPresentBarcodes = (crossDayList || [])
      .map((item) => String(item.student.barcode).trim())
      .filter((b) => updatedToday[b] === "حضور");
    const crossDayLateBarcodes = (crossDayList || [])
      .map((item) => String(item.student.barcode).trim())
      .filter((b) => updatedToday[b] === "تأخير");

    const fullPresentBarcodesList = Array.from(new Set([...presentBarcodesList, ...crossDayPresentBarcodes]));
    const fullLateBarcodesList = Array.from(new Set([...lateBarcodesList, ...crossDayLateBarcodes]));

    // ⚡ OPTIMISTIC UI UPDATE:
    // Snapshot current state for rollback if network operation fails
    const prevScanOrder = scanLogOrderRef.current;
    const prevScanTimes = scanLogTimesRef.current;
    const prevToday = attendanceTodayRef.current;
    const prevHistory = attendanceHistoryRef.current;
    const prevStudents = appStudentsRef.current;

    const groupBarcodes = new Set([
      ...groupStudents.map((s) => String(s.barcode).trim()),
      ...(crossDayList || []).map((c) => String(c.student.barcode).trim()),
    ]);
    const clearedScanOrder = (prevScanOrder || []).filter((b) => !groupBarcodes.has(b));

    const updatedHistory = {
      ...attendanceHistory,
      [todayKey]: updatedToday,
    };

    const updatedStudents = (appStudentsRef.current || students).map((s) => {
      const b = String(s.barcode).trim();
      if (absentBarcodes.has(b) && (updatedToday[b] === "غائب" || updatedToday[b] === "غياب")) {
        const wasAbsent = attendanceToday[b] === "غائب" || attendanceToday[b] === "غياب";
        if (!wasAbsent) {
          return {
            ...s,
            totalAbsentDays: (s.totalAbsentDays || 0) + 1,
          };
        }
      }
      return s;
    });

    // Apply state locally in 0ms (Instant Optimistic UI update)
    attendanceTodayRef.current = updatedToday;
    attendanceHistoryRef.current = updatedHistory;
    appStudentsRef.current = updatedStudents;
    scanLogOrderRef.current = clearedScanOrder;

    setAttendanceToday(updatedToday);
    setAttendanceHistory(updatedHistory);
    setStudents(updatedStudents);
    setScanLogOrder(clearedScanOrder);

    saveAttendanceAndStudentsBatch(updatedToday, clearedScanOrder, prevScanTimes, updatedStudents, true);

    try {
      // ⚡ Single Parallel Bulk Database Insertion: save all records in one Supabase call
      await cloudFinishGroupAttendance(
        grade,
        days,
        todayKey,
        absentBarcodesList.filter(b => updatedToday[b] === "غائب"),
        fullLateBarcodesList,
        fullPresentBarcodesList,
        currentUser?.username || "الماسح",
        allSessionStudents
      );

      // Dual-sync in background without blocking
      setTimeout(() => {
        dualSyncGroupFinished({
          grade,
          days,
          absentBarcodes: Array.from(absentBarcodes).filter(b => updatedToday[b] === "غائب"),
          lateBarcodes: fullLateBarcodesList,
          presentBarcodes: fullPresentBarcodesList,
          dateKey: todayKey,
          finishedBy: currentUser?.username || "الماسح",
          allStudents: allSessionStudents,
        });
      }, 0);

      setSyncBanner({
        show: true,
        type: "online-synced",
        message: `⚡ تم تثبيت حضور مجموعة (${grade} - ${days}) في السحابة وتفريغ قائمة الحصة فورياً!`,
      });
      setTimeout(() => setSyncBanner(null), 4000);
    } catch (err: any) {
      console.error("[App] Failed to commit group attendance to cloud, rolling back:", err);
      // Rollback to previous state on failure
      attendanceTodayRef.current = prevToday;
      attendanceHistoryRef.current = prevHistory;
      appStudentsRef.current = prevStudents;
      scanLogOrderRef.current = prevScanOrder;

      setAttendanceToday(prevToday);
      setAttendanceHistory(prevHistory);
      setStudents(prevStudents);
      setScanLogOrder(prevScanOrder);

      saveAttendanceAndStudentsBatch(prevToday, prevScanOrder, prevScanTimes, prevStudents, false);
      throw err;
    }
  }, [attendanceToday, attendanceHistory, scanLogOrder, scanLogTimes, students, currentUser]);

  // Handler: Remove single student from active scanner screen & cancel attendance (e.g. wrong card scanned)
  const handleRemoveFromScanner = useCallback(async (barcode: string) => {
    const cleanBarcode = String(barcode).trim();
    if (!cleanBarcode) return;
    const todayKey = getTodayKey();

    // 1. Compute filtered scan queue & times
    const updatedOrder = (scanLogOrderRef.current || scanLogOrder).filter(
      (b) => String(b).trim() !== cleanBarcode
    );
    const updatedTimes = { ...(scanLogTimesRef.current || scanLogTimes) };
    delete updatedTimes[cleanBarcode];

    // 2. Remove from today's attendance & history
    const priorStatus = attendanceTodayRef.current?.[cleanBarcode] || attendanceToday?.[cleanBarcode];
    const updatedToday = { ...(attendanceTodayRef.current || attendanceToday) };
    delete updatedToday[cleanBarcode];

    const updatedHistory = { ...(attendanceHistoryRef.current || attendanceHistory) };
    if (updatedHistory[todayKey]) {
      const dayData = { ...updatedHistory[todayKey] };
      delete dayData[cleanBarcode];
      updatedHistory[todayKey] = dayData;
    }

    // 3. Rollback totalAttendanceDays if student was recorded as present/late
    let updatedStudents = appStudentsRef.current || students;
    if (priorStatus && priorStatus !== "غائب") {
      updatedStudents = updatedStudents.map((s) => {
        if (String(s.barcode).trim() === cleanBarcode) {
          return {
            ...s,
            totalAttendanceDays: Math.max(0, (s.totalAttendanceDays || 0) - 1),
          };
        }
        return s;
      });
    }

    // 4. Update authoritative refs immediately
    scanLogOrderRef.current = updatedOrder;
    scanLogTimesRef.current = updatedTimes;
    attendanceTodayRef.current = updatedToday;
    attendanceHistoryRef.current = updatedHistory;
    appStudentsRef.current = updatedStudents;

    // 5. Update React state
    setScanLogOrder(updatedOrder);
    setScanLogTimes(updatedTimes);
    setAttendanceToday(updatedToday);
    setAttendanceHistory(updatedHistory);
    setStudents(updatedStudents);

    // 6. Save batch locally & record tombstone
    saveAttendanceDeletedKey(cleanBarcode, todayKey);
    saveAttendanceAndStudentsBatch(updatedToday, updatedOrder, updatedTimes, updatedStudents, false);
    saveScanLogData(updatedOrder, updatedTimes);

    // 7. Cloud persistence & multi-device realtime sync
    try {
      await cloudDeleteAttendance(cleanBarcode, todayKey);
    } catch (err) {
      console.warn("[App] Cloud delete attendance warning:", err);
    }
    dualSyncAttendanceDelete(cleanBarcode, todayKey);

    const targetStudent = updatedStudents.find((s) => String(s.barcode).trim() === cleanBarcode);
    const studentName = targetStudent?.name || `كود ${cleanBarcode}`;

    setSyncBanner({
      show: true,
      type: "online-synced",
      message: `🗑️ تم إلغاء مسح وحذف الطالب (${studentName}) من طابور الحضور اليوم بنجاح!`,
    });
    setTimeout(() => setSyncBanner(null), 4000);
  }, [scanLogOrder, scanLogTimes, attendanceToday, attendanceHistory, students]);

  // Handler: Clear current session scans for a grade with full isolation from previous classes
  const handleClearSessionScans = useCallback((grade: GradeName, resetTodayAttendance = false) => {
    const { updatedToday, remainingScanOrder, remainingScanTimes } = saveClearSessionScansForGrade(
      grade,
      resetTodayAttendance
    );
    setScanLogOrder(remainingScanOrder);
    setScanLogTimes(remainingScanTimes);
    if (resetTodayAttendance) {
      setAttendanceToday(updatedToday);
      const todayKey = getTodayKey();
      setAttendanceHistory((prev) => ({ ...prev, [todayKey]: updatedToday }));
    }
  }, []);

  // Handler: Add Single Student
  const handleAddStudent = useCallback(async (newStudent: Student, cardFee = 0) => {
    const cleanBarcode = String(newStudent.barcode).trim();
    try {
      // 1. Purge any tombstone for this barcode so it is never dropped or blocked
      purgeTombstoneBarcode(cleanBarcode);

      // 2. ⚡ STRICT CLOUD-FIRST: Await Supabase insertion
      const addResult = await cloudAddStudent(newStudent, cardFee, currentUser?.username || "admin");
      const committedStudent = addResult?.student || newStudent;

      // 3. Functional state update to avoid stale closures
      setStudents((prev) => {
        const filtered = prev.filter((s) => String(s.barcode).trim() !== cleanBarcode);
        const updated = [committedStudent, ...filtered];
        appStudentsRef.current = updated;
        saveStudentsData(updated);
        return updated;
      });

      // 4. Dual-Sync for multi-device broadcast
      dualSyncStudentSave(committedStudent, "add");

      if (cardFee > 0) {
        const today = getTodayKey();
        const monthKey = getCurrentMonthKey();
        const newPayment: PaymentRecord = addResult?.payment || {
          barcode: cleanBarcode,
          month: monthKey,
          monthKey,
          amount: cardFee,
          date: today,
          time: formatTimeArabic(),
          note: "رسوم استخراج كارت الباركود الذكي",
          isCardFee: true,
          recordedBy: currentUser?.username || "admin",
        };

        await cloudRecordPayment({
          barcode: cleanBarcode,
          amount: cardFee,
          monthKey,
          date: today,
          note: newPayment.note,
          recordedBy: currentUser?.username || "admin",
          studentFallback: committedStudent,
        });

        setPayments((prev) => {
          const monthData = prev[monthKey] || {};
          const updatedPayments = {
            ...prev,
            [monthKey]: {
              ...monthData,
              [`card_${cleanBarcode}`]: newPayment,
            },
          };
          paymentsRef.current = updatedPayments;
          savePaymentsData(updatedPayments);
          return updatedPayments;
        });

        dualSyncPaymentRecord({
          barcode: cleanBarcode,
          monthKey,
          amount: cardFee,
          date: today,
          time: newPayment.time,
          note: newPayment.note,
          recordedBy: currentUser?.username || "admin",
          studentFallback: committedStudent,
        });
      }
    } catch (err: any) {
      console.error("[App] Failed to add student to cloud:", err);
      alert(`❌ فشل إضافة الطالب في السحابة: ${err?.message || "خطأ غير معروف"}`);
    }
  }, [currentUser]);

  // Handler: Save WhatsApp Group Link per Grade
  const handleSaveGradeWhatsAppLink = useCallback((grade: string, link: string) => {
    setGradeWhatsAppLinks((prev) => ({ ...prev, [grade]: link.trim() }));
    saveSingleGradeWhatsAppLink(grade, link.trim());
  }, []);

  // Handler: Bulk Import Students from Excel
  const handleBulkImport = useCallback(async (newStudentsList: Student[]) => {
    try {
      await cloudBulkImportStudents(newStudentsList);
      const activeBarcodes = new Set(newStudentsList.map((s) => String(s.barcode).trim()));
      newStudentsList.forEach((s) => purgeTombstoneBarcode(s.barcode));

      setStudents((prev) => {
        const filtered = prev.filter((s) => !activeBarcodes.has(String(s.barcode).trim()));
        const updated = [...newStudentsList, ...filtered];
        appStudentsRef.current = updated;
        saveStudentsData(updated);
        return updated;
      });

      dualSyncBulkStudents(newStudentsList);
      setSyncBanner({
        show: true,
        type: "online-synced",
        message: `⚡ تم استيراد وحفظ ${newStudentsList.length} طالب سحابياً بنجاح!`,
      });
      setTimeout(() => setSyncBanner(null), 4000);
    } catch (err: any) {
      console.error("[App] Failed to bulk import students to cloud:", err);
      alert(`❌ فشل استيراد الطلاب سحابياً: ${err?.message || "خطأ غير معروف"}`);
    }
  }, []);

  // Handler: Update Student Info (with full barcode migration)
  const handleUpdateStudent = useCallback(async (oldBarcode: string, updatedStudent: Student) => {
    try {
      await cloudUpdateStudent(oldBarcode, updatedStudent);

      setStudents((prev) => {
        const updated = prev.map((s) => (s.barcode === oldBarcode ? updatedStudent : s));
        appStudentsRef.current = updated;

        if (oldBarcode !== updatedStudent.barcode) {
          // Migrate attendance today
          const newAttToday = { ...attendanceToday };
          if (newAttToday[oldBarcode]) {
            newAttToday[updatedStudent.barcode] = newAttToday[oldBarcode];
            delete newAttToday[oldBarcode];
            setAttendanceToday(newAttToday);
          }

          // Migrate scan log
          const newScanOrder = scanLogOrder.map((b) => (b === oldBarcode ? updatedStudent.barcode : b));
          const newScanTimes = { ...scanLogTimes };
          if (newScanTimes[oldBarcode]) {
            newScanTimes[updatedStudent.barcode] = newScanTimes[oldBarcode];
            delete newScanTimes[oldBarcode];
          }
          setScanLogOrder(newScanOrder);
          setScanLogTimes(newScanTimes);

          saveAttendanceAndStudentsBatch(newAttToday, newScanOrder, newScanTimes, updated);

          dualSyncStudentDelete(oldBarcode);
          dualSyncStudentSave(updatedStudent, "add");
        } else {
          saveStudentsData(updated);
          dualSyncStudentSave(updatedStudent, "update");
        }
        return updated;
      });
    } catch (err: any) {
      console.error("[App] Failed to update student in cloud:", err);
      alert(`❌ فشل تحديث بيانات الطالب في السحابة: ${err?.message || "خطأ غير معروف"}`);
    }
  }, [attendanceToday, scanLogOrder, scanLogTimes]);

  // Handler: Delete Single Student
  const handleDeleteStudent = useCallback(async (barcode: string) => {
    const b = String(barcode).trim();
    const currentList = appStudentsRef.current || [];
    const student = currentList.find((s) => String(s.barcode).trim() === b);
    try {
      // 1. Delete from Supabase PostgreSQL
      await cloudDeleteStudent(b, student?.id);

      // 2. Functional state update
      setStudents((prev) => {
        const updated = prev.filter((s) => String(s.barcode).trim() !== b);
        appStudentsRef.current = updated;
        saveStudentsData(updated, b);
        return updated;
      });

      // 3. Clean up local scans and today's attendance for the deleted student
      setAttendanceToday((prev) => {
        if (!prev[b]) return prev;
        const next = { ...prev };
        delete next[b];
        attendanceTodayRef.current = next;
        return next;
      });
      setScanLogOrder((prev) => prev.filter((code) => code !== b));
      setScanLogTimes((prev) => {
        if (!prev[b]) return prev;
        const next = { ...prev };
        delete next[b];
        scanLogTimesRef.current = next;
        return next;
      });

      // 4. Multi-channel broadcast & tombstone propagation
      dualSyncStudentDelete(b, student?.id);
    } catch (err: any) {
      console.error("[App] Failed to delete student from cloud:", err);
      alert(`❌ فشل حذف الطالب من السحابة: ${err?.message || "خطأ غير معروف"}`);
    }
  }, []);

  // Handler: Clear All Data
  const handleClearAllData = useCallback(() => {
    setStudents([]);
    setAttendanceToday({});
    setScanLogOrder([]);
    setScanLogTimes({});
    clearAllSystemData();
    alert("تم مسح كافة البيانات بنجاح وتحديث السحابة.");
  }, []);

  // Handler: Manual Status Change in Attendance Report or Scanner
  const handleChangeAttendanceStatus = useCallback(async (barcode: string, dateKey: string, newStatus: string) => {
    const todayKey = getTodayKey();
    const isToday = dateKey === todayKey;
    const cleanB = String(barcode).trim();

    if (newStatus === "حذف") {
      if (isToday) {
        await handleRemoveFromScanner(cleanB);
        return;
      } else {
        // Historical date attendance deletion
        const dateMap = { ...(attendanceHistory[dateKey] || {}) };
        const prevStatus = dateMap[cleanB];
        delete dateMap[cleanB];
        const updatedHistory = { ...attendanceHistory, [dateKey]: dateMap };
        setAttendanceHistory(updatedHistory);

        let updatedStudents = students;
        if (prevStatus === "حضور" || prevStatus === "تأخير") {
          updatedStudents = students.map((s) => {
            if (s.barcode === cleanB) {
              return {
                ...s,
                totalAttendanceDays: Math.max(0, (s.totalAttendanceDays || 0) - 1),
              };
            }
            return s;
          });
          setStudents(updatedStudents);
        }

        saveAttendanceDeletedKey(cleanB, dateKey);
        saveAttendanceHistoryData(updatedHistory, updatedStudents);

        try {
          await cloudDeleteAttendance(cleanB, dateKey);
        } catch (err) {
          console.warn("[App] Cloud delete attendance warning:", err);
        }
        dualSyncAttendanceDelete(cleanB, dateKey);
        return;
      }
    }
    
    const prevStatus = isToday ? attendanceToday[barcode] : (attendanceHistory[dateKey]?.[barcode]);
    if (prevStatus === newStatus) return;

    const studentObj = students.find((s) => s.barcode === barcode);

    try {
      // ⚡ Cloud-First: Commit to Supabase attendance_logs
      await cloudChangeAttendanceStatus(
        barcode,
        dateKey,
        newStatus,
        studentObj?.name || `طالب ${barcode}`,
        currentUser?.username || "admin",
        studentObj
      );

      const dateMap = attendanceHistory[dateKey] || {};
      const updatedDateMap = { ...dateMap, [barcode]: newStatus };
      const updatedHistory = { ...attendanceHistory, [dateKey]: updatedDateMap };

      setAttendanceHistory(updatedHistory);

      let updatedToday = attendanceToday;
      if (isToday) {
        updatedToday = { ...attendanceToday, [barcode]: newStatus };
        setAttendanceToday(updatedToday);
      }

      const updatedStudents = students.map((s) => {
        if (s.barcode === barcode) {
          let attCount = s.totalAttendanceDays || 0;
          let absCount = s.totalAbsentDays || 0;

          // Undo previous status count
          if (prevStatus === "حضور" || prevStatus === "تأخير") {
            attCount = Math.max(0, attCount - 1);
          } else if (prevStatus === "غائب" || prevStatus === "غياب") {
            absCount = Math.max(0, absCount - 1);
          }

          // Apply new status count
          if (newStatus === "حضور" || newStatus === "تأخير") {
            attCount += 1;
          } else if (newStatus === "غائب" || newStatus === "غياب") {
            absCount += 1;
          }

          return {
            ...s,
            totalAttendanceDays: attCount,
            totalAbsentDays: absCount,
          };
        }
        return s;
      });

      setStudents(updatedStudents);

      // Save and sync atomically for both today and historical date changes
      if (isToday) {
        saveAttendanceAndStudentsBatch(updatedToday, scanLogOrder, scanLogTimes, updatedStudents, true);
      } else {
        saveAttendanceHistoryData(updatedHistory, updatedStudents);
      }

      dualSyncAttendanceStatusChange({
        barcode,
        studentName: studentObj?.name || `طالب ${barcode}`,
        status: newStatus,
        dateKey,
        updatedBy: currentUser?.username || "admin",
        studentFallback: studentObj,
      });
    } catch (err: any) {
      console.error("[App] Failed to change attendance status in cloud:", err);
      alert(`❌ فشل تعديل حالة الحضور سحابياً: ${err?.message || "خطأ غير معروف"}`);
    }
  }, [attendanceToday, attendanceHistory, scanLogOrder, scanLogTimes, students, currentUser]);

  // Handler: Record Payment
  const handleRecordPayment = useCallback(async (
    barcode: string,
    amount: number,
    monthKey: string,
    note?: string
  ) => {
    const today = getTodayKey();
    const time = formatTimeArabic();
    const noteText = note || `اشتراك شهر ${monthKey}`;
    const studentObj = students.find((s) => s.barcode === barcode);

    try {
      // ⚡ STRICT CLOUD-FIRST: Await Supabase insertion
      await cloudRecordPayment({
        barcode,
        amount,
        monthKey,
        date: today,
        note: noteText,
        recordedBy: currentUser?.username || "admin",
        studentFallback: studentObj,
      });

      const monthData = payments[monthKey] || {};
      const newRecord: PaymentRecord = {
        barcode,
        month: monthKey,
        monthKey,
        amount,
        date: today,
        time,
        note: noteText,
        recordedBy: currentUser?.username || "admin",
      };

      setPayments((prev) => {
        const monthData = prev[monthKey] || {};
        const updatedPayments = {
          ...prev,
          [monthKey]: {
            ...monthData,
            [barcode]: newRecord,
          },
        };
        paymentsRef.current = updatedPayments;
        savePaymentsData(updatedPayments);
        return updatedPayments;
      });

      dualSyncPaymentRecord({
        barcode,
        monthKey,
        amount,
        date: today,
        time,
        note: noteText,
        recordedBy: currentUser?.username || "admin",
        studentFallback: studentObj,
      });
    } catch (err: any) {
      console.error("[App] Failed to record payment in cloud:", err);
      alert(`❌ فشل تسجيل الاشتراك في السحابة: ${err?.message || "خطأ غير معروف"}`);
    }
  }, [currentUser]);

  // Handler: Update / Move Payment (e.g. change month from 8 to 9, or correct amount/notes)
  const handleUpdatePayment = useCallback(async (
    oldMonthKey: string,
    barcode: string,
    newMonthKey: string,
    newAmount: number,
    newNote: string,
    newDate?: string
  ) => {
    const existing = paymentsRef.current[oldMonthKey]?.[barcode];
    const today = getTodayKey();
    const time = formatTimeArabic();
    const finalDate = newDate || existing?.date || today;
    const finalNote = newNote || `اشتراك شهر ${newMonthKey}`;
    const studentObj = appStudentsRef.current?.find((s) => s.barcode === barcode);

    try {
      // ⚡ STRICT CLOUD-FIRST: Await Supabase update
      await cloudUpdatePayment({
        oldMonthKey,
        newMonthKey,
        barcode,
        newAmount,
        newNote: finalNote,
        newDate: finalDate,
        recordedBy: existing?.recordedBy || currentUser?.username || "admin",
        studentFallback: studentObj,
      });

      setPayments((prev) => {
        const updatedPayments = { ...prev };

        // Remove from old month
        if (updatedPayments[oldMonthKey]) {
          const oldMonthMap = { ...updatedPayments[oldMonthKey] };
          delete oldMonthMap[barcode];
          updatedPayments[oldMonthKey] = oldMonthMap;
        }

        // Add to new month
        const newMonthMap = { ...(updatedPayments[newMonthKey] || {}) };
        newMonthMap[barcode] = {
          barcode,
          month: newMonthKey,
          monthKey: newMonthKey,
          amount: newAmount,
          date: finalDate,
          time: existing?.time || time,
          note: finalNote,
          recordedBy: existing?.recordedBy || currentUser?.username || "admin",
          isCardFee: existing?.isCardFee,
        };
        updatedPayments[newMonthKey] = newMonthMap;
        paymentsRef.current = updatedPayments;
        savePaymentsData(updatedPayments);
        return updatedPayments;
      });

      dualSyncPaymentUpdate({
        oldMonthKey,
        newMonthKey,
        barcode,
        newAmount,
        newNote: finalNote,
        newDate: finalDate,
        recordedBy: existing?.recordedBy || currentUser?.username || "admin",
        studentFallback: studentObj,
      });
    } catch (err: any) {
      console.error("[App] Failed to update payment in cloud:", err);
      alert(`❌ فشل تعديل الاشتراك في السحابة: ${err?.message || "خطأ غير معروف"}`);
    }
  }, [currentUser]);

  // Handler: Delete Payment (revert student to unpaid for this month)
  const handleDeletePayment = useCallback(async (monthKey: string, barcode: string) => {
    const existing = paymentsRef.current[monthKey]?.[barcode];
    if (!existing) return;

    try {
      // ⚡ STRICT CLOUD-FIRST: Await Supabase deletion
      await cloudDeletePayment(monthKey, barcode, existing?.id);

      const paymentKey = `${monthKey}_${String(barcode).trim()}`;
      setPayments((prev) => {
        const updatedPayments = { ...prev };
        if (updatedPayments[monthKey]) {
          const monthMap = { ...updatedPayments[monthKey] };
          delete monthMap[barcode];
          updatedPayments[monthKey] = monthMap;
        }
        paymentsRef.current = updatedPayments;
        savePaymentsData(updatedPayments, paymentKey);
        return updatedPayments;
      });

      dualSyncPaymentDelete({
        barcode,
        monthKey,
        paymentId: existing?.id,
      });
    } catch (err: any) {
      console.error("[App] Failed to delete payment from cloud:", err);
      alert(`❌ فشل حذف الاشتراك من السحابة: ${err?.message || "خطأ غير معروف"}`);
    }
  }, []);

  // Handler: Record Exam Grade
  const handleRecordExamGrade = useCallback(async (
    barcode: string,
    examTitle: string,
    score: number,
    maxScore: number
  ) => {
    const pct = Math.round((score / maxScore) * 100);
    const scoreFormatted = `${score}/${maxScore} (${pct}%)`;
    const targetStudent = students.find((s) => s.barcode === barcode);

    try {
      // ⚡ STRICT CLOUD-FIRST: Await Supabase insertion into homework table
      await cloudRecordExamGrade({
        barcode,
        studentName: targetStudent?.name || `طالب ${barcode}`,
        examTitle,
        score,
        maxScore,
        recordedBy: currentUser?.username || "admin",
        studentFallback: targetStudent,
      });

      const updated = students.map((s) => {
        if (s.barcode === barcode) {
          const scores = s.totalExamScores ? [...s.totalExamScores, pct] : [pct];
          const pointsBonus = pct === 100 ? 20 : pct >= 90 ? 10 : pct >= 75 ? 5 : 0;
          const newExamRecord: StudentExamRecord = {
            id: `exam_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            examTitle,
            date: getTodayKey(),
            score,
            maxScore,
            percentage: pct,
          };
          const examHistory = Array.isArray(s.examHistory) && s.examHistory.length > 0
            ? [...s.examHistory, newExamRecord]
            : (s.totalExamScores || []).map((sc, i) => ({
                id: `exam_${s.barcode}_${i + 1}`,
                examTitle: `امتحان دوري ${i + 1}`,
                date: s.createdAt ? s.createdAt.slice(0, 10) : getTodayKey(),
                score: sc,
                maxScore: 100,
                percentage: sc,
                notes: "سجل محفوظ",
              })).concat(newExamRecord);

          return {
            ...s,
            lastExamTitle: examTitle,
            lastExamScore: scoreFormatted,
            totalExamScores: scores,
            examHistory,
            points: 0,
          };
        }
        return s;
      });

      setStudents(updated);
      saveStudentsData(updated);

      dualSyncExamGrade({
        barcode,
        studentName: targetStudent?.name,
        examTitle,
        score,
        maxScore,
        percentage: pct,
        notes: `رصد درجة امتحان: ${examTitle} (${scoreFormatted})`,
        recordedBy: currentUser?.username || "admin",
        studentFallback: targetStudent,
      });
    } catch (err: any) {
      console.error("[App] Failed to record exam grade to cloud:", err);
      alert(`❌ فشل رصد الدرجة في السحابة: ${err?.message || "خطأ غير معروف"}`);
    }
  }, [students, currentUser]);

  // Handler: Update Full Student Exam Ledger (Supports unlimited past exams: 10, 100, 1000+)
  const handleUpdateStudentExams = useCallback(
    async (barcode: string, updatedExams: StudentExamRecord[], pointsDelta: number = 0) => {
      const targetStudent = students.find((s) => s.barcode === barcode);
      const updatedScores = updatedExams.map((e) => e.percentage);
      const last = updatedExams[updatedExams.length - 1];
      const lastTitle = last ? last.examTitle : "";
      const lastScore = last ? `${last.score}/${last.maxScore} (${last.percentage}%)` : "";
      const newPoints = (targetStudent?.points || 0) + pointsDelta;

      const updated = students.map((s) => {
        if (s.barcode === barcode) {
          return {
            ...s,
            examHistory: updatedExams,
            totalExamScores: updatedScores,
            lastExamTitle: lastTitle,
            lastExamScore: lastScore,
            points: 0,
          };
        }
        return s;
      });

      setStudents(updated);
      saveStudentsData(updated);

      if (last) {
        try {
          await cloudRecordExamGrade({
            barcode,
            studentName: targetStudent?.name || `طالب ${barcode}`,
            examTitle: lastTitle,
            score: last.score,
            maxScore: last.maxScore,
            recordedBy: currentUser?.username || "admin",
          });

          dualSyncExamGrade({
            barcode,
            studentName: targetStudent?.name,
            examTitle: lastTitle,
            score: last.score,
            maxScore: last.maxScore,
            notes: `سجل امتحانات الطالب (${updatedExams.length} امتحان)`,
            recordedBy: currentUser?.username || "admin",
            studentFallback: targetStudent,
          });
        } catch (err) {
          console.warn("[App] Cloud sync of student exam ledger warning:", err);
        }
      }
    },
    [students, currentUser]
  );

  // Handler: Delete all attendance records for a specific date
  const handleDeleteDateAttendance = useCallback(
    async (dateKey: string) => {
      const updatedHistory = { ...attendanceHistory };
      delete updatedHistory[dateKey];
      setAttendanceHistory(updatedHistory);
      saveAttendanceHistoryData(updatedHistory);

      const isToday = dateKey === getTodayKey();
      if (isToday) {
        setAttendanceToday({});
        saveAttendanceTodayData({});
      }

      const currentLocal = loadLocalData();
      syncDataToCloud({
        ...currentLocal,
        attendanceHistory: updatedHistory,
        attendanceToday: isToday ? {} : (currentLocal.attendanceToday || {}),
      });
    },
    [attendanceHistory]
  );

  // Handler: Update Grade Record from Cumulative Table
  const handleUpdateGradeRecord = useCallback(async (
    barcode: string,
    lastTitle: string,
    lastScore: string,
    newPoints: number,
    updatedScores: number[]
  ) => {
    const targetStudent = students.find((s) => s.barcode === barcode);
    const match = lastScore.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/);
    const score = match ? parseFloat(match[1]) : 100;
    const maxScore = match ? parseFloat(match[2]) : 100;
    const pct = Math.round((score / maxScore) * 100);

    try {
      // ⚡ STRICT CLOUD-FIRST: Await Supabase insertion/update
      await cloudRecordExamGrade({
        barcode,
        studentName: targetStudent?.name || `طالب ${barcode}`,
        examTitle: lastTitle,
        score,
        maxScore,
        recordedBy: currentUser?.username || "admin",
      });

      const updated = students.map((s) => {
        if (s.barcode === barcode) {
          return {
            ...s,
            lastExamTitle: lastTitle,
            lastExamScore: lastScore,
            points: 0,
            totalExamScores: updatedScores,
          };
        }
        return s;
      });
      setStudents(updated);
      saveStudentsData(updated);

      dualSyncExamGrade({
        barcode,
        studentName: targetStudent?.name,
        examTitle: lastTitle,
        score,
        maxScore,
        notes: `تعديل رصد درجة: ${lastTitle} (${lastScore})`,
        recordedBy: currentUser?.username || "admin",
        studentFallback: targetStudent,
      });
    } catch (err: any) {
      console.error("[App] Failed to update grade record in cloud:", err);
      alert(`❌ فشل تعديل الدرجة في السحابة: ${err?.message || "خطأ غير معروف"}`);
    }
  }, [students, currentUser]);

  // Handler: Manage Users
  const handleAddUser = async (newUser: UserAccount) => {
    const updated = [...usersList, newUser];
    setUsersList(updated);
    saveUsersData(updated);
    await cloudUpdateUsers(updated);
  };

  const handleUpdateUser = async (originalUsername: string, updatedUser: UserAccount) => {
    const updated = usersList.map((u) =>
      u.username === originalUsername ? updatedUser : u
    );
    setUsersList(updated);
    saveUsersData(updated);
    if (currentUser?.username === originalUsername) {
      setCurrentUser(updatedUser);
    }
    await cloudUpdateUsers(updated);
  };

  const handleDeleteUser = async (username: string) => {
    const updated = usersList.filter((u) => u.username !== username);
    setUsersList(updated);
    saveUsersData(updated);
    await cloudUpdateUsers(updated);
  };

  // Handler: Change Password
  const handleChangePassword = async (newPass: string) => {
    if (!currentUser) return;
    const updated = usersList.map((u) =>
      u.username === currentUser.username ? { ...u, pass: newPass } : u
    );
    setUsersList(updated);
    saveUsersData(updated);
    setCurrentUser({ ...currentUser, pass: newPass });
    await cloudUpdateUsers(updated);
  };

  // Handler: Update Group Default Price
  const handleUpdateGroupPrice = async (grade: GradeName, newPrice: number) => {
    const updated = { ...groupPrices, [grade]: newPrice };
    setGroupPrices(updated);
    saveGroupPricesData(updated);
    await cloudUpdateGroupPrices(updated);
  };

  // Handlers for WhatsApp Outbox
  const handleMarkWhatsAppSent = (id: string) => {
    markWhatsAppMessageSent(id);
    const nowStr = formatTimeArabic();
    setPendingWhatsAppMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, status: "sent", sentAt: nowStr } : m))
    );
  };

  const handleMarkAllWhatsAppSent = () => {
    markAllWhatsAppMessagesSent();
    const nowStr = formatTimeArabic();
    setPendingWhatsAppMessages((prev) =>
      prev.map((m) => (m.status === "pending" ? { ...m, status: "sent", sentAt: nowStr } : m))
    );
  };

  const handleDeleteWhatsAppMessage = (id: string) => {
    deletePendingWhatsAppMessage(id);
    setPendingWhatsAppMessages((prev) => prev.filter((m) => m.id !== id));
  };

  const handleClearAllWhatsAppMessages = () => {
    clearAllPendingWhatsAppMessages();
    setPendingWhatsAppMessages([]);
  };

  const handleUpdateWhatsAppMessageText = (id: string, newText: string) => {
    const updated = pendingWhatsAppMessages.map((m) =>
      m.id === id ? { ...m, message: newText } : m
    );
    savePendingWhatsAppMessages(updated);
    setPendingWhatsAppMessages(updated);
  };

  const pendingWhatsAppCount = pendingWhatsAppMessages.filter(
    (m) => m.status === "pending"
  ).length;

  const unreadPlatformMessagesCount = useMemo(() => {
    return platformMessages.filter((m) => m.status === "pending").length;
  }, [platformMessages]);

  return (
    <div
      dir="rtl"
      data-theme={theme}
      className={`min-h-screen ${
        theme === "light"
          ? "bg-slate-100 text-slate-900"
          : "bg-[#070b14] text-slate-100"
      } font-['Readex_Pro','Cairo',sans-serif] selection:bg-amber-500 selection:text-black`}
    >
      {/* 1. Auth Overlay (Login) */}
      {!currentUser && (
        <AuthOverlay
          usersList={usersList}
          onLoginSuccess={(user) => {
            setCurrentUser(user);
            try {
              sessionStorage.setItem("center_current_user", JSON.stringify(user));
              localStorage.removeItem("center_current_user");
            } catch {}
          }}
        />
      )}

      {currentUser && (
        <div className="flex flex-col h-screen overflow-hidden">
          {/* Top Navbar */}
          <Navbar
            currentUser={currentUser}
            currentDateText={formatArabicDate()}
            isOnline={syncStatus.isOnline}
            isSyncing={syncStatus.isSyncing}
            hasPendingSync={syncStatus.hasPendingSync}
            isQuotaExceeded={syncStatus.isQuotaExceeded}
            realtimeStatus={globalRealtimeStatus}
            onManualSync={handleManualSync}
            onOpenMultiDeviceSync={() => setIsMultiDeviceSyncModalOpen(true)}
            unreadPlatformMessagesCount={unreadPlatformMessagesCount}
            onNavigateToPlatformMessages={() => handleSelectTab("platform-messages")}
            pendingWhatsAppCount={pendingWhatsAppCount}
            onOpenWhatsAppOutbox={() => setIsWhatsAppOutboxOpen(true)}
            theme={theme}
            onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
            voiceEnabled={voiceEnabled}
            onToggleVoice={() => setVoiceEnabled(!voiceEnabled)}
            onLogout={() => {
              setCurrentUser(null);
              try {
                sessionStorage.removeItem("center_current_user");
                localStorage.removeItem("center_current_user");
              } catch {}
            }}
            activeSessionSlotId={activeSessionSlotId}
            onChangeSessionSlot={(slotId) => setActiveSessionSlotId(slotId)}
            onOpenQuickScan={() => setActiveTab("attendance-scan")}
            onOpenPrintAllPDF={() => setPrintModal({ open: true, type: "all" })}
            isSidebarOpen={isSidebarOpen}
            onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
          />

          {/* Floating Synchronization Notification Banner */}
          {syncBanner?.show && (
            <div className="px-4 py-2 max-w-5xl mx-auto w-full no-print">
              <div
                className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-2xl text-xs md:text-sm font-black border shadow-lg transition-all animate-fadeIn ${
                  syncBanner.type === "online-synced"
                    ? "bg-emerald-950/90 text-emerald-300 border-emerald-500/40 shadow-emerald-950/40"
                    : "bg-amber-950/90 text-amber-300 border-amber-500/40 shadow-amber-950/40"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {syncBanner.type === "online-synced" ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  ) : (
                    <WifiOff className="w-5 h-5 text-amber-400 shrink-0" />
                  )}
                  <span>{syncBanner.message}</span>
                </div>
                <button
                  onClick={() => setSyncBanner(null)}
                  className="p-1 rounded-lg hover:bg-white/10 text-white/70 hover:text-white cursor-pointer"
                  title="إغلاق التنبيه"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Pending WhatsApp Outbox Global Notice Banner */}
          {pendingWhatsAppCount > 0 && (
            <div className="px-4 py-1.5 max-w-5xl mx-auto w-full no-print">
              <div className="bg-gradient-to-r from-emerald-950/90 via-[#0a1a16] to-emerald-950/90 border border-emerald-500/50 p-3 rounded-2xl flex flex-wrap items-center justify-between gap-3 shadow-xl">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 rounded-xl bg-emerald-500/20 text-emerald-400">
                    <MessageSquare className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-black text-emerald-300">
                    توجد لديك <span className="font-mono text-white underline">{pendingWhatsAppCount}</span> رسائل واتساب معلقة (غياب / تأخير / درجات / مصاريف) بانتظار الإرسال!
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setIsWhatsAppOutboxOpen(true)}
                  className="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 text-black text-xs font-black shadow-md shadow-emerald-500/20 transition-all flex items-center gap-1.5 cursor-pointer transform hover:scale-105"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>إرسال كافة رسائل الواتساب الآن 🚀</span>
                </button>
              </div>
            </div>
          )}

          {/* Main Layout Area: Separated into isolated scrolling Sidebar & isolated Main Container */}
          <div className="flex flex-1 min-w-0 overflow-hidden relative">
            {/* Sidebar Navigation */}
            <Sidebar
              activeTab={activeTab}
              currentUser={currentUser}
              isOpen={isSidebarOpen}
              onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
              onSelectTab={handleSelectTab}
              onCloseMobile={() => setIsSidebarOpen(false)}
              onOpenPdfModal={(type) => setPrintModal({ open: true, type })}
              onOpenPrintCards={() => setIsCardsModalOpen(true)}
              onOpenBulkHomework={() => setIsBulkHomeworkModalOpen(true)}
            />

            {/* Tab Body View Container with dedicated independent scrolling */}
            <main
              ref={mainScrollRef}
              className="flex-1 overflow-y-auto h-full p-3 md:p-6 lg:p-8 max-w-full min-w-0 custom-scrollbar relative"
            >
              <div className="max-w-7xl mx-auto w-full min-w-0 pb-16">
                {activeTab === "attendance-scan" && (
                <AttendanceScanner
                  students={students}
                  attendanceToday={attendanceToday}
                  attendanceHistory={attendanceHistory}
                  scanLogOrder={scanLogOrder}
                  scanLogTimes={scanLogTimes}
                  payments={payments}
                  activeSessionSlotId={activeSessionSlotId}
                  voiceEnabled={voiceEnabled}
                  onRecordAttendance={handleRecordAttendance}
                  onFinishGroup={handleFinishGroup}
                  onRemoveFromScanner={handleRemoveFromScanner}
                  onClearSessionScans={handleClearSessionScans}
                  onChangeStatus={handleChangeAttendanceStatus}
                  onSyncGroupSession={handleSyncGroupSession}
                  onNavigateToReport={() => setActiveTab("stats")}
                />
              )}

              {activeTab === "homework-tracker" && (
                <HomeworkTrackerTab
                  students={students}
                  attendanceToday={attendanceToday}
                  onGoToMessages={() => handleSelectTab("platform-messages")}
                />
              )}

              {activeTab === "add-student" && (
                <AddStudentTab
                  students={students}
                  groupPrices={groupPrices}
                  onAddStudent={handleAddStudent}
                />
              )}

              {activeTab === "stats" && (
                <DailyAttendanceReport
                  students={students}
                  attendanceHistory={attendanceHistory}
                  onUpdateStatus={handleChangeAttendanceStatus}
                  onDeleteDateRecords={handleDeleteDateAttendance}
                  onOpenPdfModal={(type, targetDate, targetAttendanceMap) =>
                    setPrintModal({ open: true, type, targetDate, targetAttendanceMap })
                  }
                />
              )}

              {activeTab === "cumulative-report" && (
                <CumulativeGradesReport
                  students={students}
                  onUpdateGradeRecord={handleUpdateGradeRecord}
                  onUpdateStudentExams={handleUpdateStudentExams}
                  onOpenPdfModal={(type) => setPrintModal({ open: true, type })}
                />
              )}

              {activeTab === "pay-expenses" && (
                <PayExpensesTab
                  students={students}
                  payments={payments}
                  groupPrices={groupPrices}
                  onRecordPayment={handleRecordPayment}
                  onUpdatePayment={handleUpdatePayment}
                  onDeletePayment={handleDeletePayment}
                />
              )}

              {activeTab === "expenses" && (
                <FinancialsTab
                  students={students}
                  payments={payments}
                  groupPrices={groupPrices}
                  onOpenMultiDeviceSync={() => setIsMultiDeviceSyncModalOpen(true)}
                  onRecordPayment={handleRecordPayment}
                  onUpdatePayment={handleUpdatePayment}
                  onDeletePayment={handleDeletePayment}
                />
              )}

              {activeTab === "grades" && (
                <ExamGradesTab
                  students={students}
                  onRecordGrade={handleRecordExamGrade}
                />
              )}

              {activeTab === "early-warning" && (
                <EarlyWarningTab
                  students={students}
                  payments={payments}
                />
              )}

              {activeTab === "certificates" && (
                <CertificatesTab students={students} />
              )}

              {activeTab === "excel-integration" && (
                <ExcelIntegrationTab
                  students={students}
                  payments={payments}
                  attendanceHistory={attendanceHistory}
                  onBulkImportStudents={handleBulkImport}
                />
              )}

              {activeTab === "platform-messages" && (
                <PlatformMessagingTab
                  students={students}
                  messages={platformMessages}
                  attendanceToday={attendanceToday}
                  payments={payments}
                  onOpenManualWhatsApp={() => handleSelectTab("whatsapp-engine")}
                />
              )}

              {activeTab === "whatsapp-engine" && (
                <WhatsAppDirectTab
                  students={students}
                  onOpenWhatsAppOutbox={() => setIsWhatsAppOutboxOpen(true)}
                  pendingWhatsAppCount={pendingWhatsAppCount}
                />
              )}

              {activeTab === "manage-students" && (
                <ManageStudentsTab
                  students={students}
                  payments={payments}
                  groupPrices={groupPrices}
                  onUpdateStudent={handleUpdateStudent}
                  onDeleteStudent={handleDeleteStudent}
                  onClearAllData={handleClearAllData}
                  onOpenPrintCards={() => setIsCardsModalOpen(true)}
                  onOpenMultiDeviceSync={() => setIsMultiDeviceSyncModalOpen(true)}
                  onRecordPayment={handleRecordPayment}
                  onUpdatePayment={handleUpdatePayment}
                  onDeletePayment={handleDeletePayment}
                />
              )}

              {activeTab === "users" && (
                <UsersTab
                  usersList={usersList}
                  currentUser={currentUser}
                  onAddUser={handleAddUser}
                  onUpdateUser={handleUpdateUser}
                  onDeleteUser={handleDeleteUser}
                />
              )}

              {activeTab === "settings" && (
                <SettingsTab
                  currentUser={currentUser}
                  groupPrices={groupPrices}
                  theme={theme}
                  onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
                  onChangePassword={handleChangePassword}
                  onUpdateGroupPrice={handleUpdateGroupPrice}
                />
              )}
              </div>
            </main>
          </div>
        </div>
      )}

      {/* Grade-by-Grade Independent PDF Multi-Page Modal */}
      {printModal.open && (
        <PrintPDFModal
          type={printModal.type}
          students={students}
          attendanceToday={printModal.targetAttendanceMap || attendanceToday}
          payments={payments}
          groupPrices={groupPrices}
          targetDate={printModal.targetDate}
          onClose={() => setPrintModal({ ...printModal, open: false })}
        />
      )}

      {/* Student Barcode ID Cards Grid Modal */}
      {isCardsModalOpen && (
        <PrintCardsModal
          students={students}
          onClose={() => setIsCardsModalOpen(false)}
        />
      )}

      {/* Offline WhatsApp Outbox Queue Modal */}
      {isWhatsAppOutboxOpen && (
        <PendingWhatsAppOutboxModal
          isOpen={isWhatsAppOutboxOpen}
          onClose={() => setIsWhatsAppOutboxOpen(false)}
          pendingMessages={pendingWhatsAppMessages}
          isOnline={syncStatus.isOnline}
          onMarkSent={handleMarkWhatsAppSent}
          onMarkAllSent={handleMarkAllWhatsAppSent}
          onDeleteMessage={handleDeleteWhatsAppMessage}
          onClearAll={handleClearAllWhatsAppMessages}
          onUpdateMessageText={handleUpdateWhatsAppMessageText}
        />
      )}

      {/* Multi-Device Cloud Sync & Backup Modal */}
      {isMultiDeviceSyncModalOpen && (
        <MultiDeviceSyncModal
          isOpen={isMultiDeviceSyncModalOpen}
          onClose={() => setIsMultiDeviceSyncModalOpen(false)}
          students={students}
          payments={payments}
          groupPrices={groupPrices}
          isOnline={syncStatus.isOnline}
          onRecordPayment={handleRecordPayment}
        />
      )}

      {/* Bulk Group Homework Platform Notifications Modal */}
      {isBulkHomeworkModalOpen && (
        <BulkHomeworkModal
          isOpen={isBulkHomeworkModalOpen}
          onClose={() => setIsBulkHomeworkModalOpen(false)}
          students={students}
          attendanceToday={attendanceToday}
          targetDate={getTodayKey()}
        />
      )}
    </div>
  );
}
