import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

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

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase =
  supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

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

// Centralized seam for real telemetry later. Replace the console.error with
// Sentry.captureException / PostHog capture / etc. when you wire one up.
function logError(context, error) {
  console.error(`[AWRA:${context}]`, error);
}

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

// --- Generic per-session timeout tracking --------------------------------
// Every call session can have several in-flight timeouts at once (a match
// proposal timeout, an ICE-disconnect grace timer, a search timeout, a
// partner-join timeout). Tracking them as named entries in one `timeouts`
// map means there's a single place that clears all of them on dispose, so
// adding a new timeout later can't accidentally be forgotten there.
function createCallSession(userId, initialTopic) {
  return {
    userId,
    currentTopic: initialTopic,
    pendingLocalCandidates: [],
    pendingRemoteCandidates: [],
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

// Shared button so every screen pulls from one styling definition instead of
// repeating the same Tailwind class string. Same exact visual result as
// before — primary = solid white pill, secondary = outlined pill.
function AwraButton({ variant = "secondary", className = "", type = "button", ...props }) {
  const base =
    "w-full rounded-md px-5 py-3 font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50";
  const variantClass =
    variant === "primary"
      ? "bg-white text-black hover:bg-white/85"
      : "border border-white text-white hover:bg-white hover:text-black";
  return <button type={type} className={`${base} ${variantClass} ${className}`} {...props} />;
}

export default function App() {
  // Auth state
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(Boolean(supabase));
  const [authMode, setAuthMode] = useState("signin"); // "signin" | "signup"
  const [fullName, setFullName] = useState("");
  const [englishLevel, setEnglishLevel] = useState("Intermediate");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);

  // Call & practice state
  const [callState, setCallState] = useState("idle"); // "idle" | "searching" | "connecting" | "connected"
  const [remainingSeconds, setRemainingSeconds] = useState(600);
  const [currentTopic, setCurrentTopic] = useState(speakingTopics[0]);
  const [muted, setMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const audioRef = useRef(null);
  const sessionRef = useRef(null);
  const [guestId] = useState(getOrCreateGuestId);

  const activeUserId = user?.id ?? guestId;

  // Listen for active Supabase session on mount
  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return undefined;
    }

    supabase.auth
      .getSession()
      .then(({ data }) => setUser(data.session?.user ?? null))
      .catch((error) => logError("get-session", error))
      .finally(() => setAuthLoading(false));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const finishCall = useCallback((message = "") => {
    const session = sessionRef.current;
    sessionRef.current = null;
    disposeSession(session, audioRef);
    setCallState("idle");
    setRemainingSeconds(600);
    setMuted(false);
    setErrorMessage(message);
  }, []);

  // If `user` ever goes from signed-in/guest to null for ANY reason — an
  // explicit sign-out, a failed background token refresh, another tab
  // signing the account out — end whatever call session is running instead
  // of letting mic/WebRTC/Realtime connections keep going behind a login
  // screen the person can no longer interact with.
  useEffect(() => {
    if (!user && sessionRef.current) {
      finishCall("You were signed out, so your practice session ended.");
    }
  }, [user, finishCall]);

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setAuthError("");

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setAuthError("Enter both your email and password.");
      return;
    }
    if (authMode === "signup" && password.length < 6) {
      setAuthError("Password must be at least 6 characters.");
      return;
    }
    if (!supabase) {
      setAuthError("Supabase is not configured. Use Continue as Guest below.");
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
              full_name: fullName.trim() || trimmedEmail.split("@")[0],
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

  function continueAsGuest() {
    setAuthError("");
    setUser({
      id: guestId,
      email: "guest@awra.local",
      isGuest: true,
      user_metadata: { full_name: "Guest Speaker" },
    });
  }

  async function handleSignOut() {
    finishCall();
    if (supabase && !user?.isGuest) {
      await supabase.auth.signOut();
    }
    setUser(null);
    setPassword("");
    setAuthError("");
  }

  useEffect(() => {
    if (callState !== "connected") return undefined;

    const intervalId = window.setInterval(() => {
      setRemainingSeconds((seconds) => Math.max(seconds - 1, 0));
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [callState]);

  useEffect(() => {
    if (callState === "connected" && remainingSeconds === 0) {
      finishCall("Your 10-minute practice session has ended.");
    }
  }, [callState, remainingSeconds, finishCall]);

  useEffect(
    () => () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      disposeSession(session, audioRef);
    },
    [],
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

      // "disconnected" is often transient (brief network blip) and can
      // recover on its own or via an ICE restart; only "failed" is treated
      // as terminal.
      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        if (session.disposed) return;

        if (state === "disconnected") {
          setSessionTimeout(session, "iceDisconnect", () => {
            if (session.disposed) return;
            if (peerConnection.connectionState === "disconnected") {
              try {
                peerConnection.restartIce();
              } catch (error) {
                logError("ice-restart", error);
                finishCall("The voice connection was lost. Please try again.");
              }
            }
          }, ICE_DISCONNECT_GRACE_MS);
          return;
        }

        clearSessionTimeout(session, "iceDisconnect");

        if (state === "failed") {
          finishCall("The voice connection failed. Please try again.");
        }
      };

      // `restartIce()` only flags that the NEXT offer should carry
      // `iceRestart: true` — it does not create or send that offer itself.
      // That has to happen from `onnegotiationneeded`, which also fires once
      // automatically after tracks are added, so this single handler covers
      // both the initial offer and any later ICE restart.
      let negotiating = false;
      async function maybeNegotiate() {
        if (session.disposed) return;
        if (session.userId.localeCompare(partnerUserId) >= 0) return; // only the lower id negotiates
        if (!session.partnerSeen || !session.roomSubscribed || negotiating) return;

        negotiating = true;
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
          finishCall("Couldn't establish the voice connection. Please try again.");
        } finally {
          negotiating = false;
        }
      }
      peerConnection.onnegotiationneeded = () => {
        void maybeNegotiate();
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
        await Promise.all(
          candidates.map((candidate) =>
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate)),
          ),
        );
      }

      roomChannel
        .on("broadcast", { event: "webrtc_offer" }, async ({ payload }) => {
          if (payload?.userId === session.userId || !payload?.description || session.disposed) return;
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
            finishCall("Couldn't establish the voice connection. Please try again.");
          }
        })
        .on("broadcast", { event: "webrtc_answer" }, async ({ payload }) => {
          if (payload?.userId === session.userId || !payload?.description || session.disposed) return;
          try {
            await applyRemoteDescription(payload.description);
          } catch (error) {
            logError("webrtc-answer-handling", error);
            finishCall("Couldn't establish the voice connection. Please try again.");
          }
        })
        .on("broadcast", { event: "webrtc_ice_candidate" }, async ({ payload }) => {
          if (payload?.userId === session.userId || !payload?.candidate || session.disposed) return;
          try {
            if (peerConnection.remoteDescription) {
              await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
            } else {
              session.pendingRemoteCandidates.push(payload.candidate);
            }
          } catch (error) {
            logError("ice-candidate-handling", error);
            finishCall("Couldn't establish the voice connection. Please try again.");
          }
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
              finishCall("Your partner disconnected.");
            }
            return;
          }

          // Only flip into "connected" (and start the 10-minute timer) the
          // first time the partner is actually confirmed present — not just
          // because WE successfully joined the room. Previously the call
          // state went straight to "connected" after self-joining, so a
          // partner who never showed up (closed tab, stuck mic prompt, etc.)
          // produced a silent "connected" call that just burned the timer.
          if (!session.partnerSeen) {
            session.partnerSeen = true;
            clearSessionTimeout(session, "partnerJoin");
            setCurrentTopic(session.currentTopic);
            setRemainingSeconds(600);
            setCallState("connected");
          }

          void maybeNegotiate();
        });

      // This status handler stays live for the room's whole lifetime rather
      // than being wrapped in a one-shot promise, so a post-connect drop
      // (CLOSED/TIMED_OUT/CHANNEL_ERROR from a flaky Realtime socket) ends
      // the call with a clear message instead of being silently discarded.
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
              finishCall("Lost connection to the voice service. Please try again.");
            }
          }
        });
      });
      if (sessionRef.current !== session || session.disposed) return;

      const trackStatus = await roomChannel.track({ userId: session.userId });
      if (trackStatus !== "ok") throw new Error("Unable to join the voice room.");

      removeChannel(session.lobbyChannel);
      session.lobbyChannel = null;

      // Give the partner a reasonable window to actually show up in the
      // room before giving up — see the presence-sync handler above for
      // where this gets cleared once they're confirmed present.
      setSessionTimeout(session, "partnerJoin", () => {
        if (sessionRef.current === session && !session.disposed && !session.partnerSeen) {
          finishCall("Your partner never joined. Please try again.");
        }
      }, PARTNER_JOIN_TIMEOUT_MS);
    } catch (error) {
      if (sessionRef.current !== session || session.disposed) return;
      logError("start-room", error);
      const message =
        error?.name === "NotAllowedError" || error?.name === "SecurityError"
          ? "Microphone access was denied. Allow microphone access in your browser and try again."
          : error?.name === "NotFoundError"
            ? "No microphone was found. Connect a microphone and try again."
            : "Couldn't connect to the voice room. Please try again.";
      finishCall(message);
    }
  }

  // --- Matchmaking -----------------------------------------------------
  //
  // Every client independently recomputing pairs from its own (eventually
  // consistent) view of presence state can disagree under concurrent
  // arrivals. This uses a propose/accept handshake with a single
  // deterministic proposer so commitment only happens once both sides
  // agree:
  //
  //   1. Only the lexicographically smallest *waiting* user id ever
  //      proposes a match (to the next-smallest waiting user).
  //   2. The target must explicitly accept before either side moves to
  //      "matched" and starts a room. If the target is already busy, it
  //      replies "busy" and the proposer re-evaluates.
  //   3. A proposal that gets no reply within MATCH_PROPOSAL_TIMEOUT_MS is
  //      abandoned and re-evaluated, so a dropped message can't wedge a
  //      user in "proposed" forever.
  //
  // Still client-coordinated, not server-arbitrated — see the file header.

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
    if (waitingUsers[0] !== session.userId) return; // only the leader proposes

    const partnerUserId = waitingUsers[1];
    if (partnerUserId === session.userId) return;

    const roomId = [session.userId, partnerUserId].sort().join("-");
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
      // No accept/busy reply in time — give up on this candidate and
      // re-evaluate against whatever the waiting pool looks like now.
      session.matchState = "waiting";
      session.proposedPartner = null;
      session.proposedRoomId = null;
      evaluateMatch(session, lobbyChannel);
    }, MATCH_PROPOSAL_TIMEOUT_MS);
  }

  function startPractice() {
    setErrorMessage("");
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
      void lobbyChannel.track({ userId: activeUserId, status: "matched" });
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
        void lobbyChannel.track({ userId: activeUserId, status: "waiting" }).then((result) => {
          if (result !== "ok") finishCall("Couldn't join the waiting room. Please try again.");
        });
      } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
        session.lobbySubscribed = false;
        if (session.matchState !== "matched") {
          finishCall("Couldn't connect to the voice service. Please try again.");
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
    user?.user_metadata?.full_name || user?.email?.split("@")[0] || "Speaker";
  const userEnglishLevel = user?.user_metadata?.english_level;

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-between bg-black px-6 py-8 text-white">
      <header className="flex items-center justify-between border-b border-white/15 pb-4">
        <h1>
          <img className="h-10 w-10 object-contain" src="/logo.png" alt="AWRA" />
        </h1>
        {user && (
          <div className="flex items-center gap-3">
            <span className="max-w-[140px] truncate text-xs text-white/60">
              {displayName}
            </span>
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

      <main className="my-auto py-10">
        {authLoading ? (
          <p role="status" aria-live="polite" className="text-sm text-white/60">Loading...</p>
        ) : !user ? (
          <section className="space-y-6" aria-live="polite">
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
                onClick={() => {
                  setAuthError("");
                  setAuthMode(authMode === "signin" ? "signup" : "signin");
                }}
                className="w-full text-center text-sm text-white/70 underline-offset-4 hover:text-white hover:underline"
              >
                {authMode === "signin"
                  ? "Need an account? Create one"
                  : "Already have an account? Sign in"}
              </button>

              <button
                type="button"
                onClick={continueAsGuest}
                className="w-full rounded-md border border-white/30 px-5 py-2.5 text-sm font-medium text-white/80 transition-colors hover:border-white hover:text-white"
              >
                Continue as Guest
              </button>
            </div>
          </section>
        ) : (
          <section className="space-y-6" aria-live="polite">
            {callState === "idle" && (
              <>
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-2xl font-semibold">Ready to practice, {displayName}?</h2>
                    {userEnglishLevel && (
                      <span className="rounded-full border border-white/30 px-2.5 py-1 text-xs text-white/70">
                        {userEnglishLevel}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-white/70">Find a partner for a ten-minute speaking session.</p>
                </div>
                {errorMessage && <p className="text-sm text-white/80" role="alert">{errorMessage}</p>}
                <AwraButton variant="primary" onClick={startPractice}>
                  Practice
                </AwraButton>
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
                  <h2 className="text-2xl font-semibold">Practice in progress</h2>
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
      <footer className="border-t border-white/15 pt-4 text-xs text-white/40" />
    </div>
  );
}
