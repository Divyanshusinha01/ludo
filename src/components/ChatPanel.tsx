"use client";

import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { COLOR_HEX, formatConvexError, type Color } from "@/lib/player";
import { playSound } from "@/lib/sounds";
import { ErrorText } from "./ui";
import styles from "./ChatPanel.module.css";

const MAX_LEN = 200;

type ChatPlayer = {
  name: string;
  color: Color;
  isMe: boolean;
  isBot: boolean;
};

type Props = {
  roomId: Id<"rooms">;
  clientId: string;
  players: ChatPlayer[];
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

function readWatermark(roomId: string): number {
  try {
    const raw = sessionStorage.getItem(`ludo-chat-read:${roomId}`);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeWatermark(roomId: string, at: number) {
  try {
    sessionStorage.setItem(`ludo-chat-read:${roomId}`, String(at));
  } catch {
    /* ignore */
  }
}

/** Active @query at caret, if any. */
function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

function renderMentionText(
  text: string,
  names: string[],
): ReactNode {
  if (names.length === 0) return text;
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((n) =>
    n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  if (escaped.length === 0) return text;
  const re = new RegExp(`(@(?:${escaped.join("|")}))`, "gi");
  const nameSet = new Set(sorted.map((n) => n.toLowerCase()));
  const parts = text.split(re);
  return parts.map((part, i) => {
    if (
      part.startsWith("@") &&
      nameSet.has(part.slice(1).toLowerCase())
    ) {
      return (
        <span key={i} className={styles.mention}>
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

type ChatFlash = {
  id: string;
  name: string;
  text: string;
  isPrivate: boolean;
};

const FLASH_MS = 1000;

export function ChatPanel({ roomId, clientId, players }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReadAt, setLastReadAt] = useState(() => readWatermark(roomId));
  const [mentionIndex, setMentionIndex] = useState(0);
  const [caret, setCaret] = useState(0);
  const [flash, setFlash] = useState<ChatFlash | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastNotifiedId = useRef<string | null>(null);
  const primedRef = useRef(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messages = useQuery(api.chat.listMessages, { roomId, clientId });
  const sendMessage = useMutation(api.chat.sendMessage);

  const mentionCandidates = useMemo(
    () => players.filter((p) => !p.isMe && !p.isBot),
    [players],
  );

  const mentionNames = useMemo(
    () => mentionCandidates.map((p) => p.name),
    [mentionCandidates],
  );

  const activeMention = mentionQueryAt(draft, caret);
  const filteredMentions = useMemo(() => {
    if (!activeMention) return [];
    const q = activeMention.query.toLowerCase();
    return mentionCandidates.filter((p) =>
      p.name.toLowerCase().startsWith(q),
    );
  }, [activeMention, mentionCandidates]);

  const showMentionMenu = open && filteredMentions.length > 0;

  useEffect(() => {
    setMentionIndex(0);
  }, [activeMention?.start, activeMention?.query, filteredMentions.length]);

  // Reset watermark when room changes.
  useEffect(() => {
    setLastReadAt(readWatermark(roomId));
    lastNotifiedId.current = null;
    primedRef.current = false;
    setFlash(null);
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
  }, [roomId]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, []);

  function showFlash(next: ChatFlash) {
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
    }
    setFlash(next);
    flashTimerRef.current = setTimeout(() => {
      setFlash(null);
      flashTimerRef.current = null;
    }, FLASH_MS);
  }

  // Mark read when open / while open with new messages.
  useEffect(() => {
    if (!open || !messages || messages.length === 0) return;
    const latest = messages[messages.length - 1]!.createdAt;
    if (latest > lastReadAt) {
      setLastReadAt(latest);
      writeWatermark(roomId, latest);
    }
  }, [open, messages, lastReadAt, roomId]);

  // Notify sound + flash for new messages while closed.
  useEffect(() => {
    if (!messages) return;

    if (!primedRef.current) {
      primedRef.current = true;
      const last = messages[messages.length - 1];
      lastNotifiedId.current = last?._id ?? null;
      // First subscribe: don't treat existing history as unread.
      if (last && lastReadAt === 0) {
        setLastReadAt(last.createdAt);
        writeWatermark(roomId, last.createdAt);
      }
      return;
    }

    if (open) {
      const last = messages[messages.length - 1];
      lastNotifiedId.current = last?._id ?? lastNotifiedId.current;
      return;
    }

    let newestOther: (typeof messages)[number] | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!messages[i]!.isMine) {
        newestOther = messages[i]!;
        break;
      }
    }
    if (!newestOther) return;
    if (newestOther._id === lastNotifiedId.current) return;

    const prevId = lastNotifiedId.current;
    const prevIdx = prevId
      ? messages.findIndex((m) => m._id === prevId)
      : -1;
    const newestIdx = messages.findIndex((m) => m._id === newestOther!._id);
    const isNew =
      prevIdx === -1
        ? newestOther.createdAt > lastReadAt
        : newestIdx > prevIdx;

    if (isNew) {
      playSound("chat");
      showFlash({
        id: newestOther._id,
        name: newestOther.name,
        text: newestOther.text,
        isPrivate: newestOther.isPrivate,
      });
    }
    lastNotifiedId.current = newestOther._id;
  }, [messages, open, lastReadAt, roomId]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, messages]);

  const unread =
    messages?.filter((m) => !m.isMine && m.createdAt > lastReadAt).length ??
    0;
  const unreadLabel = unread > 99 ? "99+" : String(unread);

  function insertMention(name: string) {
    if (!activeMention) return;
    const before = draft.slice(0, activeMention.start);
    const after = draft.slice(caret);
    const inserted = `@${name} `;
    const next = `${before}${inserted}${after}`.slice(0, MAX_LEN);
    const nextCaret = Math.min(before.length + inserted.length, next.length);
    setDraft(next);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!showMentionMenu) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMentionIndex((i) => (i + 1) % filteredMentions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMentionIndex(
        (i) => (i - 1 + filteredMentions.length) % filteredMentions.length,
      );
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const pick = filteredMentions[mentionIndex];
      if (pick) insertMention(pick.name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setCaret(draft.length);
      // Collapse menu by moving past query — clear @ query by appending space noop;
      // simplest: move caret so query is invalid via setting draft unchanged and
      // a caret after a forced space isn't needed — just blur menu via empty query.
      const at = activeMention?.start ?? -1;
      if (at >= 0) {
        const next = `${draft.slice(0, at)}${draft.slice(caret)}`;
        setDraft(next);
        setCaret(at);
      }
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    if (showMentionMenu) return;
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
      setCaret(0);
    } catch (err) {
      setError(formatConvexError(err, "Could not send"));
    } finally {
      setSending(false);
    }
  }

  function openChat() {
    setOpen(true);
    setError(null);
    setFlash(null);
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    if (messages && messages.length > 0) {
      const latest = messages[messages.length - 1]!.createdAt;
      setLastReadAt(latest);
      writeWatermark(roomId, latest);
    }
  }

  function closeChat() {
    setOpen(false);
    setError(null);
  }

  return (
    <div className={styles.root}>
      {flash && (
        <button
          type="button"
          className={styles.flash}
          onClick={openChat}
          aria-label={`New message from ${flash.name}: ${flash.text}`}
        >
          <span className={styles.flashName}>
            {flash.name}
            {flash.isPrivate ? (
              <span className={styles.flashPrivate}> private</span>
            ) : null}
          </span>
          <span className={styles.flashText}>{flash.text}</span>
        </button>
      )}
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls="room-chat-panel"
        aria-label={
          unread > 0
            ? `Chat, ${unread} unread`
            : open
              ? "Close chat"
              : "Chat"
        }
        onClick={() => {
          if (open) closeChat();
          else openChat();
        }}
      >
        {open ? "Close chat" : "Chat"}
        {!open && unread > 0 && (
          <span className={styles.badge} aria-hidden>
            {unreadLabel}
          </span>
        )}
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
              onClick={closeChat}
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
                className={`${styles.msg} ${m.isMine ? styles.mine : ""} ${
                  m.isPrivate ? styles.privateMsg : ""
                } ${m.mentionsMe ? styles.mentionsMe : ""}`}
                style={{ ["--c" as string]: COLOR_HEX[m.color as Color] }}
              >
                <span className={styles.swatch} aria-hidden />
                <div className={styles.msgBody}>
                  <div className={styles.meta}>
                    <span className={styles.name}>
                      {m.name}
                      {m.isMine ? " (you)" : ""}
                      {m.isPrivate ? (
                        <span className={styles.privateTag}> private</span>
                      ) : null}
                    </span>
                    <time
                      className={styles.time}
                      dateTime={new Date(m.createdAt).toISOString()}
                    >
                      {formatTime(m.createdAt)}
                    </time>
                  </div>
                  <p className={styles.text}>
                    {renderMentionText(m.text, [
                      ...mentionNames,
                      ...players.map((p) => p.name),
                    ])}
                  </p>
                </div>
              </li>
            ))}          </ul>

          <form className={styles.composer} onSubmit={onSubmit}>
            <div className={styles.inputWrap}>
              {showMentionMenu && (
                <ul
                  className={styles.mentionMenu}
                  role="listbox"
                  aria-label="Message privately"
                >
                  {filteredMentions.map((p, i) => (
                    <li key={`${p.color}-${p.name}`} role="option">
                      <button
                        type="button"
                        className={`${styles.mentionOption} ${
                          i === mentionIndex ? styles.mentionOptionActive : ""
                        }`}
                        style={
                          {
                            ["--c" as string]: COLOR_HEX[p.color],
                          } as CSSProperties
                        }
                        onMouseDown={(e) => {
                          e.preventDefault();
                          insertMention(p.name);
                        }}
                      >
                        <span className={styles.mentionSwatch} aria-hidden />
                        {p.name}
                        <span className={styles.mentionPrivateHint}>
                          private
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <input
                ref={inputRef}
                className={styles.input}
                value={draft}
                onChange={(e) => {
                  const v = e.target.value.slice(0, MAX_LEN);
                  setDraft(v);
                  setCaret(e.target.selectionStart ?? v.length);
                }}
                onSelect={(e) => {
                  setCaret(e.currentTarget.selectionStart ?? 0);
                }}
                onKeyDown={onInputKeyDown}
                maxLength={MAX_LEN}
                placeholder="Say something… (@Name = private)"
                autoComplete="off"
                enterKeyHint="send"
                disabled={sending}
                aria-label="Chat message"
                aria-autocomplete="list"
                aria-expanded={showMentionMenu}
              />
            </div>
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
