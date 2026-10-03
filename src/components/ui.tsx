"use client";

import { CSSProperties, ReactNode } from "react";
import styles from "./ui.module.css";

type ButtonProps = {
  children: ReactNode;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "ink";
  disabled?: boolean;
  /** Shows an inline spinner and blocks clicks while async work runs. */
  loading?: boolean;
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
};

const base: CSSProperties = {
  appearance: "none",
  borderRadius: 999,
  padding: "0.85rem 1.2rem",
  fontFamily: "var(--font-display)",
  fontSize: "1.05rem",
  cursor: "pointer",
  touchAction: "manipulation",
};

const variants: Record<NonNullable<ButtonProps["variant"]>, CSSProperties> = {
  primary: {
    border: "none",
    background: "var(--accent)",
    color: "#1a1208",
  },
  secondary: {
    border: "1px solid rgba(0, 0, 0, 0.15)",
    background: "rgba(255, 255, 255, 0.7)",
    color: "var(--ink)",
  },
  ink: {
    border: "none",
    background: "var(--ink)",
    color: "#fff",
  },
};

export function Button({
  children,
  type = "button",
  variant = "primary",
  disabled,
  loading = false,
  onClick,
  className,
  style,
  ...rest
}: ButtonProps) {
  const inactive = disabled || loading;
  return (
    <button
      type={type}
      disabled={inactive}
      onClick={onClick}
      aria-busy={loading || undefined}
      className={className ? `${styles.btn} ${className}` : styles.btn}
      style={{
        ...base,
        ...variants[variant],
        opacity: disabled && !loading ? 0.5 : loading ? 0.85 : 1,
        cursor: inactive ? "not-allowed" : "pointer",
        ...style,
      }}
      {...rest}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      {children}
    </button>
  );
}

/**
 * Pending-state indicator. Stays invisible for the first ~180ms so quick
 * loads never flash a spinner.
 */
export function Loader({
  label = "Loading…",
  fill = false,
}: {
  label?: string;
  /** Take most of the viewport, for full-page route loads. */
  fill?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={fill ? `${styles.loader} ${styles.loaderFill}` : styles.loader}
    >
      <span className={styles.dots} aria-hidden="true">
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
      </span>
      <p className={styles.loaderLabel}>{label}</p>
    </div>
  );
}

const troubleBtnStyle: CSSProperties = {
  appearance: "none",
  border: "none",
  background: "transparent",
  color: "var(--muted)",
  textDecoration: "underline",
  textUnderlineOffset: 3,
  fontSize: "0.85rem",
  cursor: "pointer",
  padding: "0.15rem 0.25rem",
  touchAction: "manipulation",
};

type TroubleshootButtonProps = {
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** Quieter chrome link vs under-error CTA */
  variant?: "link" | "underError";
};

export function TroubleshootButton({
  onClick,
  busy,
  disabled,
  variant = "underError",
}: TroubleshootButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      style={{
        ...troubleBtnStyle,
        fontSize: variant === "link" ? "0.85rem" : "0.8rem",
        opacity: disabled || busy ? 0.5 : 1,
        cursor: disabled || busy ? "not-allowed" : "pointer",
      }}
    >
      {busy ? "Fixing…" : "Troubleshoot"}
    </button>
  );
}

export function ErrorText({
  children,
  onTroubleshoot,
  troubleBusy,
  troubleDisabled,
}: {
  children: ReactNode;
  onTroubleshoot?: () => void;
  troubleBusy?: boolean;
  troubleDisabled?: boolean;
}) {
  if (!children) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "0.35rem",
      }}
    >
      <p
        role="alert"
        style={{
          margin: 0,
          color: "var(--danger)",
          textAlign: "center",
        }}
      >
        {children}
      </p>
      {onTroubleshoot && (
        <TroubleshootButton
          onClick={onTroubleshoot}
          busy={troubleBusy}
          disabled={troubleDisabled}
          variant="underError"
        />
      )}
    </div>
  );
}

export function StatusText({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      aria-live="polite"
      style={{
        margin: 0,
        textAlign: "center",
        color: "var(--muted)",
        padding: "2rem 1rem",
      }}
    >
      {children}
    </p>
  );
}
