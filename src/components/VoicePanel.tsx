"use client";

import type { CSSProperties } from "react";
import type { Id } from "../../convex/_generated/dataModel";
import { COLOR_HEX, type Color } from "@/lib/player";
import { useRoomVoice } from "@/hooks/useRoomVoice";
import { ErrorText } from "./ui";
import styles from "./VoicePanel.module.css";

type VoicePlayer = {
  name: string;
  color: Color;
  isMe: boolean;
  isBot: boolean;
};

type Props = {
  roomId: Id<"rooms">;
  clientId: string;
  myColor: Color;
  players: VoicePlayer[];
};

export function VoicePanel({ roomId, clientId, myColor, players }: Props) {
  const voice = useRoomVoice(roomId, clientId, myColor);

  const peerColors = Object.keys(voice.peerStatus) as Color[];
  const nameByColor = Object.fromEntries(
    players.map((p) => [p.color, p.name]),
  ) as Partial<Record<Color, string>>;

  const showMuted = !voice.enabled || voice.muted;

  const onMicClick = () => {
    if (!voice.enabled) {
      void voice.enableAndUnmute();
      return;
    }
    voice.toggleMute();
  };

  return (
    <div className={styles.root}>
      <div className={styles.panel} aria-label="Voice chat">
        <button
          type="button"
          className={`${styles.micBtn} ${
            showMuted ? styles.micMuted : styles.micLive
          }`}
          onClick={onMicClick}
          aria-pressed={!showMuted}
          aria-label={showMuted ? "Unmute microphone" : "Mute microphone"}
          title={showMuted ? "Unmute to speak" : "Mute"}
        >
          {showMuted ? <MicOffIcon /> : <MicOnIcon />}
        </button>

        {peerColors.length > 0 && (
          <ul className={styles.peers} aria-label="Voice peers">
            {peerColors.map((color) => (
              <li
                key={color}
                className={styles.peer}
                title={`${nameByColor[color] ?? color}: ${voice.peerStatus[color]}`}
              >
                <span
                  className={`${styles.dot} ${
                    voice.peerStatus[color] === "connected"
                      ? styles.dotLive
                      : styles.dotWait
                  }`}
                  style={
                    {
                      ["--c" as string]: COLOR_HEX[color],
                    } as CSSProperties
                  }
                  aria-hidden
                />
                <span className={styles.peerName}>
                  {nameByColor[color] ?? color}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ErrorText>{voice.error}</ErrorText>

      {Object.entries(voice.remoteStreams).map(([color, stream]) =>
        stream ? <RemoteAudio key={color} stream={stream} /> : null,
      )}
    </div>
  );
}

function MicOnIcon() {
  return (
    <svg
      className={styles.micIcon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg
      className={styles.micIcon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2" />
      <path d="M19 10v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function RemoteAudio({ stream }: { stream: MediaStream }) {
  return (
    <audio
      autoPlay
      playsInline
      ref={(el) => {
        if (el && el.srcObject !== stream) {
          el.srcObject = stream;
        }
      }}
      className={styles.hiddenAudio}
    />
  );
}
