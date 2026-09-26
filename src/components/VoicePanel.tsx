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

  return (
    <div className={styles.root}>
      {!voice.enabled ? (
        <button
          type="button"
          className={styles.toggle}
          onClick={() => void voice.enable()}
        >
          Join voice
        </button>
      ) : (
        <div className={styles.panel} aria-label="Voice chat">
          <div className={styles.row}>
            <button
              type="button"
              className={styles.toggle}
              onClick={() => void voice.disable()}
            >
              Leave voice
            </button>
            <div
              className={styles.segment}
              role="group"
              aria-label="Mic mode"
            >
              <button
                type="button"
                className={`${styles.segBtn} ${
                  voice.mode === "open" ? styles.segActive : ""
                }`}
                onClick={() => voice.setMode("open")}
              >
                Open mic
              </button>
              <button
                type="button"
                className={`${styles.segBtn} ${
                  voice.mode === "ptt" ? styles.segActive : ""
                }`}
                onClick={() => voice.setMode("ptt")}
              >
                Push-to-talk
              </button>
            </div>
          </div>

          <div className={styles.row}>
            {voice.mode === "open" ? (
              <button
                type="button"
                className={styles.action}
                onClick={voice.toggleMute}
                aria-pressed={voice.muted}
              >
                {voice.muted ? "Unmute" : "Mute"}
              </button>
            ) : (
              <button
                type="button"
                className={`${styles.ptt} ${
                  voice.pttActive ? styles.pttActive : ""
                }`}
                onPointerDown={(e) => {
                  e.preventDefault();
                  voice.pttDown();
                }}
                onPointerUp={voice.pttUp}
                onPointerLeave={voice.pttUp}
                onPointerCancel={voice.pttUp}
              >
                {voice.pttActive ? "Talking…" : "Hold to talk"}
              </button>
            )}
          </div>

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
      )}

      <ErrorText>{voice.error}</ErrorText>

      {Object.entries(voice.remoteStreams).map(([color, stream]) =>
        stream ? <RemoteAudio key={color} stream={stream} /> : null,
      )}
    </div>
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
