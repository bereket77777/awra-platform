import { useCallback, useEffect, useRef, useState } from "react";
import AwraButton from "../components/AwraButton.jsx";
import PracticeScreen from "../features/voice-session/PracticeScreen.jsx";
import supabase from "../lib/supabase.js";

/**
 * AWRA — this pass fixes (see chat for the full writeup):
 *
 *  - Auth state is no longer disconnected from call state: if `user` ever
 *    becomes null (explicit sign-out, a failed background token refresh,
 *    another tab signing out) while a call session is alive, it is now
 *    torn down instead of running on in the background behind the login
 *    screen.
 *  - ICE "disconnected" recovery now actually works: an `onnegotiationneeded`
 *    handler creates/sends a fresh offer, so `restartIce()` has something to
 *    trigger. Previously `restartIce()` was called but nothing ever acted on
 *    it, so the recovery path was a no-op.
 *  - A dropped/absent partner no longer gets silently treated as "connected."
 *    The call only flips to the connected state (and starts the 10-minute
 *    timer) once the partner is actually confirmed present in the room; a
 *    partner-join timeout ends the call with a clear message if nobody shows.
 *  - New "connecting" UI state between "searching" and "connected" so the
 *    person gets feedback while mic permission / room signaling is in
 *    flight, instead of "Searching…" silently continuing to mean two
 *    different things.
 *  - Session timeouts are now tracked generically (session.timeouts) instead
 *    of as four separately-named, easy-to-forget fields.
 *  - Shared AwraButton component replaces repeated Tailwind class strings.
 *  - Guest / Advisor / School / VIP entry is temporarily disabled in the UI.
 *    TODO: Re-enable guest flow when the standard auth flow is ready.
 *
 * Carried over from the previous pass, still true:
 *  - TURN support reads VITE_TURN_* env vars — set these to a real TURN
 *    provider before relying on this off of trusted networks.
 *  - Matchmaking uses a propose/accept handshake (lowest waiting id
 *    proposes; the target must accept) to avoid split-pairing races. It is
 *    still client-coordinated, not server-arbitrated — a fully bulletproof
 *    version needs a server-side authority (Postgres row locks or an Edge
 *    Function) owning the waiting queue.
 *  - Not fixed here (needs infra/backend): private/RLS-gated Realtime
 *    channels, a true server-authoritative matchmaking queue, safety
 *    tooling (report/block), level-aware matching.
 */

const speakingTopics = [
  "What is a small habit that has made a meaningful difference in your life?",
  "Describe a moment that changed the way you see an everyday problem.",
  "If you could improve one thing in your community, what would it be and why?",
  "Tell about a person who has influenced you, even if you have never met them.",
  "What skill would you like to learn, and how would it change your routine?",
  "When was the last time you changed your mind about something important?",
  "What does a fulfilling day look like to you?",
  "Describe a tradition or experience you would want to share with someone else.",
];

/* TODO: Re-enable guest flow: restore VIP ID validation via VITE_VIP_IDS.
const VALID_VIP_IDS = new Set(
  (import.meta.env.VITE_VIP_IDS || "")
    .split(",")
    .map((id) => id.trim().toUpperCase())
    .filter(Boolean),
);
*/

// TURN is optional at the env level but effectively required in production:
// STUN alone cannot traverse symmetric NAT / many campus firewalls, which is
// exactly the network environment your target users are on.
const turnUrl = import.meta.env.VITE_TURN_URL;
const turnUsername = import.meta.env.VITE_TURN_USERNAME;
const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
if (turnUrl && turnUsername && turnCredential) {
  iceServers.push({ urls: turnUrl, username: turnUsername, credential: turnCredential });
}

const rtcConfiguration = { iceServers, iceCandidatePoolSize: 4 };

const MATCH_PROPOSAL_TIMEOUT_MS = 4000;
const SEARCH_TIMEOUT_MS = 45000;
const ICE_DISCONNECT_GRACE_MS = 2500;
const PARTNER_JOIN_TIMEOUT_MS = 10000;
const AUTH_SESSION_TIMEOUT_MS = 10000;

const EMPTY_ACTIVITY_DATA = { days: {} };

function getActivityStorageKey(userId) {
  return `awra_activity_${userId}`;
}

function getLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readActivityData(userId) {
  try {
    const stored = window.localStorage.getItem(getActivityStorageKey(userId));
    if (!stored) return EMPTY_ACTIVITY_DATA;

    const data = JSON.parse(stored);
    if (
      !data ||
      !data.days ||
      typeof data.days !== "object" ||
      Array.isArray(data.days)
    ) {
      throw new Error("Stored practice activity has an invalid format.");
    }
    return { days: data.days };
  } catch (error) {
    logError("activity-storage-read", error);
    return EMPTY_ACTIVITY_DATA;
  }
}

function writeActivityData(userId, data) {
  try {
    window.localStorage.setItem(getActivityStorageKey(userId), JSON.stringify(data));
  } catch (error) {
    logError("activity-storage-write", error);
  }
}

function addActivitySeconds(data, timestamp, durationSeconds) {
  const days = { ...data.days };
  let cursor = timestamp;
  let remaining = durationSeconds;

  while (remaining > 0) {
    const date = new Date(cursor);
    const dateKey = getLocalDateKey(date);
    const nextMidnight = new Date(date);
    nextMidnight.setHours(24, 0, 0, 0);
    const secondsInDate = Math.max(1, Math.ceil((nextMidnight.getTime() - cursor) / 1000));
    const seconds = Math.min(remaining, secondsInDate);
    const day = days[dateKey] || { seconds: 0, sessions: 0 };
    days[dateKey] = { ...day, seconds: day.seconds + seconds };
    cursor += seconds * 1000;
    remaining -= seconds;
  }

  return { ...data, days };
}

// Centralized seam for real telemetry later. Replace the console.error with
// Sentry.captureException / PostHog capture / etc. when you wire one up.
function logError(context, error) {
  console.error(`[AWRA:${context}]`, error);
}

/* TODO: Re-enable guest flow: restore anonymous guest ID generation.
function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `user-${Date.now()}-${Math.random()}`;
}

function getOrCreateGuestId() {
  try {
    const stored = window.localStorage.getItem("awra_guest_id");
    if (stored) return stored;
    const id = makeId();
    window.localStorage.setItem("awra_guest_id", id);
    return id;
  } catch (error) {
    logError("guest-id-storage", error);
    return makeId();
  }
}
*/

function removeChannel(channel) {
  if (channel && supabase) void supabase.removeChannel(channel);
}

async function sendChannelEvent(channel, subscribed, event, payload) {
  if (!channel || !subscribed) return false;
  try {
    const result = await channel.send({ type: "broadcast", event, payload });
    return result === "ok";
  } catch (error) {
    logError(`send-${event}`, error);
    return false;
  }
}

async function sendRoomEvent(session, event, payload) {
  return sendChannelEvent(session.roomChannel, session.roomSubscribed, event, payload);
}

async function sendLobbyEvent(session, event, payload) {
  return sendChannelEvent(session.lobbyChannel, session.lobbySubscribed, event, payload);
}

function enqueueSignal(session, task) {
  const queued = session.signalQueue.then(() => {
    if (session.disposed) return;
    return task();
  });
  session.signalQueue = queued.catch((error) => {
    logError("signal-queue", error);
  });
  return session.signalQueue;
}

// --- Generic per-session timeout tracking --------------------------------
function createCallSession(userId, initialTopic) {
  return {
    userId,
    currentTopic: initialTopic,
    pendingLocalCandidates: [],
    pendingRemoteCandidates: [],
    signalQueue: Promise.resolve(),
    offerSent: false,
    roomSubscribed: false,
    lobbySubscribed: false,
    partnerSeen: false,
    matchState: "waiting", // "waiting" | "proposed" | "matched"
    proposedPartner: null,
    proposedRoomId: null,
    partnerUserId: null,
    roomId: null,
    disposed: false,
    lobbyChannel: null,
    roomChannel: null,
    localStream: null,
    peerConnection: null,
    timeouts: {},
  };
}

function setSessionTimeout(session, key, callback, ms) {
  clearSessionTimeout(session, key);
  session.timeouts[key] = window.setTimeout(() => {
    session.timeouts[key] = null;
    callback();
  }, ms);
}

function clearSessionTimeout(session, key) {
  if (session.timeouts[key]) {
    window.clearTimeout(session.timeouts[key]);
    session.timeouts[key] = null;
  }
}

function clearAllSessionTimeouts(session) {
  Object.keys(session.timeouts).forEach((key) => clearSessionTimeout(session, key));
}

function disposeSession(session, audioRef) {
  if (!session || session.disposed) return;
  session.disposed = true;
  clearAllSessionTimeouts(session);

  if (session.peerConnection) {
    session.peerConnection.onicecandidate = null;
    session.peerConnection.ontrack = null;
    session.peerConnection.onconnectionstatechange = null;
    session.peerConnection.onnegotiationneeded = null;
    session.peerConnection.close();
  }
  session.localStream?.getTracks().forEach((track) => track.stop());
  if (audioRef.current) audioRef.current.srcObject = null;
  removeChannel(session.lobbyChannel);
  removeChannel(session.roomChannel);
}

export default function App() {
  // Auth state
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(Boolean(supabase));
  const [profile, setProfile] = useState(null);
  const [profileUserId, setProfileUserId] = useState(null);
  const [profileError, setProfileError] = useState("");
  const [activitySummary, setActivitySummary] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [notificationError, setNotificationError] = useState("");
  const [notificationPendingIds, setNotificationPendingIds] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [pendingTaskIds, setPendingTaskIds] = useState([]);
  const [authMode, setAuthMode] = useState("signin"); // "signin" | "signup"
  const [fullName, setFullName] = useState("");
  const [englishLevel, setEnglishLevel] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const activitySummaryUserIdRef = useRef(null);

  function resetUserScopedState(userId = null) {
    activitySummaryUserIdRef.current = userId;
    setActivitySummary(null);
    setNotifications([]);
    setNotificationError("");
    setNotificationPendingIds([]);
    setTasks([]);
    setTasksLoading(Boolean(userId));
    setTaskError("");
    setTaskTitle("");
    setTaskSubmitting(false);
    setPendingTaskIds([]);

    if (!userId) {
      setProfile(null);
      setProfileUserId(null);
      setProfileError("");
    }
  }

  const refreshNotifications = useCallback(async (userId) => {
    if (!userId || !supabase) return;
    try {
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      if (activitySummaryUserIdRef.current === userId) {
        setNotifications(data ?? []);
        setNotificationError("");
      }
    } catch (error) {
      if (activitySummaryUserIdRef.current === userId) {
        logError("notifications-fetch", error);
        setNotificationError("Unable to load notifications. Please try again.");
      }
    }
  }, []);

  const handleSessionFinished = useCallback(
    (updatedSummary, summaryUserId = activitySummaryUserIdRef.current) => {
      if (!summaryUserId || summaryUserId !== activitySummaryUserIdRef.current) return;
      if (updatedSummary) setActivitySummary(updatedSummary);
      void refreshNotifications(summaryUserId);
    },
    [refreshNotifications],
  );

  /* TODO: Re-enable guest flow: restore guest position and VIP form state.
  const [showGuestForm, setShowGuestForm] = useState(false);
  const [advisorPositionInput, setAdvisorPositionInput] = useState("");
  const [vipIdInput, setVipIdInput] = useState("");
  const [advisorPosition, setAdvisorPosition] = useState(null);
  */

  // Call & practice state
  const [callState, setCallState] = useState("idle"); // "idle" | "searching" | "connecting" | "connected"
  const [remainingSeconds, setRemainingSeconds] = useState(600);
  const [currentTopic, setCurrentTopic] = useState(speakingTopics[0]);
  const [muted, setMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const audioRef = useRef(null);
  const sessionRef = useRef(null);
  const activeSessionIdRef = useRef(null);
  const sessionStartedAtRef = useRef(null);
  const isFinalizingRef = useRef(false);

  const user = session?.user ?? null;
  const activeUserId = user?.id ?? null;
  const activeProfile = profileUserId === activeUserId ? profile : null;
  const activeProfileError = profileUserId === activeUserId ? profileError : "";
  const [activityData, setActivityData] = useState(EMPTY_ACTIVITY_DATA);
  const activityDataRef = useRef(activityData);

  const updateActivityData = useCallback((nextData) => {
    activityDataRef.current = nextData;
    setActivityData(nextData);
    if (activeUserId) writeActivityData(activeUserId, nextData);
  }, [activeUserId]);

  useEffect(() => {
    const storedActivity = activeUserId ? readActivityData(activeUserId) : EMPTY_ACTIVITY_DATA;
    activityDataRef.current = storedActivity;
    setActivityData(storedActivity);
  }, [activeUserId]);

  // Keep the auth callback synchronous; load profile data in a separate effect.
  useEffect(() => {
    if (!supabase) {
      return undefined;
    }

    let active = true;
    let authEventReceived = false;
    let sessionTimeoutId = null;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      authEventReceived = true;
      setSession(nextSession);
      const nextUserId = nextSession?.user?.id ?? null;
      if (activitySummaryUserIdRef.current !== nextUserId || !nextUserId) {
        resetUserScopedState(nextUserId);
      }
      setAuthError("");
    });

    async function loadSession() {
      try {
        const { data, error } = await Promise.race([
          supabase.auth.getSession(),
          new Promise((_, reject) => {
            sessionTimeoutId = window.setTimeout(() => {
              reject(new Error("Timed out while checking your session. Please try again."));
            }, AUTH_SESSION_TIMEOUT_MS);
          }),
        ]);
        if (error) throw error;
        if (active && !authEventReceived) {
          activitySummaryUserIdRef.current = data.session?.user?.id ?? null;
          setSession(data.session);
        }
      } catch (error) {
        if (active) logError("get-session", error);
        if (active && !authEventReceived) {
          activitySummaryUserIdRef.current = null;
          setSession(null);
          setAuthError(error?.message || "Unable to load your session. Please try again.");
        }
      } finally {
        if (sessionTimeoutId !== null) {
          window.clearTimeout(sessionTimeoutId);
          sessionTimeoutId = null;
        }
        if (active) setAuthLoading(false);
      }
    }

    void loadSession();
    return () => {
      active = false;
      if (sessionTimeoutId !== null) window.clearTimeout(sessionTimeoutId);
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    setProfile(null);
    setProfileError("");
    if (!activeUserId || !supabase) {
      setProfileUserId(null);
      return undefined;
    }

    async function loadProfile() {
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", activeUserId)
          .maybeSingle();
        if (error) throw error;
        if (!cancelled) {
          if (!data) {
            logError("profile-fetch", new Error(`No profile row found for user ${activeUserId}.`));
            setProfile(null);
            setProfileUserId(activeUserId);
            setProfileError("");
            return;
          }
          setProfile(data);
          setProfileUserId(activeUserId);
          setProfileError("");
        }
      } catch (error) {
        if (!cancelled) {
          logError("profile-fetch", error);
          setProfile(null);
          setProfileUserId(activeUserId);
          setProfileError(error?.message || "Unable to load your profile.");
        }
      }
    }

    void loadProfile();
    return () => {
      cancelled = true;
    };
  }, [activeUserId]);

  useEffect(() => {
    let cancelled = false;
    if (!activeUserId || !supabase) {
      setTasks([]);
      setTasksLoading(false);
      return undefined;
    }

    setTasksLoading(true);
    async function loadTasks() {
      try {
        const { data, error } = await supabase
          .from("tasks")
          .select("*")
          .order("is_completed", { ascending: true })
          .order("created_at", { ascending: false });
        if (error) throw error;
        if (!cancelled) {
          setTasks(data ?? []);
          setTaskError("");
        }
      } catch (error) {
        if (!cancelled) {
          logError("tasks-fetch", error);
          setTaskError("Unable to load tasks. Please try again.");
        }
      } finally {
        if (!cancelled) setTasksLoading(false);
      }
    }

    void loadTasks();
    return () => {
      cancelled = true;
    };
  }, [activeUserId]);

  useEffect(() => {
    if (activeUserId) void refreshNotifications(activeUserId);
  }, [activeUserId, refreshNotifications]);

  useEffect(() => {
    let cancelled = false;

    if (!activeUserId || !supabase) {
      return () => {
        cancelled = true;
      };
    }

    async function loadActivitySummary() {
      try {
        const { data, error } = await supabase.rpc("get_activity_summary");
        if (error) throw error;
        if (!cancelled && activitySummaryUserIdRef.current === activeUserId) {
          setActivitySummary(data);
        }
      } catch (error) {
        if (!cancelled) logError("activity-summary-fetch", error);
      }
    }

    void loadActivitySummary();
    return () => {
      cancelled = true;
    };
  }, [activeUserId]);

  async function addTask(event) {
    event.preventDefault();
    const trimmedTitle = taskTitle.trim();
    if (!trimmedTitle || taskSubmitting) return;
    if (!activeUserId || !supabase) {
      setTaskError("Sign in to add a task.");
      return;
    }

    setTaskSubmitting(true);
    setTaskError("");
    try {
      const { data, error } = await supabase
        .from("tasks")
        .insert({ user_id: activeUserId, title: trimmedTitle })
        .select("*")
        .single();
      if (error) throw error;
      if (activitySummaryUserIdRef.current === activeUserId) {
        setTasks((currentTasks) => [data, ...currentTasks]);
        setTaskTitle("");
      }
    } catch (error) {
      logError("task-add", error);
      if (activitySummaryUserIdRef.current === activeUserId) {
        setTaskError("Unable to add this task. Please try again.");
      }
    } finally {
      if (activitySummaryUserIdRef.current === activeUserId) setTaskSubmitting(false);
    }
  }

  function setTaskPending(taskId, pending) {
    setPendingTaskIds((currentIds) => (
      pending
        ? currentIds.includes(taskId) ? currentIds : [...currentIds, taskId]
        : currentIds.filter((id) => id !== taskId)
    ));
  }

  async function toggleTaskCompletion(taskId) {
    const task = tasks.find((item) => item.id === taskId);
    if (!activeUserId || !supabase || !task || pendingTaskIds.includes(taskId)) return;

    const nextCompleted = !task.is_completed;
    const nextCompletedAt = nextCompleted ? new Date().toISOString() : null;
    setTaskPending(taskId, true);
    setTaskError("");
    setTasks((currentTasks) => currentTasks.map((item) => (
      item.id === taskId
        ? { ...item, is_completed: nextCompleted, completed_at: nextCompletedAt }
        : item
    )));

    try {
      const { error } = await supabase
        .from("tasks")
        .update({
          is_completed: nextCompleted,
          completed_at: nextCompletedAt,
        })
        .eq("id", taskId)
        .eq("user_id", activeUserId);
      if (error) throw error;
    } catch (error) {
      logError("task-toggle", error);
      if (activitySummaryUserIdRef.current === activeUserId) {
        setTasks((currentTasks) => currentTasks.map((item) => (
          item.id === taskId
            ? {
                ...item,
                is_completed: task.is_completed,
                completed_at: task.completed_at,
              }
            : item
        )));
        setTaskError("Unable to update this task. Please try again.");
      }
    } finally {
      if (activitySummaryUserIdRef.current === activeUserId) setTaskPending(taskId, false);
    }
  }

  async function deleteTask(taskId) {
    if (!activeUserId || !supabase || pendingTaskIds.includes(taskId)) return;
    setTaskPending(taskId, true);
    setTaskError("");
    try {
      const { error } = await supabase
        .from("tasks")
        .delete()
        .eq("id", taskId)
        .eq("user_id", activeUserId);
      if (error) throw error;
      if (activitySummaryUserIdRef.current === activeUserId) {
        setTasks((currentTasks) => currentTasks.filter((task) => task.id !== taskId));
      }
    } catch (error) {
      logError("task-delete", error);
      if (activitySummaryUserIdRef.current === activeUserId) {
        setTaskError("Unable to delete this task. Please try again.");
      }
    } finally {
      if (activitySummaryUserIdRef.current === activeUserId) setTaskPending(taskId, false);
    }
  }

  async function markNotificationRead(notificationId) {
    const notification = notifications.find((item) => item.id === notificationId);
    if (
      !activeUserId ||
      !supabase ||
      !notification ||
      notification.read_at ||
      notificationPendingIds.includes(notificationId)
    ) {
      return;
    }

    const readAt = new Date().toISOString();
    setNotificationPendingIds((currentIds) => [...currentIds, notificationId]);
    setNotificationError("");
    setNotifications((currentItems) => currentItems.map((item) => (
      item.id === notificationId ? { ...item, read_at: readAt } : item
    )));

    try {
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: readAt })
        .eq("id", notificationId)
        .eq("user_id", activeUserId)
        .is("read_at", null);
      if (error) throw error;
    } catch (error) {
      logError("notification-read", error);
      if (activitySummaryUserIdRef.current === activeUserId) {
        setNotifications((currentItems) => currentItems.map((item) => (
          item.id === notificationId && item.read_at === readAt
            ? { ...item, read_at: notification.read_at }
            : item
        )));
        setNotificationError("Unable to update this notification.");
      }
    } finally {
      if (activitySummaryUserIdRef.current === activeUserId) {
        setNotificationPendingIds((currentIds) => currentIds.filter((id) => id !== notificationId));
      }
    }
  }

  async function markAllNotificationsRead() {
    if (!activeUserId || !supabase || notifications.every((item) => item.read_at)) return;
    const unreadIds = notifications.filter((item) => !item.read_at).map((item) => item.id);
    const readAt = new Date().toISOString();
    setNotificationError("");
    setNotificationPendingIds((currentIds) => [...new Set([...currentIds, ...unreadIds])]);
    setNotifications((currentItems) => currentItems.map((item) => (
      item.read_at ? item : { ...item, read_at: readAt }
    )));

    try {
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: readAt })
        .eq("user_id", activeUserId)
        .is("read_at", null);
      if (error) throw error;
    } catch (error) {
      logError("notifications-read-all", error);
      if (activitySummaryUserIdRef.current === activeUserId) {
        setNotifications((currentItems) => currentItems.map((item) => (
          unreadIds.includes(item.id) && item.read_at === readAt
            ? { ...item, read_at: null }
            : item
        )));
        setNotificationError("Unable to update notifications.");
      }
    } finally {
      if (activitySummaryUserIdRef.current === activeUserId) {
        setNotificationPendingIds((currentIds) => currentIds.filter((id) => !unreadIds.includes(id)));
      }
    }
  }

  function startSpeakingSession(callSession) {
    if (
      !callSession ||
      callSession.speakingSessionInsertAttempted ||
      activeSessionIdRef.current ||
      isFinalizingRef.current ||
      !callSession.userId ||
      !supabase
    ) {
      return callSession?.speakingSessionStartPromise ?? null;
    }

    callSession.speakingSessionInsertAttempted = true;
    callSession.speakingSessionStartedAt = Date.now();
    sessionStartedAtRef.current = callSession.speakingSessionStartedAt;
    callSession.speakingSessionStartPromise = (async () => {
      try {
        const { data, error } = await supabase
          .from("speaking_sessions")
          .insert({
            user_id: callSession.userId,
            partner_id: callSession.partnerUserId ?? null,
            prompt_text: callSession.currentTopic ?? null,
            status: "active",
            target_seconds: 600,
            duration_seconds: 0,
          })
          .select("id")
          .single();
        if (error) throw error;

        callSession.speakingSessionId = data.id;
        activeSessionIdRef.current = data.id;
        return data.id;
      } catch (error) {
        logError("speaking-session-start", error);
        return null;
      }
    })();

    return callSession.speakingSessionStartPromise;
  }

  const finalizeSession = useCallback(async (endStatus, callSession = sessionRef.current) => {
    if (!callSession) return Promise.resolve(null);
    if (callSession.speakingSessionFinalizationPromise) {
      return callSession.speakingSessionFinalizationPromise;
    }
    if (
      !callSession.speakingSessionInsertAttempted &&
      !callSession.speakingSessionId &&
      !activeSessionIdRef.current
    ) {
      return Promise.resolve(null);
    }
    if (isFinalizingRef.current) return Promise.resolve(null);

    isFinalizingRef.current = true;
    callSession.speakingSessionFinalizationPromise = (async () => {
      let sessionId = null;
      try {
        sessionId =
          callSession.speakingSessionId ??
          (await callSession.speakingSessionStartPromise) ??
          activeSessionIdRef.current;
        if (!sessionId || !supabase) return null;

        const startedAt = callSession.speakingSessionStartedAt ?? sessionStartedAtRef.current;
        const elapsedSeconds = startedAt
          ? Math.min(600, Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
          : 0;
        const { data, error } = await supabase.rpc("finish_speaking_session", {
          p_session_id: sessionId,
          p_duration_seconds: elapsedSeconds,
          p_status: endStatus,
        });
        if (error) throw error;
        handleSessionFinished(data, callSession.userId);
        return data;
      } catch (error) {
        logError("speaking-session-finish", error);
        return null;
      } finally {
        if (activeSessionIdRef.current === sessionId) activeSessionIdRef.current = null;
        if (sessionStartedAtRef.current === callSession.speakingSessionStartedAt) {
          sessionStartedAtRef.current = null;
        }
        isFinalizingRef.current = false;
      }
    })();

    return callSession.speakingSessionFinalizationPromise;
  }, [handleSessionFinished]);

  const finishCall = useCallback((message = "", endStatusOverride = null) => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session?.speakingSessionInsertAttempted || session?.speakingSessionId) {
      const elapsedSeconds = session.speakingSessionStartedAt
        ? Math.min(
            600,
            Math.max(0, Math.round((Date.now() - session.speakingSessionStartedAt) / 1000)),
          )
        : 0;
      const endStatus = endStatusOverride ?? (elapsedSeconds >= 600 ? "completed" : "cancelled");
      void finalizeSession(endStatus, session);
    }
    if (session?.practiceStartedAt && !session.activityRecorded) {
      session.activityRecorded = true;
      const durationSeconds = Math.min(
        600,
        Math.floor((Date.now() - session.practiceStartedAt) / 1000),
      );
      if (durationSeconds > 0) {
        let nextData = activityDataRef.current;
        const unrecordedSeconds = durationSeconds - (session.activityRecordedSeconds || 0);
        if (unrecordedSeconds > 0) {
          nextData = addActivitySeconds(
            nextData,
            session.practiceStartedAt + (session.activityRecordedSeconds || 0) * 1000,
            unrecordedSeconds,
          );
        }

        const startDateKey = getLocalDateKey(new Date(session.practiceStartedAt));
        const startDay = nextData.days[startDateKey] || { seconds: 0, sessions: 0 };
        const days = {
          ...nextData.days,
          [startDateKey]: { ...startDay, sessions: startDay.sessions + 1 },
        };
        updateActivityData({ ...nextData, days });
      }
    }
    disposeSession(session, audioRef);
    setCallState("idle");
    setRemainingSeconds(600);
    setMuted(false);
    setErrorMessage(message);
  }, [finalizeSession, updateActivityData]);

  function failSession(session, message, status = "disconnected") {
    if (!session || session.disposed || sessionRef.current !== session) return;
    finishCall(message, status);
  }

  useEffect(() => {
    const live = sessionRef.current;
    if (live && live.userId !== activeUserId) {
      finishCall("Your account changed, so your practice session ended.");
    }
  }, [activeUserId, finishCall]);

  async function handleAuthSubmit(event) {
    event.preventDefault();
    if (authSubmitting) return;
    setAuthError("");

    const trimmedEmail = email.trim();
    const trimmedFullName = fullName.trim();
    const isBlankPassword = password.trim().length === 0;

    if (!trimmedEmail || isBlankPassword) {
      setAuthError("Enter both your email and password.");
      return;
    }
    if (authMode === "signup") {
      if (!trimmedFullName) {
        setAuthError("Enter your name.");
        return;
      }
      if (!englishLevel) {
        setAuthError("Select your English speaking level.");
        return;
      }
      if (password.length < 6) {
        setAuthError("Password must be at least 6 characters.");
        return;
      }
    }
    if (!supabase) {
      setAuthError("Supabase is not configured. Please configure authentication to continue.");
      return;
    }

    setAuthSubmitting(true);
    try {
      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: trimmedEmail,
          password,
          options: {
            data: {
              display_name: trimmedFullName,
              full_name: trimmedFullName,
              english_level: englishLevel,
            },
          },
        });
        if (error) throw error;
        if (data.user && !data.session) {
          setAuthError("Account created. Check your email to confirm, then sign in.");
          setAuthMode("signin");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: trimmedEmail,
          password,
        });
        if (error) throw error;
      }
    } catch (error) {
      logError("auth-submit", error);
      setAuthError(error?.message || "Authentication failed. Please try again.");
    } finally {
      setAuthSubmitting(false);
    }
  }

  /* TODO: Re-enable guest flow: restore guest entry and VIP form submission.
  function continueAsGuest() {
    setAuthError("");
    // Only clear the inputs the first time the form opens — the trigger
    // button stays visible while the form is open, and re-clicking it
    // (e.g. after dismissing a VIP ID error) shouldn't wipe whatever the
    // person already typed.
    if (!showGuestForm) {
      setAdvisorPositionInput("");
      setVipIdInput("");
    }
    setShowGuestForm(true);
  }

  function handleGuestFormSubmit(event) {
    event.preventDefault();
    const trimmedPosition = advisorPositionInput.trim();
    const normalizedVipId = vipIdInput.trim().toUpperCase();
    const isVip = normalizedVipId ? VALID_VIP_IDS.has(normalizedVipId) : false;

    if (normalizedVipId && !isVip) {
      setAuthError("Invalid VIP ID. Leave blank to continue as a standard guest.");
      return;
    }

    setAuthError("");
    setShowGuestForm(false);
    setAdvisorPosition(trimmedPosition || null);
    setActiveUser({
      id: `${guestId}-guest`,
      email: "guest@awra.local",
      isGuest: true,
      user_metadata: {
        full_name: trimmedPosition || "Guest Speaker",
        english_level: "All Levels",
        badge: isVip ? "VIP" : null,
      },
    });
  }
  */

  async function handleSignOut() {
    finishCall();
    if (supabase && user) {
      try {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
      } catch (error) {
        logError("sign-out", error);
        setAuthError(error?.message || "Unable to sign out. Please try again.");
        return;
      }
    }
    setSession(null);
    resetUserScopedState();
    setAuthMode("signin");
    setFullName("");
    setEnglishLevel("");
    setEmail("");
    setPassword("");
    setAuthError("");
  }

  useEffect(() => {
    if (callState !== "connected") return undefined;

    const intervalId = window.setInterval(() => {
      setRemainingSeconds((seconds) => Math.max(seconds - 1, 0));
      const session = sessionRef.current;
      if (session?.practiceStartedAt) {
        const elapsedSeconds = Math.min(
          600,
          Math.floor((Date.now() - session.practiceStartedAt) / 1000),
        );
        const recordedSeconds = session.activityRecordedSeconds || 0;
        const unrecordedSeconds = elapsedSeconds - recordedSeconds;
        if (unrecordedSeconds >= 60) {
          updateActivityData(
            addActivitySeconds(
              activityDataRef.current,
              session.practiceStartedAt + recordedSeconds * 1000,
              unrecordedSeconds,
            ),
          );
          session.activityRecordedSeconds = elapsedSeconds;
        }
      }
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [callState, updateActivityData]);

  useEffect(() => {
    if (callState === "connected" && remainingSeconds === 0) {
      finishCall("Your 10-minute practice session has ended.", "completed");
    }
  }, [callState, remainingSeconds, finishCall]);

  useEffect(
    () => () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) void finalizeSession("disconnected", session);
      disposeSession(session, audioRef);
    },
    [finalizeSession],
  );

  const formattedTime = `${String(Math.floor(remainingSeconds / 60)).padStart(2, "0")}:${String(
    remainingSeconds % 60,
  ).padStart(2, "0")}`;

  async function startRoom(session, partnerUserId, roomId) {
    session.partnerUserId = partnerUserId;
    session.roomId = roomId;

    try {
      session.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      if (sessionRef.current !== session || session.disposed) {
        session.localStream.getTracks().forEach((track) => track.stop());
        return;
      }

      const peerConnection = new RTCPeerConnection(rtcConfiguration);
      session.peerConnection = peerConnection;
      session.localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, session.localStream);
      });

      peerConnection.ontrack = (event) => {
        if (!audioRef.current) return;
        audioRef.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audioRef.current.play().catch(() => { });
      };
      peerConnection.onicecandidate = (event) => {
        if (!event.candidate || session.disposed) return;
        const candidate = event.candidate.toJSON();
        if (!session.roomSubscribed) {
          session.pendingLocalCandidates.push(candidate);
        } else {
          void sendRoomEvent(session, "webrtc_ice_candidate", {
            userId: session.userId,
            candidate,
          });
        }
      };

      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        if (session.disposed) return;

        if (state === "connected" && session.partnerSeen) {
          void startSpeakingSession(session);
        }

        if (state === "disconnected") {
          setSessionTimeout(session, "iceDisconnect", () => {
            if (session.disposed) return;
            if (peerConnection.connectionState === "disconnected") {
              try {
                peerConnection.restartIce();
              } catch (error) {
                logError("ice-restart", error);
                failSession(session, "The voice connection was lost. Please try again.");
              }
            }
          }, ICE_DISCONNECT_GRACE_MS);
          return;
        }

        clearSessionTimeout(session, "iceDisconnect");

        if (state === "failed" || state === "closed") {
          failSession(session, "The voice connection failed. Please try again.");
        }
      };

      async function maybeNegotiate({ force = false } = {}) {
        if (session.disposed || sessionRef.current !== session) return;
        if (session.userId.localeCompare(partnerUserId) >= 0) return;
        if (!session.partnerSeen || !session.roomSubscribed) return;
        if (!force && session.offerSent) return;
        if (peerConnection.signalingState !== "stable") return;

        return enqueueSignal(session, async () => {
          if (session.disposed || sessionRef.current !== session) return;
          if (!session.partnerSeen || !session.roomSubscribed) return;
          if (!force && session.offerSent) return;
          if (peerConnection.signalingState !== "stable") return;

          session.offerSent = true;
          try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            const offerSent = await sendRoomEvent(session, "webrtc_offer", {
              userId: session.userId,
              description: peerConnection.localDescription.toJSON(),
            });
            const topicSent = await sendRoomEvent(session, "speaking_topic", {
              userId: session.userId,
              topic: session.currentTopic,
            });
            if (!offerSent || !topicSent) throw new Error("Unable to send room updates.");
          } catch (error) {
            logError("negotiation", error);
            failSession(session, "Couldn't establish the voice connection. Please try again.");
          }
        });
      }
      peerConnection.onnegotiationneeded = () => {
        void maybeNegotiate({ force: true });
      };

      const roomChannel = supabase.channel(`awra-room-${roomId}`, {
        config: {
          broadcast: { self: false },
          presence: { key: session.userId },
        },
      });
      session.roomChannel = roomChannel;

      async function applyRemoteDescription(description) {
        await peerConnection.setRemoteDescription(description);
        const candidates = session.pendingRemoteCandidates.splice(0);
        await Promise.all(candidates.map(addRemoteCandidate));
      }

      async function addRemoteCandidate(candidate) {
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
          logError("ice-candidate-handling", error);
        }
      }

      roomChannel
        .on("broadcast", { event: "webrtc_offer" }, ({ payload }) => {
          if (payload?.userId === session.userId || !payload?.description || session.disposed) return;
          void enqueueSignal(session, async () => {
            if (peerConnection.signalingState !== "stable") return;
            try {
              await applyRemoteDescription(payload.description);
              const answer = await peerConnection.createAnswer();
              await peerConnection.setLocalDescription(answer);
              const sent = await sendRoomEvent(session, "webrtc_answer", {
                userId: session.userId,
                description: peerConnection.localDescription.toJSON(),
              });
              if (!sent) throw new Error("Unable to send the answer.");
            } catch (error) {
              logError("webrtc-offer-handling", error);
              failSession(session, "Couldn't establish the voice connection. Please try again.");
            }
          });
        })
        .on("broadcast", { event: "webrtc_answer" }, ({ payload }) => {
          if (payload?.userId === session.userId || !payload?.description || session.disposed) return;
          void enqueueSignal(session, async () => {
            if (peerConnection.signalingState !== "have-local-offer") return;
            try {
              await applyRemoteDescription(payload.description);
              session.offerSent = false;
            } catch (error) {
              logError("webrtc-answer-handling", error);
              failSession(session, "Couldn't establish the voice connection. Please try again.");
            }
          });
        })
        .on("broadcast", { event: "webrtc_ice_candidate" }, ({ payload }) => {
          if (payload?.userId === session.userId || !payload?.candidate || session.disposed) return;
          void enqueueSignal(session, async () => {
            if (peerConnection.remoteDescription) {
              await addRemoteCandidate(payload.candidate);
            } else {
              session.pendingRemoteCandidates.push(payload.candidate);
            }
          });
        })
        .on("broadcast", { event: "speaking_topic" }, ({ payload }) => {
          if (payload?.userId === session.userId || !speakingTopics.includes(payload?.topic)) return;
          session.currentTopic = payload.topic;
          setCurrentTopic(payload.topic);
        })
        .on("presence", { event: "sync" }, () => {
          const participants = Object.values(roomChannel.presenceState()).flat();
          const partnerIsPresent = participants.some(
            (participant) => participant.userId === partnerUserId,
          );

          if (!partnerIsPresent) {
            if (session.partnerSeen) {
              failSession(session, "Your partner disconnected.");
            }
            return;
          }

          if (!session.partnerSeen) {
            session.partnerSeen = true;
            clearSessionTimeout(session, "partnerJoin");
            setCurrentTopic(session.currentTopic);
            setRemainingSeconds(600);
            session.practiceStartedAt = Date.now();
            session.activityRecordedSeconds = 0;
            setCallState("connected");
            if (peerConnection.connectionState === "connected") {
              void startSpeakingSession(session);
            }
          }

          void maybeNegotiate();
        });

      let initialSubscribeSettled = false;
      await new Promise((resolve, reject) => {
        roomChannel.subscribe((status) => {
          if (session.disposed) return;

          if (status === "SUBSCRIBED") {
            session.roomSubscribed = true;
            const candidates = session.pendingLocalCandidates.splice(0);
            candidates.forEach((candidate) => {
              void sendRoomEvent(session, "webrtc_ice_candidate", {
                userId: session.userId,
                candidate,
              });
            });
            if (!initialSubscribeSettled) {
              initialSubscribeSettled = true;
              resolve();
            }
            return;
          }

          if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
            session.roomSubscribed = false;
            if (!initialSubscribeSettled) {
              initialSubscribeSettled = true;
              reject(new Error("Room channel unavailable."));
            } else {
              logError("room-channel-dropped", new Error(`status=${status}`));
              failSession(session, "Lost connection to the voice service. Please try again.");
            }
          }
        });
      });
      if (sessionRef.current !== session || session.disposed) return;

      const trackStatus = await roomChannel.track({
        userId: session.userId,
      });
      if (trackStatus !== "ok") throw new Error("Unable to join the voice room.");

      removeChannel(session.lobbyChannel);
      session.lobbyChannel = null;

      setSessionTimeout(session, "partnerJoin", () => {
        if (sessionRef.current === session && !session.disposed && !session.partnerSeen) {
          failSession(session, "Your partner never joined. Please try again.");
        }
      }, PARTNER_JOIN_TIMEOUT_MS);
    } catch (error) {
      logError("start-room", error);
      const message =
        error?.name === "NotAllowedError" || error?.name === "SecurityError"
          ? "Microphone access was denied. Allow microphone access in your browser and try again."
          : error?.name === "NotFoundError"
            ? "No microphone was found. Connect a microphone and try again."
            : "Couldn't connect to the voice room. Please try again.";
      failSession(session, message);
    }
  }

  function evaluateMatch(session, lobbyChannel) {
    if (session.disposed || session.matchState !== "waiting") return;

    const waitingUsers = [
      ...new Set(
        Object.values(lobbyChannel.presenceState())
          .flat()
          .filter((presence) => presence.status === "waiting")
          .map((presence) => presence.userId),
      ),
    ].sort();

    if (waitingUsers.length < 2) return;
    if (waitingUsers[0] !== session.userId) return;

    const partnerUserId = waitingUsers[1];
    if (partnerUserId === session.userId) return;

    const roomId = `${[session.userId, partnerUserId].sort().join("-")}-${crypto.randomUUID()}`;
    session.matchState = "proposed";
    session.proposedPartner = partnerUserId;
    session.proposedRoomId = roomId;

    void sendLobbyEvent(session, "match_offer", {
      from: session.userId,
      to: partnerUserId,
      roomId,
    });

    setSessionTimeout(session, "propose", () => {
      if (session.disposed || session.matchState !== "proposed") return;
      session.matchState = "waiting";
      session.proposedPartner = null;
      session.proposedRoomId = null;
      evaluateMatch(session, lobbyChannel);
    }, MATCH_PROPOSAL_TIMEOUT_MS);
  }

  function startPractice() {
    setErrorMessage("");
    if (isFinalizingRef.current) {
      setErrorMessage("Finishing your previous session. Please try again in a moment.");
      return;
    }
    if (!activeUserId) {
      setErrorMessage("Sign in to start a practice session.");
      return;
    }
    if (!supabase) {
      setErrorMessage("Voice calling is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to continue.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.RTCPeerConnection) {
      setErrorMessage("Voice calling requires a browser with microphone and WebRTC support.");
      return;
    }

    const initialTopic = speakingTopics[Math.floor(Math.random() * speakingTopics.length)];
    const session = createCallSession(activeUserId, initialTopic);
    sessionRef.current = session;
    setCurrentTopic(initialTopic);
    setCallState("searching");

    setSessionTimeout(session, "search", () => {
      if (sessionRef.current === session && !session.disposed && session.matchState !== "matched") {
        finishCall("No one's available to practice with right now. Please try again in a bit.");
      }
    }, SEARCH_TIMEOUT_MS);

    const lobbyChannel = supabase.channel("awra-matchmaking", {
      config: { broadcast: { self: false }, presence: { key: activeUserId } },
    });
    session.lobbyChannel = lobbyChannel;

    function commitMatch(partnerUserId, roomId) {
      if (session.disposed || session.matchState === "matched") return;
      clearSessionTimeout(session, "propose");
      session.matchState = "matched";
      void lobbyChannel.track({
        userId: activeUserId,
        status: "matched",
      });
      setCallState("connecting");
      void startRoom(session, partnerUserId, roomId);
    }

    lobbyChannel
      .on("presence", { event: "sync" }, () => {
        evaluateMatch(session, lobbyChannel);
      })
      .on("broadcast", { event: "match_offer" }, ({ payload }) => {
        if (session.disposed || payload?.to !== session.userId || !payload?.from || !payload?.roomId) return;

        if (session.matchState !== "waiting") {
          void sendLobbyEvent(session, "match_busy", { from: session.userId, to: payload.from });
          return;
        }

        commitMatch(payload.from, payload.roomId);
        void sendLobbyEvent(session, "match_accept", { from: session.userId, to: payload.from });
      })
      .on("broadcast", { event: "match_accept" }, ({ payload }) => {
        if (
          session.disposed ||
          payload?.to !== session.userId ||
          session.matchState !== "proposed" ||
          payload?.from !== session.proposedPartner
        ) {
          return;
        }
        commitMatch(payload.from, session.proposedRoomId);
      })
      .on("broadcast", { event: "match_busy" }, ({ payload }) => {
        if (
          session.disposed ||
          payload?.to !== session.userId ||
          session.matchState !== "proposed" ||
          payload?.from !== session.proposedPartner
        ) {
          return;
        }
        clearSessionTimeout(session, "propose");
        session.matchState = "waiting";
        session.proposedPartner = null;
        session.proposedRoomId = null;
        evaluateMatch(session, lobbyChannel);
      });

    lobbyChannel.subscribe((status) => {
      if (session.disposed) return;
      if (status === "SUBSCRIBED") {
        session.lobbySubscribed = true;
        void lobbyChannel
          .track({ userId: activeUserId, status: "waiting" })
          .then((result) => {
            if (result !== "ok") {
              failSession(session, "Couldn't join the waiting room. Please try again.");
            }
          })
          .catch((error) => {
            logError("lobby-track", error);
            failSession(session, "Couldn't join the waiting room. Please try again.");
          });
      } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
        session.lobbySubscribed = false;
        if (session.matchState !== "matched") {
          failSession(session, "Couldn't connect to the voice service. Please try again.");
        }
      }
    });
  }

  function selectNewTopic() {
    const options = speakingTopics.filter((topic) => topic !== currentTopic);
    const topic = options[Math.floor(Math.random() * options.length)];
    const session = sessionRef.current;
    if (session) {
      session.currentTopic = topic;
      void sendRoomEvent(session, "speaking_topic", {
        userId: session.userId,
        topic,
      }).then((sent) => {
        if (!sent) logError("select-topic-send", new Error("speaking_topic broadcast failed"));
      });
    }
    setCurrentTopic(topic);
  }

  function toggleMute() {
    const nextMuted = !muted;
    const session = sessionRef.current;
    session?.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  }

  const displayName =
    activeProfile?.display_name ||
    user?.user_metadata?.display_name ||
    user?.user_metadata?.full_name ||
    user?.email?.split("@")[0] ||
    "Speaker";
  const userEnglishLevel = user?.user_metadata?.english_level;
  const isIdleDashboard = Boolean(user) && callState === "idle";
  const unreadCount = notifications.filter((notification) => !notification.read_at).length;

  return (
    <div className={`mx-auto flex min-h-dvh max-w-md flex-col bg-black px-5 text-white ${isIdleDashboard ? "pt-6" : "py-6"}`}>
      {!isIdleDashboard && (
        <header className="flex items-center justify-between border-b border-white/15 pb-4">
          <h1 className="text-xl font-semibold tracking-wide">AWRA</h1>
          {user && callState !== "idle" && (
            <div className="flex items-center gap-2.5">
              {/* TODO: Re-enable guest flow: restore VIP and advisor-position badges in the call header.
              {vipBadge && (
                <span className="rounded border border-white bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-black">
                  VIP
                </span>
              )}
              {advisorPosition && (
                <span className="max-w-[160px] truncate rounded border border-white/50 bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-white">
                  {advisorPosition}
                </span>
              )}
              */}
              <span className="max-w-[140px] truncate text-xs text-white/60">{displayName}</span>
              <button
                type="button"
                onClick={handleSignOut}
                className="rounded border border-white/25 px-2.5 py-1 text-xs text-white/80 transition-colors hover:border-white hover:text-white"
              >
                Sign Out
              </button>
            </div>
          )}
        </header>
      )}

      <main className={isIdleDashboard ? "flex min-h-0 flex-1 flex-col py-0" : "my-auto py-10"}>
        {authLoading ? (
          <p role="status" aria-live="polite" className="text-sm text-white/60">Loading...</p>
        ) : !user ? (
          <section
            className={callState === "idle" ? "flex min-h-0 flex-1 flex-col" : "space-y-6"}
            aria-live="polite"
          >
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold">
                {authMode === "signin" ? "Sign in to AWRA" : "Create your account"}
              </h2>
              <p className="text-sm text-white/70">
                {authMode === "signin"
                  ? "Practice spoken English in focused 10-minute sessions."
                  : "Join the peer-to-peer speaking community."}
              </p>
            </div>

            <form onSubmit={handleAuthSubmit} className="space-y-4">
              {authMode === "signup" && (
                <>
                  <div className="space-y-1.5">
                    <label htmlFor="fullName" className="block text-xs uppercase tracking-wider text-white/60">
                      Name
                    </label>
                    <input
                      id="fullName"
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Bereket"
                      className="w-full rounded-md border border-white/25 bg-black px-3.5 py-2.5 text-sm text-white placeholder-white/35 focus:border-white focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="englishLevel" className="block text-xs uppercase tracking-wider text-white/60">
                      English speaking level
                    </label>
                    <select
                      id="englishLevel"
                      value={englishLevel}
                      onChange={(e) => setEnglishLevel(e.target.value)}
                      className="w-full rounded-md border border-white/25 bg-black px-3.5 py-2.5 text-sm text-white focus:border-white focus:outline-none"
                    >
                      <option value="" disabled>
                        Select a level
                      </option>
                      <option value="Beginner">Beginner</option>
                      <option value="Intermediate">Intermediate</option>
                      <option value="Advanced">Advanced</option>
                    </select>
                  </div>
                </>
              )}

              <div className="space-y-1.5">
                <label htmlFor="email" className="block text-xs uppercase tracking-wider text-white/60">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-md border border-white/25 bg-black px-3.5 py-2.5 text-sm text-white placeholder-white/35 focus:border-white focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="password" className="block text-xs uppercase tracking-wider text-white/60">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete={authMode === "signin" ? "current-password" : "new-password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-md border border-white/25 bg-black px-3.5 py-2.5 text-sm text-white placeholder-white/35 focus:border-white focus:outline-none"
                />
              </div>

              {authError && (
                <p className="text-sm text-white/85" role="alert">
                  {authError}
                </p>
              )}

              <AwraButton type="submit" variant="primary" disabled={authSubmitting}>
                {authSubmitting
                  ? "Please wait..."
                  : authMode === "signin"
                    ? "Sign In"
                    : "Create Account"}
              </AwraButton>
            </form>

            <div className="space-y-3 border-t border-white/15 pt-4">
              <button
                type="button"
                disabled={authSubmitting}
                onClick={() => {
                  setAuthError("");
                  setPassword("");
                  setAuthMode(authMode === "signin" ? "signup" : "signin");
                }}
                className="w-full text-center text-sm text-white/70 underline-offset-4 hover:text-white hover:underline disabled:opacity-50"
              >
                {authMode === "signin"
                  ? "Need an account? Create one"
                  : "Already have an account? Sign in"}
              </button>

              {/* TODO: Re-enable guest flow: restore guest entry, position fields, VIP ID validation, and form.
              <button
                type="button"
                disabled={authSubmitting}
                onClick={continueAsGuest}
                className="w-full rounded-md border border-white/30 px-5 py-2.5 text-sm font-medium text-white/80 transition-colors hover:border-white hover:text-white disabled:opacity-50"
              >
                Continue as Guest
              </button>

              {showGuestForm && (
                <form onSubmit={handleGuestFormSubmit} className="space-y-3 pt-1">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="advisorPosition"
                      className="block text-xs uppercase tracking-wider text-white/60"
                    >
                      Position or school / company name
                    </label>
                    <input
                      id="advisorPosition"
                      type="text"
                      value={advisorPositionInput}
                      onChange={(e) => setAdvisorPositionInput(e.target.value)}
                      placeholder="e.g. Mentor, Instructor, or School Name"
                      autoComplete="off"
                      className="w-full rounded-md border border-white/25 bg-black px-3 py-2.5 text-sm text-white placeholder-white/35 focus:border-white focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="vipId"
                      className="block text-xs uppercase tracking-wider text-white/60"
                    >
                      VIP ID (optional)
                    </label>
                    <input
                      id="vipId"
                      type="text"
                      value={vipIdInput}
                      onChange={(e) => setVipIdInput(e.target.value)}
                      placeholder="e.g. AWRA-VIP-01"
                      autoComplete="off"
                      className="w-full rounded-md border border-white/25 bg-black px-3 py-2.5 text-sm uppercase tracking-wider text-white placeholder-white/35 focus:border-white focus:outline-none"
                    />
                  </div>

                  {authError && (
                    <p className="text-sm text-white/85" role="alert">
                      {authError}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={authSubmitting}
                      className="flex-1 rounded-md border border-white bg-white px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-white/85 disabled:opacity-50"
                    >
                      Continue
                    </button>
                    <button
                      type="button"
                      disabled={authSubmitting}
                      onClick={() => {
                        setShowGuestForm(false);
                        setAdvisorPositionInput("");
                        setVipIdInput("");
                        setAuthError("");
                      }}
                      className="rounded-md border border-white/30 px-4 py-2.5 text-sm text-white/80 transition-colors hover:border-white hover:text-white disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
              */}
            </div>
          </section>
        ) : (
          <section className={callState === "idle" ? "flex min-h-0 flex-1 flex-col" : "space-y-6"} aria-live="polite">
            {callState === "idle" && (
              <>
                {authError && <p className="mb-3 text-sm text-white/80" role="alert">{authError}</p>}
                {activeProfileError && <p className="mb-3 text-sm text-white/80" role="alert">Profile unavailable: {activeProfileError}</p>}
                {errorMessage && <p className="mb-3 text-sm text-white/80" role="alert">{errorMessage}</p>}
                {/* TODO: Re-enable guest flow: restore the guest-specific subtitle:
                    "Bring what you know as an expert—shape the conversation, and learn alongside the room."
                */}
                <PracticeScreen
                  user={user}
                  profile={activeProfile}
                  displayName={displayName}
                  initialLevel={userEnglishLevel}
                  onSignOut={handleSignOut}
                  onPractice={startPractice}
                  activitySummary={activitySummary}
                  onSessionFinished={handleSessionFinished}
                  notifications={notifications}
                  unreadCount={unreadCount}
                  notificationError={notificationError}
                  notificationPendingIds={notificationPendingIds}
                  onMarkNotificationRead={markNotificationRead}
                  onMarkAllNotificationsRead={markAllNotificationsRead}
                  tasks={tasks}
                  tasksLoading={tasksLoading}
                  taskTitle={taskTitle}
                  onTaskTitleChange={setTaskTitle}
                  onAddTask={addTask}
                  taskSubmitting={taskSubmitting}
                  taskError={taskError}
                  pendingTaskIds={pendingTaskIds}
                  onToggleTask={toggleTaskCompletion}
                  onDeleteTask={deleteTask}
                />
              </>
            )}

            {callState === "searching" && (
              <>
                <div className="space-y-3">
                  <h2 className="text-2xl font-semibold">Searching for a partner</h2>
                  <p className="text-sm text-white/70">Keep this page open while we find someone to practice with.</p>
                </div>
                <AwraButton onClick={() => finishCall()}>Cancel</AwraButton>
              </>
            )}

            {callState === "connecting" && (
              <>
                <div className="space-y-3">
                  <h2 className="text-2xl font-semibold">Connecting…</h2>
                  <p className="text-sm text-white/70">Found a partner — setting up your call.</p>
                </div>
                <AwraButton onClick={() => finishCall()}>Cancel</AwraButton>
              </>
            )}

            {callState === "connected" && (
              <>
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-2xl font-semibold">Practice in progress</h2>
                    {/* TODO: Re-enable guest flow: restore the advisor-position label in the active call view.
                    {advisorPosition && (
                      <span className="rounded-full border border-white/50 bg-white/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-white">
                        {advisorPosition} · {muted ? "Muted" : "Speaking"}
                      </span>
                    )}
                    */}
                    <span className="rounded-full border border-white/50 bg-white/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-white">
                      {muted ? "Muted" : "Speaking"}
                    </span>
                  </div>
                  <p className="text-sm text-white/70">You are connected with a speaking partner.</p>
                  <p className="text-4xl font-semibold tabular-nums" role="timer">{formattedTime}</p>
                </div>
                <div className="rounded-md border border-white/25 p-5">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/60">Speaking topic</p>
                  <p className="text-xl leading-relaxed text-white">{currentTopic}</p>
                </div>
                <AwraButton onClick={selectNewTopic}>New Topic</AwraButton>
                <AwraButton onClick={toggleMute}>{muted ? "Unmute" : "Mute"}</AwraButton>
                <AwraButton onClick={() => finishCall()}>End Call</AwraButton>
              </>
            )}
          </section>
        )}
      </main>

      <audio ref={audioRef} autoPlay playsInline className="hidden" />
      {!isIdleDashboard && <footer className="border-t border-white/15 pt-4 text-xs text-white/40" />}
    </div>
  );
}