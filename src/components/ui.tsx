"use client";

import { CSSProperties, ReactNode } from "react";

type ButtonProps = {
  children: ReactNode;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "ink";
  disabled?: boolean;
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
  onClick,
  className,
  style,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={className}
      style={{
        ...base,
        ...variants[variant],
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
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
