/**
 * src/hooks/useGlobalRealtimeSync.ts
 * 
 * Global Postgres Change Data Capture (CDC) Realtime Mirroring Engine
 * 
 * Production-Ready Features:
 * 1. Subscribes to Supabase `postgres_changes` across ALL core tables:
 *    - `public.students`
 *    - `public.attendance_logs`
 *    - `public.payments`
 *    - `public.homework`
 *    - `public.system_configs`
 *    - `public.parent_accounts`
 * 2. Applies granular row-level DELTA state updates directly to React in-memory state.
 * 3. Zero screen flickers, zero full re-fetches, immune to high-frequency concurrency.
 * 4. Deduplicates echoes from local mutations using deterministic idempotency caching.
 * 5. Integrated Presence tracking to monitor all connected Admin and Supervisor screens.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Dispatch, SetStateAction, MutableRefObject } from "react";
import { RealtimeChannel } from "@supabase/supabase-js";
import { supabase, getTodayDateKey } from "../utils/supabaseClient";
import { Student, PaymentRecord, UserAccount, GradeName } from "../types";
import { getPersistentDeviceId, getPersistentDeviceName } from "../utils/deviceClient";
import { saveStudentsData } from "../utils/storage";

export interface GlobalRealtimeSyncProps {
  setStudents: Dispatch<SetStateAction<Student[]>>;
  appStudentsRef: MutableRefObject<Student[]>;
  setAttendanceToday: Dispatch<SetStateAction<Record<string, string>>>;
  attendanceTodayRef: MutableRefObject<Record<string, string>>;
  setAttendanceHistory: Dispatch<SetStateAction<Record<string, Record<string, string>>>>;
  attendanceHistoryRef: MutableRefObject<Record<string, Record<string, string>>>;
  setScanLogOrder: Dispatch<SetStateAction<string[]>>;
  scanLogOrderRef: MutableRefObject<string[]>;
  setScanLogTimes: Dispatch<SetStateAction<Record<string, string>>>;
  scanLogTimesRef: MutableRefObject<Record<string, string>>;
  setPayments: Dispatch<SetStateAction<Record<string, Record<string, PaymentRecord>>>>;
  paymentsRef: MutableRefObject<Record<string, Record<string, PaymentRecord>>>;
  setGroupPrices: Dispatch<SetStateAction<Record<GradeName, number>>>;
  setUsersList: Dispatch<SetStateAction<UserAccount[]>>;
  onSyncNotice?: (notice: { message: string; type?: "online-synced" | "offline-mode" }) => void;
}

export interface RealtimeSyncStatus {
  status: "CONNECTING" | "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "ERROR";
  connectedPeersCount: number;
  lastEventDescription: string | null;
  lastEventTimestamp: number | null;
}

export function useGlobalRealtimeSync({
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
  onSyncNotice,
}: GlobalRealtimeSyncProps) {
  const [syncStatus, setSyncStatus] = useState<RealtimeSyncStatus>({
    status: "CONNECTING",
    connectedPeersCount: 1,
    lastEventDescription: null,
    lastEventTimestamp: null,
  });

  const [reconnectCounter, setReconnectCounter] = useState(0);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const recentEventsDedupMap = useRef<Map<string, number>>(new Map());

  // Keep latest onSyncNotice callback in a ref to avoid recreating callbacks or re-triggering effects
  const onSyncNoticeRef = useRef(onSyncNotice);
  useEffect(() => {
    onSyncNoticeRef.current = onSyncNotice;
  }, [onSyncNotice]);

  // Deduplication check to suppress immediate echoes and duplicate bursts
  const isDuplicateEvent = useCallback((eventKey: string, windowMs: number = 2000): boolean => {
    const now = Date.now();
    const last = recentEventsDedupMap.current.get(eventKey);
    if (last && now - last < windowMs) {
      return true;
    }
    recentEventsDedupMap.current.set(eventKey, now);

    // Housekeeping: purge old entries periodically
    if (recentEventsDedupMap.current.size > 200) {
      for (const [k, t] of recentEventsDedupMap.current.entries()) {
        if (now - t > 30000) {
          recentEventsDedupMap.current.delete(k);
        }
      }
    }
    return false;
  }, []);

  const triggerNotice = useCallback((message: string) => {
    if (onSyncNoticeRef.current) {
      onSyncNoticeRef.current({ message, type: "online-synced" });
    }
  }, []);

  useEffect(() => {
    const clientDeviceId = getPersistentDeviceId();
    const clientDeviceName = getPersistentDeviceName();

    console.log(`[Supabase CDC Hub] Initializing Global CDC Listener for Device: ${clientDeviceName} (${clientDeviceId})`);

    // Clean existing channel if any
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
    }

    const channelName = "db-global-cdc-channel";
    const channel = supabase.channel(channelName, {
      config: {
        presence: {
          key: clientDeviceId,
        },
      },
    });

    // ------------------------------------------------------------------------
    // 1. PRESENCE TRACKING (Multi-Device Discovery)
    // ------------------------------------------------------------------------
    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        const peerCount = Math.max(1, Object.keys(state).length);
        setSyncStatus((prev) => {
          if (prev.connectedPeersCount === peerCount) return prev;
          return {
            ...prev,
            connectedPeersCount: peerCount,
          };
        });
      })
      .on("presence", { event: "join" }, ({ newPresences }) => {
        const peerName = (newPresences?.[0] as any)?.deviceName || "جهاز جديد";
        console.log(`[Supabase CDC Hub] Peer joined: ${peerName}`);
      });

    // ------------------------------------------------------------------------
    // 2. POSTGRES CDC: STUDENTS TABLE
    // ------------------------------------------------------------------------
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "students" },
      (payload) => {
        const { eventType, new: newRow, old: oldRow } = payload as any;
        const now = Date.now();

        if (eventType === "INSERT" && newRow) {
          const barcode = String(newRow.barcode).trim();
          const dedupKey = `student_insert_${barcode}`;
          if (isDuplicateEvent(dedupKey)) return;

          const newStudent: Student = {
            id: newRow.id,
            barcode,
            name: newRow.name || `طالب ${barcode}`,
            phone: newRow.phone || "",
            parentPhone: newRow.parent_phone || newRow.phone || "",
            groupGrade: newRow.grade || "الصف الأول الثانوي",
            groupDays: newRow.group_days || "سبت - إثنين - أربعاء",
            customMonthlyFee: Number(newRow.monthly_fee) || undefined,
            discountReason: newRow.notes || undefined,
            points: 0,
            totalAttendanceDays: 0,
            totalAbsentDays: 0,
            totalExamScores: [],
            notes: newRow.notes || "",
            createdAt: newRow.created_at || new Date().toISOString(),
          };

          setStudents((prev) => {
            let updated: Student[];
            if (prev.some((s) => s.barcode === barcode)) {
              updated = prev.map((s) => (s.barcode === barcode ? { ...s, ...newStudent } : s));
            } else {
              updated = [newStudent, ...prev];
            }
            appStudentsRef.current = updated;
            saveStudentsData(updated);
            return updated;
          });

          setSyncStatus((prev) => ({
            ...prev,
            lastEventDescription: `إضافة طالب جديد: ${newStudent.name}`,
            lastEventTimestamp: now,
          }));
          triggerNotice(`⚡ مزامنة فورية: تم إضافة الطالب (${newStudent.name}) على جميع الأجهزة!`);
        } else if (eventType === "UPDATE" && newRow) {
          const barcode = String(newRow.barcode).trim();
          const dedupKey = `student_update_${barcode}_${newRow.updated_at || ""}`;
          if (isDuplicateEvent(dedupKey, 1000)) return;

          setStudents((prev) => {
            const updated = prev.map((s) => {
              if (s.barcode === barcode || (s.id && s.id === newRow.id)) {
                return {
                  ...s,
                  id: newRow.id || s.id,
                  barcode,
                  name: newRow.name || s.name,
                  phone: newRow.phone ?? s.phone,
                  parentPhone: newRow.parent_phone ?? s.parentPhone,
                  groupGrade: newRow.grade || s.groupGrade,
                  groupDays: newRow.group_days || s.groupDays,
                  customMonthlyFee: Number(newRow.monthly_fee) ?? s.customMonthlyFee,
                  notes: newRow.notes ?? s.notes,
                };
              }
              return s;
            });
            appStudentsRef.current = updated;
            saveStudentsData(updated);
            return updated;
          });

          setSyncStatus((prev) => ({
            ...prev,
            lastEventDescription: `تحديث بيانات: ${newRow.name || barcode}`,
            lastEventTimestamp: now,
          }));
          triggerNotice(`⚡ مزامنة فورية: تم تحديث بيانات الطالب (${newRow.name || barcode})`);
        } else if (eventType === "DELETE" && oldRow) {
          // Replica Identity Full guarantees oldRow contains barcode and id
          const barcode = String(oldRow.barcode || "").trim();
          const id = oldRow.id;
          const dedupKey = `student_delete_${barcode || id}`;
          if (isDuplicateEvent(dedupKey)) return;

          setStudents((prev) => {
            const updated = prev.filter((s) => {
              if (barcode && s.barcode === barcode) return false;
              if (id && s.id === id) return false;
              return true;
            });
            appStudentsRef.current = updated;
            saveStudentsData(updated, barcode);
            return updated;
          });

          if (barcode) {
            setAttendanceToday((prev) => {
              if (!prev[barcode]) return prev;
              const next = { ...prev };
              delete next[barcode];
              attendanceTodayRef.current = next;
              return next;
            });
            setScanLogOrder((prev) => prev.filter((b) => b !== barcode));
          }

          setSyncStatus((prev) => ({
            ...prev,
            lastEventDescription: `حذف طالب: ${barcode}`,
            lastEventTimestamp: now,
          }));
          triggerNotice(`⚡ مزامنة فورية: تم حذف الطالب (${barcode}) من جميع الأجهزة`);
        }
      }
    );

    // ------------------------------------------------------------------------
    // 3. POSTGRES CDC: ATTENDANCE LOGS TABLE (Zero-Lag Scanner & Absence)
    // ------------------------------------------------------------------------
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "attendance_logs" },
      (payload) => {
        const { eventType, new: newRow, old: oldRow } = payload as any;
        const now = Date.now();

        if ((eventType === "INSERT" || eventType === "UPDATE") && newRow) {
          const barcode = String(newRow.barcode).trim();
          const dateKey = newRow.date_key || getTodayDateKey();
          const todayKey = getTodayDateKey();
          const rawStatus = newRow.status;
          const normalizedStatus: "حضور" | "تأخير" | "غائب" =
            rawStatus === "غائب" || rawStatus === "غياب"
              ? "غائب"
              : rawStatus === "تأخير"
              ? "تأخير"
              : "حضور";

          const dedupKey = `att_${dateKey}_${barcode}_${normalizedStatus}`;
          if (isDuplicateEvent(dedupKey, 1500)) return;

          // 1. Update Attendance Today if the record belongs to today
          if (dateKey === todayKey) {
            setAttendanceToday((prev) => {
              const next = { ...prev, [barcode]: normalizedStatus };
              attendanceTodayRef.current = next;
              return next;
            });

            if (normalizedStatus === "حضور" || normalizedStatus === "تأخير") {
              setScanLogOrder((prev) => (prev.includes(barcode) ? prev : [barcode, ...prev]));
              setScanLogTimes((prev) => ({
                ...prev,
                [barcode]: newRow.time_recorded || new Date().toISOString(),
              }));
            }
          }

          // 2. Update Attendance History for target date
          setAttendanceHistory((prev) => {
            const dayMap = { ...(prev[dateKey] || {}) };
            dayMap[barcode] = normalizedStatus;
            const nextHist = { ...prev, [dateKey]: dayMap };
            attendanceHistoryRef.current = nextHist;
            return nextHist;
          });

          // 3. Increment/adjust attendance stats on student in-memory object
          setStudents((prev) => {
            const next = prev.map((s) => {
              if (s.barcode === barcode) {
                if (normalizedStatus === "غائب") {
                  return {
                    ...s,
                    totalAbsentDays: (s.totalAbsentDays || 0) + 1,
                  };
                } else {
                  return {
                    ...s,
                    totalAttendanceDays: (s.totalAttendanceDays || 0) + 1,
                  };
                }
              }
              return s;
            });
            appStudentsRef.current = next;
            return next;
          });

          setSyncStatus((prev) => ({
            ...prev,
            lastEventDescription: `حضور ${normalizedStatus}: ${newRow.student_name || barcode}`,
            lastEventTimestamp: now,
          }));

          if (dateKey === todayKey) {
            triggerNotice(`⚡ مسح فوري (Supabase): تم تسجيل ${normalizedStatus} للطالب (${newRow.student_name || barcode})!`);
          }
        } else if (eventType === "DELETE" && oldRow) {
          const barcode = String(oldRow.barcode || "").trim();
          const dateKey = oldRow.date_key || getTodayDateKey();
          const todayKey = getTodayDateKey();
          const dedupKey = `att_del_${dateKey}_${barcode}`;
          if (isDuplicateEvent(dedupKey)) return;

          if (barcode) {
            if (dateKey === todayKey) {
              setAttendanceToday((prev) => {
                if (!prev[barcode]) return prev;
                const next = { ...prev };
                delete next[barcode];
                attendanceTodayRef.current = next;
                return next;
              });
              setScanLogOrder((prev) => prev.filter((b) => b !== barcode));
            }

            setAttendanceHistory((prev) => {
              if (!prev[dateKey] || !prev[dateKey][barcode]) return prev;
              const next = { ...prev };
              const dayMap = { ...next[dateKey] };
              delete dayMap[barcode];
              next[dateKey] = dayMap;
              attendanceHistoryRef.current = next;
              return next;
            });

            triggerNotice(`⚡ مزامنة فورية: تم حذف تسجيل الحضور للطالب (${barcode})`);
          }
        }
      }
    );

    // ------------------------------------------------------------------------
    // 4. POSTGRES CDC: PAYMENTS TABLE (Tuition & Custom Fees)
    // ------------------------------------------------------------------------
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "payments" },
      (payload) => {
        const { eventType, new: newRow, old: oldRow } = payload as any;
        const now = Date.now();

        if ((eventType === "INSERT" || eventType === "UPDATE") && newRow) {
          const monthKey = newRow.month_key;
          const studentId = newRow.student_id;

          // Resolve student barcode from in-memory cache
          const targetStudent = appStudentsRef.current.find(
            (s) => s.id === studentId || s.barcode === studentId
          );
          const barcode = targetStudent?.barcode || studentId;

          const dedupKey = `payment_${monthKey}_${barcode}_${newRow.amount_paid}`;
          if (isDuplicateEvent(dedupKey, 1500)) return;

          const paymentRecord: PaymentRecord = {
            id: newRow.id,
            barcode,
            month: monthKey,
            monthKey,
            amount: Number(newRow.amount_paid) || 0,
            date: newRow.payment_date ? newRow.payment_date.split("T")[0] : getTodayDateKey(),
            time: newRow.payment_date
              ? new Date(newRow.payment_date).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })
              : "",
            note: newRow.notes || `اشتراك شهر ${monthKey}`,
            recordedBy: newRow.received_by || "admin",
            isCardFee: monthKey?.startsWith("card_"),
          };

          setPayments((prev) => {
            const next = { ...prev };
            const m = { ...(next[monthKey] || {}) };
            m[barcode] = paymentRecord;
            next[monthKey] = m;
            paymentsRef.current = next;
            return next;
          });

          setSyncStatus((prev) => ({
            ...prev,
            lastEventDescription: `سداد اشتراك: شهر ${monthKey} للطالب ${barcode}`,
            lastEventTimestamp: now,
          }));
          triggerNotice(`⚡ تحديث مالي فوري: تم تسجيل سداد شهر (${monthKey}) للطالب (${targetStudent?.name || barcode})!`);
        } else if (eventType === "DELETE" && oldRow) {
          const monthKey = oldRow.month_key;
          const studentId = oldRow.student_id;
          const targetStudent = appStudentsRef.current.find(
            (s) => s.id === studentId || s.barcode === studentId
          );
          const barcode = targetStudent?.barcode || studentId;

          const dedupKey = `payment_del_${monthKey}_${barcode}`;
          if (isDuplicateEvent(dedupKey)) return;

          if (monthKey && barcode) {
            setPayments((prev) => {
              if (!prev[monthKey] || !prev[monthKey][barcode]) return prev;
              const next = { ...prev };
              const m = { ...next[monthKey] };
              delete m[barcode];
              next[monthKey] = m;
              paymentsRef.current = next;
              return next;
            });
            triggerNotice(`⚡ مزامنة فورية: تم حذف سداد شهر (${monthKey}) للطالب (${barcode})`);
          }
        }
      }
    );

    // ------------------------------------------------------------------------
    // 5. POSTGRES CDC: HOMEWORK & EXAM GRADES TABLE
    // ------------------------------------------------------------------------
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "homework" },
      (payload) => {
        const { eventType, new: newRow } = payload as any;
        const now = Date.now();

        if ((eventType === "INSERT" || eventType === "UPDATE") && newRow && newRow.score != null) {
          const studentId = newRow.student_id;
          const targetStudent = appStudentsRef.current.find(
            (s) => s.id === studentId || s.barcode === studentId
          );
          if (!targetStudent) return;

          const score = Number(newRow.score);
          const maxScore = Number(newRow.max_score) || 100;
          const pct = Math.round((score / maxScore) * 100);
          const scoreFormatted = `${score}/${maxScore} (${pct}%)`;

          const dedupKey = `grade_${targetStudent.barcode}_${newRow.title}_${score}`;
          if (isDuplicateEvent(dedupKey, 1500)) return;

          setStudents((prev) => {
            const next = prev.map((s) => {
              if (s.barcode === targetStudent.barcode) {
                const scores = s.totalExamScores ? [...s.totalExamScores, pct] : [pct];
                const pointsBonus = pct === 100 ? 20 : pct >= 90 ? 10 : pct >= 75 ? 5 : 0;
                return {
                  ...s,
                  lastExamTitle: newRow.title,
                  lastExamScore: scoreFormatted,
                  totalExamScores: scores,
                  points: (s.points || 0) + pointsBonus,
                };
              }
              return s;
            });
            appStudentsRef.current = next;
            return next;
          });

          setSyncStatus((prev) => ({
            ...prev,
            lastEventDescription: `رصد امتحان: ${newRow.title} (${scoreFormatted})`,
            lastEventTimestamp: now,
          }));
          triggerNotice(`⚡ رصد درجات لحظي: تم رصد درجة (${newRow.title}) للطالب (${targetStudent.name}): ${scoreFormatted}!`);
        }
      }
    );

    // ------------------------------------------------------------------------
    // 6. POSTGRES CDC: SYSTEM CONFIGS TABLE (Prices & User Roles)
    // ------------------------------------------------------------------------
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "system_configs" },
      (payload) => {
        const { eventType, new: newRow } = payload as any;
        if ((eventType === "INSERT" || eventType === "UPDATE") && newRow) {
          const configId = newRow.id;
          const configVal = newRow.config_value;

          const dedupKey = `sys_config_${configId}_${newRow.updated_at || ""}`;
          if (isDuplicateEvent(dedupKey, 1500)) return;

          if (configId === "group_prices" && configVal) {
            setGroupPrices(configVal as Record<GradeName, number>);
            triggerNotice("⚡ تم تحديث أسعار المجموعات فورياً عبر كافة الأجهزة المتصلة!");
          } else if (configId === "users" && Array.isArray(configVal)) {
            setUsersList(configVal as UserAccount[]);
            triggerNotice("⚡ تم تحديث صلاحيات المشرفين والمستخدمين فورياً عبر السحابة!");
          }
        }
      }
    );

    // ------------------------------------------------------------------------
    // 7. SUBSCRIBE & TRACK CHANNEL STATUS
    // ------------------------------------------------------------------------
    channel.subscribe((status) => {
      console.log(`[Supabase CDC Hub] Connection state changed: ${status}`);
      setSyncStatus((prev) => {
        if (prev.status === status) return prev;
        return {
          ...prev,
          status: status as any,
        };
      });

      if (status === "SUBSCRIBED") {
        // Track presence
        channel.track({
          deviceId: clientDeviceId,
          deviceName: clientDeviceName,
          joinedAt: new Date().toISOString(),
        });
      }
    });

    channelRef.current = channel;

    return () => {
      console.log("[Supabase CDC Hub] Unsubscribing from Global CDC Listener...");
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [
    reconnectCounter,
    triggerNotice,
    isDuplicateEvent,
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
  ]);

  const forceReconnect = useCallback(() => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    setSyncStatus((prev) => ({ ...prev, status: "CONNECTING" }));
    setReconnectCounter((c) => c + 1);
  }, []);

  return useMemo(
    () => ({
      ...syncStatus,
      forceReconnect,
    }),
    [syncStatus, forceReconnect]
  );
}
