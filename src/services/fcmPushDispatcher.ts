/**
 * src/services/fcmPushDispatcher.ts
 * 
 * High-Priority Event Dispatcher (FCM HTTP v1) for Parent Application
 * 
 * Spec Compliance:
 * 1. FCM HTTP v1 Standards:
 *    - Android Priority: "HIGH" (`android.priority = HIGH`)
 *    - Audio Channel: default OS chime with maximum volume (`default_sound = true`)
 *    - Sound: "default", Notification Priority: "PRIORITY_MAX"
 *    - APNs Priority: "10" for instant iOS wake
 *    - WebPush Urgency: "high"
 *    - Structured `data` payload with action type and timestamp (strictly string key-values).
 * 2. Multi-Channel Redundancy:
 *    - FCM HTTP v1 Webhook (`/api/notifications/fcm-dispatch`)
 *    - Supabase Realtime Broadcast (`parent-realtime-hub` & `parent_event_${barcode}`)
 *    - Local WAL & Throttled Offline Queue with 2-Hour TTL (`emitParentNotification`)
 *    - Inter-Tab Instant BroadcastChannel (<1ms)
 */

import { supabase } from "../utils/supabaseClient";
import { Student } from "../types";
import { emitParentNotification } from "../architecture/parentSyncNotifier";
import { HLCEngine } from "../architecture/syncEngine";
import { ParentNotificationType } from "../architecture/dbSchema";
import { checkIsLocalServerHubAvailable } from "../utils/storage";

export type FcmActionType =
  | "ATTENDANCE_PRESENT"
  | "ATTENDANCE_LATE"
  | "ATTENDANCE_ABSENT"
  | "EXAM_GRADE"
  | "HOMEWORK_STATUS"
  | "PAYMENT_RECEIPT"
  | "PROFILE_UPDATE"
  | "SUPERVISOR_CHAT";

export interface FcmDispatchOptions {
  actionType: FcmActionType;
  studentBarcode: string;
  studentName: string;
  parentPhone?: string;
  title: string;
  body: string;
  dataFields?: Record<string, string | number | boolean | undefined | null>;
  fcmToken?: string;
  timestamp?: number;
}

export interface FcmHttpV1MessagePayload {
  message: {
    token?: string;
    topic?: string;
    notification: {
      title: string;
      body: string;
    };
    data: Record<string, string>;
    android: {
      priority: "HIGH";
      notification: {
        channel_id: string;
        sound: "default";
        default_sound: true;
        default_vibrate_timings: true;
        notification_priority: "PRIORITY_MAX";
        visibility?: "PUBLIC";
      };
    };
    apns: {
      headers: {
        "apns-priority": "10";
      };
      payload: {
        aps: {
          alert: {
            title: string;
            body: string;
          };
          sound: "default";
          badge: number;
          contentAvailable: boolean;
        };
      };
    };
    webpush: {
      headers: {
        Urgency: "high";
      };
      notification: {
        title: string;
        body: string;
        icon: string;
        badge: string;
        tag?: string;
        requireInteraction: boolean;
      };
    };
  };
}

export interface FcmDispatchResult {
  success: boolean;
  actionType: FcmActionType;
  studentBarcode: string;
  fcmToken?: string;
  eventId: string;
  timestamp: number;
  payload: FcmHttpV1MessagePayload;
  error?: string;
}

// In-memory token cache to achieve < 1ms resolution on repetitive dispatches
const parentTokenCache = new Map<string, { token: string; cachedAt: number }>();
const TOKEN_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Resolves the parent's FCM token linked to this student from Supabase
 */
export async function lookupParentFcmToken(
  studentBarcode: string,
  parentPhone?: string
): Promise<string | null> {
  const cleanBarcode = String(studentBarcode || "").trim();
  const cleanPhone = String(parentPhone || "").trim();

  // 1. Check in-memory cache
  if (cleanPhone) {
    const cached = parentTokenCache.get(`phone_${cleanPhone}`);
    if (cached && Date.now() - cached.cachedAt < TOKEN_CACHE_TTL_MS) {
      return cached.token;
    }
  }
  if (cleanBarcode) {
    const cached = parentTokenCache.get(`barcode_${cleanBarcode}`);
    if (cached && Date.now() - cached.cachedAt < TOKEN_CACHE_TTL_MS) {
      return cached.token;
    }
  }

  // 2. Check local client storage for parent push token (saved during parent portal login / registration)
  if (typeof window !== "undefined") {
    try {
      const localToken =
        localStorage.getItem(`parent_fcm_token_${cleanBarcode}`) ||
        (cleanPhone ? localStorage.getItem(`parent_fcm_token_${cleanPhone}`) : null);
      if (localToken && localToken.trim()) {
        const tok = localToken.trim();
        if (cleanPhone) parentTokenCache.set(`phone_${cleanPhone}`, { token: tok, cachedAt: Date.now() });
        if (cleanBarcode) parentTokenCache.set(`barcode_${cleanBarcode}`, { token: tok, cachedAt: Date.now() });
        return tok;
      }
    } catch {}
  }

  return null;
}

/**
 * Builds standard-compliant FCM HTTP v1 JSON message
 */
export function buildFcmHttpV1Payload(
  targetToken: string | null,
  options: FcmDispatchOptions,
  timestamp: number
): FcmHttpV1MessagePayload {
  const cleanBarcode = String(options.studentBarcode).trim();
  const cleanName = options.studentName.trim();
  const cleanPhone = String(options.parentPhone || "").trim();

  // FCM data values MUST strictly be string-typed primitives
  const sanitizedData: Record<string, string> = {
    action_type: options.actionType,
    student_barcode: cleanBarcode,
    student_name: cleanName,
    parent_phone: cleanPhone,
    timestamp: String(timestamp),
    priority: "HIGH",
    channel_id: "parent_urgent_alerts",
  };

  if (options.dataFields) {
    Object.entries(options.dataFields).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        sanitizedData[k] = String(v);
      }
    });
  }

  const payload: FcmHttpV1MessagePayload = {
    message: {
      ...(targetToken ? { token: targetToken } : { topic: `student_${cleanBarcode}` }),
      notification: {
        title: options.title,
        body: options.body,
      },
      data: sanitizedData,
      android: {
        priority: "HIGH",
        notification: {
          channel_id: "parent_urgent_alerts",
          sound: "default",
          default_sound: true,
          default_vibrate_timings: true,
          notification_priority: "PRIORITY_MAX",
          visibility: "PUBLIC",
        },
      },
      apns: {
        headers: {
          "apns-priority": "10",
        },
        payload: {
          aps: {
            alert: {
              title: options.title,
              body: options.body,
            },
            sound: "default",
            badge: 1,
            contentAvailable: true,
          },
        },
      },
      webpush: {
        headers: {
          Urgency: "high",
        },
        notification: {
          title: options.title,
          body: options.body,
          icon: "/pwa-192x192.png",
          badge: "/pwa-192x192.png",
          tag: `fcm_${options.actionType}_${cleanBarcode}`,
          requireInteraction: true,
        },
      },
    },
  };

  return payload;
}

/**
 * Maps FcmActionType to ParentNotificationType for WAL and offline storage
 */
function mapToParentNotificationType(actionType: FcmActionType): ParentNotificationType {
  switch (actionType) {
    case "ATTENDANCE_PRESENT":
      return "ATTENDANCE_SCAN";
    case "ATTENDANCE_LATE":
      return "LATE_ARRIVAL";
    case "ATTENDANCE_ABSENT":
      return "ABSENCE_ALERT";
    case "EXAM_GRADE":
      return "EXAM_RESULT";
    case "HOMEWORK_STATUS":
      return "HOMEWORK_STATUS";
    case "PAYMENT_RECEIPT":
      return "PAYMENT_RECEIPT";
    case "PROFILE_UPDATE":
      return "PROFILE_UPDATE";
    case "SUPERVISOR_CHAT":
      return "SUPERVISOR_CHAT";
    default:
      return "ATTENDANCE_SCAN";
  }
}

/**
 * Primary FCM High-Priority Event Dispatcher
 * Executes immediately across cloud, webhooks, and local realtime channels
 */
export async function dispatchFcmPushNotification(
  options: FcmDispatchOptions
): Promise<FcmDispatchResult> {
  const timestamp = options.timestamp || Date.now();
  const cleanBarcode = String(options.studentBarcode).trim();
  const eventId = `fcm_${options.actionType.toLowerCase()}_${cleanBarcode}_${timestamp}`;

  // 1. Resolve parent's FCM token (or use provided override)
  let resolvedToken = options.fcmToken || null;
  if (!resolvedToken) {
    resolvedToken = await lookupParentFcmToken(cleanBarcode, options.parentPhone);
  }

  // 2. Build RFC/FCM HTTP v1 compliant payload
  const fcmPayload = buildFcmHttpV1Payload(resolvedToken, options, timestamp);

  // 3. Dispatch to server-side FCM HTTP v1 endpoint (/api/notifications/fcm-dispatch) ONLY if local server hub is active
  if (typeof window !== "undefined" && checkIsLocalServerHubAvailable()) {
    fetch("/api/notifications/fcm-dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId,
        actionType: options.actionType,
        studentBarcode: cleanBarcode,
        studentName: options.studentName,
        parentPhone: options.parentPhone,
        fcmToken: resolvedToken,
        title: options.title,
        body: options.body,
        fcmPayload,
        timestamp,
      }),
    }).catch((err) => {
      console.warn("[FCM Dispatcher] Server dispatch notification note:", err);
    });
  }

  // 4. Concurrently broadcast over Supabase Realtime channel (< 20ms)
  try {
    const channel = supabase.channel("parent-realtime-hub", {
      config: { broadcast: { self: false, ack: false } },
    });

    const sendBroadcast = (msg: any) => {
      if (typeof (channel as any).httpSend === "function") {
        return (channel as any).httpSend(msg).catch(() => {});
      }
      return channel.send(msg).catch(() => {});
    };

    sendBroadcast({
      type: "broadcast",
      event: `parent_event_${cleanBarcode}`,
      payload: {
        eventId,
        actionType: options.actionType,
        studentBarcode: cleanBarcode,
        studentName: options.studentName,
        parentPhone: options.parentPhone,
        title: options.title,
        body: options.body,
        data: fcmPayload.message.data,
        timestamp,
      },
    });

    sendBroadcast({
      type: "broadcast",
      event: "parent_stream_feed",
      payload: {
        eventId,
        actionType: options.actionType,
        studentBarcode: cleanBarcode,
        studentName: options.studentName,
        title: options.title,
        body: options.body,
        timestamp,
      },
    });
  } catch (err) {
    console.warn("[FCM Dispatcher] Supabase realtime broadcast note:", err);
  }

  // 5. Concurrently queue in local WAL and throttled offline buffer with 2-Hour TTL
  try {
    let hlc;
    try {
      hlc = HLCEngine.now();
    } catch {
      hlc = { logicalTime: timestamp, counter: 0, nodeId: "supervisor_client" };
    }

    const todayDateKey =
      String(options.dataFields?.date_key || options.dataFields?.date || "").trim() ||
      new Date(timestamp).toISOString().slice(0, 10);

    emitParentNotification({
      studentBarcode: cleanBarcode,
      studentName: options.studentName,
      parentPhone: options.parentPhone || "",
      type: mapToParentNotificationType(options.actionType),
      title: options.title,
      body: options.body,
      meta: {
        dateKey: todayDateKey,
        timeDisplay: String(options.dataFields?.time_display || new Date(timestamp).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })),
        status: String(options.dataFields?.status || ""),
        amount: Number(options.dataFields?.amount) || undefined,
        monthKey: String(options.dataFields?.month_key || ""),
        receiptNo: String(options.dataFields?.receipt_no || ""),
        score: Number(options.dataFields?.score) || undefined,
        maxScore: Number(options.dataFields?.max_score) || undefined,
        percentage: Number(options.dataFields?.percentage) || undefined,
        notes: String(options.dataFields?.notes || ""),
        examTitle: String(options.dataFields?.exam_title || ""),
        grade: String(options.dataFields?.grade || ""),
        days: String(options.dataFields?.days || ""),
        senderName: String(options.dataFields?.sender_name || ""),
        message: String(options.dataFields?.message || options.body),
        actionType: options.actionType,
        fcmToken: resolvedToken || undefined,
      },
      hlc,
      timestamp,
    }).catch(() => {});
  } catch (err) {
    console.warn("[FCM Dispatcher] Offline WAL queue note:", err);
  }

  return {
    success: true,
    actionType: options.actionType,
    studentBarcode: cleanBarcode,
    fcmToken: resolvedToken || undefined,
    eventId,
    timestamp,
    payload: fcmPayload,
  };
}

// ----------------------------------------------------------------------------
// HIGH-PRIORITY ACTION WRAPPERS FOR SUPERVISORS
// ----------------------------------------------------------------------------

/**
 * 1. Attendance: Present (`تسجيل حضور`)
 */
export async function triggerAttendancePresentNotification(
  student: Student | { barcode: string; name: string; parentPhone?: string },
  timeDisplay: string = new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }),
  dateKey: string = new Date().toISOString().slice(0, 10)
): Promise<FcmDispatchResult> {
  return await dispatchFcmPushNotification({
    actionType: "ATTENDANCE_PRESENT",
    studentBarcode: student.barcode,
    studentName: student.name,
    parentPhone: student.parentPhone,
    title: `✅ تسجيل حضور: ${student.name}`,
    body: `تم تسجيل وصول ودخول الطالب(ة) ${student.name} إلى القاعة بنجاح في تمام الساعة ${timeDisplay}.`,
    dataFields: {
      action_name: "تسجيل حضور",
      status: "حضور",
      time_display: timeDisplay,
      date_key: dateKey,
    },
  });
}

/**
 * 2. Attendance: Late (`تسجيل تأخير`)
 */
export async function triggerAttendanceLateNotification(
  student: Student | { barcode: string; name: string; parentPhone?: string },
  timeDisplay: string = new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }),
  dateKey: string = new Date().toISOString().slice(0, 10)
): Promise<FcmDispatchResult> {
  return await dispatchFcmPushNotification({
    actionType: "ATTENDANCE_LATE",
    studentBarcode: student.barcode,
    studentName: student.name,
    parentPhone: student.parentPhone,
    title: `🟡 تسجيل تأخير: ${student.name}`,
    body: `تم تسجيل دخول الطالب(ة) ${student.name} للقاعة متأخراً في تمام الساعة ${timeDisplay}.`,
    dataFields: {
      action_name: "تسجيل تأخير",
      status: "تأخير",
      time_display: timeDisplay,
      date_key: dateKey,
    },
  });
}

/**
 * 3. Attendance: Absence (`تسجيل غياب`)
 */
export async function triggerAttendanceAbsentNotification(
  student: Student | { barcode: string; name: string; parentPhone?: string },
  dateKey: string = new Date().toISOString().slice(0, 10)
): Promise<FcmDispatchResult> {
  return await dispatchFcmPushNotification({
    actionType: "ATTENDANCE_ABSENT",
    studentBarcode: student.barcode,
    studentName: student.name,
    parentPhone: student.parentPhone,
    title: `🔴 إشعار غياب: ${student.name}`,
    body: `نحيطكم علماً بغياب الطالب(ة) ${student.name} عن الحصة المقررة اليوم بتاريخ ${dateKey}. يرجى المتابعة والاطمئنان.`,
    dataFields: {
      action_name: "تسجيل غياب",
      status: "غياب",
      date_key: dateKey,
    },
  });
}

/**
 * 4. Academic: New Exam Grade (`إضافة درجة`)
 */
export async function triggerExamGradeNotification(
  student: Student | { barcode: string; name: string; parentPhone?: string },
  examTitle: string,
  score: number,
  maxScore: number,
  dateKey: string = new Date().toISOString().slice(0, 10)
): Promise<FcmDispatchResult> {
  const percentage = Math.round((score / maxScore) * 100);
  let statusEval = "ممتاز جداً 🌟";
  if (percentage < 60) {
    statusEval = "تحذير: يحتاج متابعة ومذاكرة ⚠️";
  } else if (percentage < 80) {
    statusEval = "جيد 👍 ونتطلع للمزيد";
  }

  return await dispatchFcmPushNotification({
    actionType: "EXAM_GRADE",
    studentBarcode: student.barcode,
    studentName: student.name,
    parentPhone: student.parentPhone,
    title: `📊 نتيجة اختبار: ${student.name}`,
    body: `تم رصد درجة الطالب(ة) ${student.name} في (${examTitle}): ${score} من ${maxScore} (${percentage}%). التقييم: ${statusEval}.`,
    dataFields: {
      action_name: "إضافة درجة",
      exam_title: examTitle,
      score: String(score),
      max_score: String(maxScore),
      percentage: String(percentage),
      date_key: dateKey,
    },
  });
}

/**
 * 5. Academic: Homework Status Update (`ملاحظات الواجب`)
 */
export async function triggerHomeworkStatusNotification(
  student: Student | { barcode: string; name: string; parentPhone?: string },
  status: "done" | "incomplete" | "not_done",
  notes?: string,
  dateKey: string = new Date().toISOString().slice(0, 10)
): Promise<FcmDispatchResult> {
  const isDone = status === "done";
  const isIncomplete = status === "incomplete";

  const title = isDone
    ? `📝 تسليم واجب ممتاز: ${student.name}`
    : isIncomplete
    ? `⚠️ تقصير في الواجب: ${student.name}`
    : `⛔ عدم تسليم الواجب: ${student.name}`;

  const body = isDone
    ? `تم فحص وتأكيد تسليم الواجب المنزلي كاملاً ومتقناً للطالب(ة) ${student.name}.`
    : isIncomplete
    ? `تنبيه منصة: تم تسليم جزء من الواجب فقط للطالب(ة) ${student.name} (${notes || "حل غير مكتمل"})، يرجى المتابعة.`
    : `تنبيه عاجل: لم يقم الطالب(ة) ${student.name} بتسليم الواجب المنزلي المطلوب اليوم.`;

  return await dispatchFcmPushNotification({
    actionType: "HOMEWORK_STATUS",
    studentBarcode: student.barcode,
    studentName: student.name,
    parentPhone: student.parentPhone,
    title,
    body,
    dataFields: {
      action_name: "ملاحظات الواجب",
      status,
      notes: notes || "",
      date_key: dateKey,
    },
  });
}

/**
 * 6. Financial: Monthly Subscription Receipt (`دفعة اشتراك شهر`)
 */
export async function triggerPaymentReceiptNotification(
  student: Student | { barcode: string; name: string; parentPhone?: string },
  amount: number,
  monthKey: string,
  date: string = new Date().toISOString().slice(0, 10),
  receiptNo?: string
): Promise<FcmDispatchResult> {
  const receiptStr = receiptNo ? `رقم الإيصال #${receiptNo}` : "";
  return await dispatchFcmPushNotification({
    actionType: "PAYMENT_RECEIPT",
    studentBarcode: student.barcode,
    studentName: student.name,
    parentPhone: student.parentPhone,
    title: `💰 إيصال سداد اشتراك: ${student.name}`,
    body: `تم استلام سداد اشتراك شهر (${monthKey}) بمبلغ ${amount} ج.م للطالب(ة) ${student.name} بنجاح. ${receiptStr}`,
    dataFields: {
      action_name: "دفعة اشتراك شهر",
      amount: String(amount),
      month_key: monthKey,
      receipt_no: receiptNo || "",
      date,
    },
  });
}

/**
 * 7. Profile & System: Student Data Update (`تعديل بيانات الطالب`)
 */
export async function triggerProfileUpdateNotification(
  student: Student,
  summaryNotes?: string
): Promise<FcmDispatchResult> {
  const notesStr = summaryNotes ? ` - ملاحظات: ${summaryNotes}` : "";
  return await dispatchFcmPushNotification({
    actionType: "PROFILE_UPDATE",
    studentBarcode: student.barcode,
    studentName: student.name,
    parentPhone: student.parentPhone,
    title: `✏️ تعديل بيانات الطالب: ${student.name}`,
    body: `تم تحديث البيانات الأكاديمية للطالب(ة) ${student.name} في المنظومة (الصف: ${student.groupGrade} - المواعيد: ${student.groupDays})${notesStr}.`,
    dataFields: {
      action_name: "تعديل بيانات الطالب",
      grade: student.groupGrade,
      days: student.groupDays,
      phone: student.phone || "",
      parent_phone: student.parentPhone || "",
    },
  });
}

/**
 * 8. Messaging: Supervisor Chat Reply (`رسالة جديدة`)
 */
export async function triggerSupervisorChatNotification(
  student: Student | { barcode: string; name: string; parentPhone?: string },
  messageText: string,
  supervisorName: string = "إشراف المنظومة"
): Promise<FcmDispatchResult> {
  const preview = messageText.length > 100 ? `${messageText.slice(0, 97)}...` : messageText;
  return await dispatchFcmPushNotification({
    actionType: "SUPERVISOR_CHAT",
    studentBarcode: student.barcode,
    studentName: student.name,
    parentPhone: student.parentPhone,
    title: `💬 رسالة جديدة من الإشراف (${supervisorName})`,
    body: `${student.name}: ${preview}`,
    dataFields: {
      action_name: "رسالة جديدة",
      sender_name: supervisorName,
      message: messageText,
    },
  });
}
