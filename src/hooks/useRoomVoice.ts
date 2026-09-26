"use client";

import { useMutation, useQuery } from "convex/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Color } from "@/lib/player";
import { getIceServers } from "@/lib/webrtc";

export type VoiceMode = "open" | "ptt";
export type PeerVoiceStatus = "connecting" | "connected";

const HEARTBEAT_MS = 8_000;

type PeerSlot = {
  pc: RTCPeerConnection;
  /** ICE candidates that arrived before setRemoteDescription. */
  pendingIce: RTCIceCandidateInit[];
  remoteSet: boolean;
  makingOffer: boolean;
};

function applyMicEnabled(
  stream: MediaStream | null,
  mode: VoiceMode,
  muted: boolean,
  pttActive: boolean,
) {
  if (!stream) return;
  const enabled = mode === "open" ? !muted : pttActive;
  for (const track of stream.getAudioTracks()) {
    track.enabled = enabled;
  }
}

export function useRoomVoice(
  roomId: Id<"rooms">,
  clientId: string,
  myColor: Color,
) {
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<VoiceMode>("open");
  const [muted, setMuted] = useState(false);
  const [pttActive, setPttActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peerStatus, setPeerStatus] = useState<
    Partial<Record<Color, PeerVoiceStatus>>
  >({});
  const [remoteStreams, setRemoteStreams] = useState<
    Partial<Record<Color, MediaStream>>
  >({});
  const [now, setNow] = useState(() => Date.now());

  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Partial<Record<Color, PeerSlot>>>({});
  const processedIdsRef = useRef<Set<string>>(new Set());
  const enabledRef = useRef(false);
  const myColorRef = useRef(myColor);

  useEffect(() => {
    myColorRef.current = myColor;
  }, [myColor]);

  const joinVoice = useMutation(api.voice.joinVoice);
  const leaveVoice = useMutation(api.voice.leaveVoice);
  const sendSignal = useMutation(api.voice.sendSignal);
  const ackSignals = useMutation(api.voice.ackSignals);

  const peers = useQuery(
    api.voice.listPeers,
    enabled ? { roomId, clientId, now } : "skip",
  );
  const signals = useQuery(
    api.voice.listSignals,
    enabled ? { roomId, clientId } : "skip",
  );

  const setPeerConnecting = useCallback((color: Color) => {
    setPeerStatus((prev) =>
      prev[color] === "connected"
        ? prev
        : { ...prev, [color]: "connecting" },
    );
  }, []);

  const setPeerConnected = useCallback((color: Color) => {
    setPeerStatus((prev) => ({ ...prev, [color]: "connected" }));
  }, []);

  const removePeerUi = useCallback((color: Color) => {
    setPeerStatus((prev) => {
      if (!(color in prev)) return prev;
      const next = { ...prev };
      delete next[color];
      return next;
    });
    setRemoteStreams((prev) => {
      if (!(color in prev)) return prev;
      const next = { ...prev };
      delete next[color];
      return next;
    });
  }, []);

  const closePeer = useCallback(
    (color: Color) => {
      const slot = peersRef.current[color];
      if (slot) {
        slot.pc.onicecandidate = null;
        slot.pc.ontrack = null;
        slot.pc.onconnectionstatechange = null;
        slot.pc.close();
        delete peersRef.current[color];
      }
      removePeerUi(color);
    },
    [removePeerUi],
  );

  const closeAllPeers = useCallback(() => {
    for (const color of Object.keys(peersRef.current) as Color[]) {
      closePeer(color);
    }
  }, [closePeer]);

  const getOrCreatePeer = useCallback(
    (remoteColor: Color): PeerSlot => {
      const existing = peersRef.current[remoteColor];
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: getIceServers() });
      const slot: PeerSlot = {
        pc,
        pendingIce: [],
        remoteSet: false,
        makingOffer: false,
      };
      peersRef.current[remoteColor] = slot;
      setPeerConnecting(remoteColor);

      const local = localStreamRef.current;
      if (local) {
        for (const track of local.getAudioTracks()) {
          pc.addTrack(track, local);
        }
      }

      pc.onicecandidate = (ev) => {
        if (!ev.candidate || !enabledRef.current) return;
        void sendSignal({
          roomId,
          clientId,
          toColor: remoteColor,
          type: "ice",
          payload: JSON.stringify(ev.candidate.toJSON()),
        });
      };

      pc.ontrack = (ev) => {
        const stream = ev.streams[0] ?? new MediaStream([ev.track]);
        setRemoteStreams((prev) => ({ ...prev, [remoteColor]: stream }));
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === "connected") {
          setPeerConnected(remoteColor);
        } else if (
          state === "failed" ||
          state === "closed" ||
          state === "disconnected"
        ) {
          // Soft drop UI on disconnected; full teardown when peer leaves list.
          if (state === "failed" || state === "closed") {
            closePeer(remoteColor);
          } else {
            setPeerConnecting(remoteColor);
          }
        }
      };

      return slot;
    },
    [
      roomId,
      clientId,
      sendSignal,
      setPeerConnecting,
      setPeerConnected,
      closePeer,
    ],
  );

  const createAndSendOffer = useCallback(
    async (remoteColor: Color) => {
      const slot = getOrCreatePeer(remoteColor);
      if (slot.makingOffer) return;
      slot.makingOffer = true;
      try {
        const offer = await slot.pc.createOffer();
        await slot.pc.setLocalDescription(offer);
        const local = slot.pc.localDescription;
        if (!local || !enabledRef.current) return;
        await sendSignal({
          roomId,
          clientId,
          toColor: remoteColor,
          type: "offer",
          payload: JSON.stringify({ type: local.type, sdp: local.sdp }),
        });
      } catch (err) {
        console.error("voice offer failed", err);
        setError("Could not connect voice");
      } finally {
        slot.makingOffer = false;
      }
    },
    [getOrCreatePeer, sendSignal, roomId, clientId],
  );

  const flushPendingIce = useCallback(async (slot: PeerSlot) => {
    if (!slot.remoteSet) return;
    const queued = slot.pendingIce.splice(0, slot.pendingIce.length);
    for (const init of queued) {
      try {
        await slot.pc.addIceCandidate(init);
      } catch {
        /* ignore late/stale candidates */
      }
    }
  }, []);

  // Keep mic track.enabled in sync with mode / mute / PTT.
  useEffect(() => {
    applyMicEnabled(localStreamRef.current, mode, muted, pttActive);
  }, [mode, muted, pttActive]);

  // Heartbeat clock for listPeers staleness filter.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [enabled]);

  // Join heartbeat + pagehide leave.
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      void joinVoice({ roomId, clientId });
    };
    tick();
    const id = setInterval(tick, HEARTBEAT_MS);
    const onUnload = () => {
      void leaveVoice({ roomId, clientId });
    };
    window.addEventListener("pagehide", onUnload);
    return () => {
      clearInterval(id);
      window.removeEventListener("pagehide", onUnload);
    };
  }, [enabled, roomId, clientId, joinVoice, leaveVoice]);

  // Peer discovery — initiator offers; drop gone peers.
  useEffect(() => {
    if (!enabled || peers === undefined) return;
    const live = new Set(peers);
    const mine = myColorRef.current;

    for (const color of Object.keys(peersRef.current) as Color[]) {
      if (!live.has(color)) closePeer(color);
    }

    for (const peerColor of peers as Color[]) {
      if (mine < peerColor) {
        const slot = peersRef.current[peerColor];
        if (!slot || slot.pc.signalingState === "stable") {
          if (!slot || !slot.pc.localDescription) {
            void createAndSendOffer(peerColor);
          }
        }
      } else {
        // Wait for their offer; ensure PC exists so ICE can queue.
        getOrCreatePeer(peerColor);
      }
    }
  }, [enabled, peers, closePeer, createAndSendOffer, getOrCreatePeer]);

  // Process inbound signals.
  useEffect(() => {
    if (!enabled || !signals || signals.length === 0) return;

    let cancelled = false;
    const ids: Id<"voiceSignals">[] = [];

    void (async () => {
      for (const signal of signals) {
        if (cancelled) return;
        if (processedIdsRef.current.has(signal._id)) {
          ids.push(signal._id);
          continue;
        }
        processedIdsRef.current.add(signal._id);
        ids.push(signal._id);

        const from = signal.fromColor as Color;
        try {
          if (signal.type === "offer") {
            const desc = JSON.parse(signal.payload) as RTCSessionDescriptionInit;
            const slot = getOrCreatePeer(from);
            await slot.pc.setRemoteDescription(desc);
            slot.remoteSet = true;
            await flushPendingIce(slot);
            const answer = await slot.pc.createAnswer();
            await slot.pc.setLocalDescription(answer);
            const local = slot.pc.localDescription;
            if (local && enabledRef.current) {
              await sendSignal({
                roomId,
                clientId,
                toColor: from,
                type: "answer",
                payload: JSON.stringify({ type: local.type, sdp: local.sdp }),
              });
            }
          } else if (signal.type === "answer") {
            const desc = JSON.parse(signal.payload) as RTCSessionDescriptionInit;
            const slot = getOrCreatePeer(from);
            await slot.pc.setRemoteDescription(desc);
            slot.remoteSet = true;
            await flushPendingIce(slot);
          } else if (signal.type === "ice") {
            const init = JSON.parse(signal.payload) as RTCIceCandidateInit;
            const slot = getOrCreatePeer(from);
            if (!slot.remoteSet) {
              slot.pendingIce.push(init);
            } else {
              try {
                await slot.pc.addIceCandidate(init);
              } catch {
                /* ignore */
              }
            }
          }
        } catch (err) {
          console.error("voice signal failed", signal.type, err);
        }
      }

      if (!cancelled && ids.length > 0) {
        try {
          await ackSignals({ roomId, clientId, ids });
        } catch {
          /* will retry via query */
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    signals,
    getOrCreatePeer,
    flushPendingIce,
    sendSignal,
    ackSignals,
    roomId,
    clientId,
  ]);

  const teardown = useCallback(async () => {
    enabledRef.current = false;
    closeAllPeers();
    const stream = localStreamRef.current;
    localStreamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    processedIdsRef.current.clear();
    setPeerStatus({});
    setRemoteStreams({});
    setPttActive(false);
    try {
      await leaveVoice({ roomId, clientId });
    } catch {
      /* seat may already be gone */
    }
  }, [closeAllPeers, leaveVoice, roomId, clientId]);

  const enable = useCallback(async () => {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Voice needs a secure browser (HTTPS) with mic support");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      applyMicEnabled(stream, mode, muted, false);
      enabledRef.current = true;
      setNow(Date.now());
      setEnabled(true);
      await joinVoice({ roomId, clientId });
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone permission denied"
          : "Could not access microphone";
      setError(msg);
      localStreamRef.current = null;
      enabledRef.current = false;
      setEnabled(false);
    }
  }, [mode, muted, joinVoice, roomId, clientId]);

  const disable = useCallback(async () => {
    setEnabled(false);
    await teardown();
  }, [teardown]);

  // Unmount cleanup.
  useEffect(() => {
    return () => {
      if (enabledRef.current) {
        void teardown();
      }
    };
    // Only on unmount — teardown identity changes would re-fire incorrectly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setVoiceMode = useCallback((next: VoiceMode) => {
    setMode(next);
    if (next === "ptt") {
      setPttActive(false);
      setMuted(false);
    }
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => !m);
  }, []);

  const pttDown = useCallback(() => {
    setPttActive(true);
  }, []);

  const pttUp = useCallback(() => {
    setPttActive(false);
  }, []);

  return {
    enabled,
    mode,
    muted,
    pttActive,
    error,
    peerStatus,
    remoteStreams,
    enable,
    disable,
    setMode: setVoiceMode,
    toggleMute,
    pttDown,
    pttUp,
  };
}
