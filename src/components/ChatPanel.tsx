"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { COLOR_HEX, formatConvexError, type Color } from "@/lib/player";
import { ErrorText } from "./ui";
import styles from "./ChatPanel.module.css";

const MAX_LEN = 200;

type Props = {
  roomId: Id<"rooms">;
  clientId: string;
};

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function ChatPanel({ roomId, clientId }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const messages = useQuery(
    api.chat.listMessages,
    open ? { roomId, clientId } : "skip",
  );
  const sendMessage = useMutation(api.chat.sendMessage);

  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, messages]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    const text = draft.trim();
    if (!text) {
      setError("Type a message first");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendMessage({ roomId, clientId, text });
      setDraft("");
    } catch (err) {
      setError(formatConvexError(err, "Could not send"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={styles.root}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls="room-chat-panel"
        onClick={() => {
          setOpen((v) => !v);
          setError(null);
        }}
      >
        {open ? "Close chat" : "Chat"}
      </button>

      {open && (
        <aside
          id="room-chat-panel"
          className={styles.sheet}
          aria-label="Room chat"
        >
          <div className={styles.sheetHead}>
            <p className={styles.sheetTitle}>Chat</p>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => setOpen(false)}
              aria-label="Close chat"
            >
              Close
            </button>
          </div>

          <ul
            ref={listRef}
            className={styles.list}
            aria-live="polite"
            aria-relevant="additions"
          >
            {messages === undefined && (
              <li className={styles.empty}>Loading…</li>
            )}
            {messages && messages.length === 0 && (
              <li className={styles.empty}>No messages yet</li>
            )}
            {messages?.map((m) => (
              <li
                key={m._id}
                className={`${styles.msg} ${m.isMine ? styles.mine : ""}`}
                style={{ ["--c" as string]: COLOR_HEX[m.color as Color] }}
              >
                <span className={styles.swatch} aria-hidden />
                <div className={styles.msgBody}>
                  <div className={styles.meta}>
                    <span className={styles.name}>
                      {m.name}
                      {m.isMine ? " (you)" : ""}
                    </span>
                    <time
                      className={styles.time}
                      dateTime={new Date(m.createdAt).toISOString()}
                    >
                      {formatTime(m.createdAt)}
                    </time>
                  </div>
                  <p className={styles.text}>{m.text}</p>
                </div>
              </li>
            ))}
          </ul>

          <form className={styles.composer} onSubmit={onSubmit}>
            <input
              className={styles.input}
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, MAX_LEN))}
              maxLength={MAX_LEN}
              placeholder="Say something…"
              autoComplete="off"
              enterKeyHint="send"
              disabled={sending}
              aria-label="Chat message"
            />
            <button
              type="submit"
              className={styles.send}
              disabled={sending || !draft.trim()}
            >
              Send
            </button>
          </form>
          <ErrorText>{error}</ErrorText>
        </aside>
      )}
    </div>
  );
}
