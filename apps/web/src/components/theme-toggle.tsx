"use client";

import { useEffect, useState } from "react";

type ThemeChoice = "system" | "light" | "dark";

const NEXT: Readonly<Record<ThemeChoice, ThemeChoice>> = {
  dark: "system",
  light: "dark",
  system: "light",
};

/** Cycles system → light → dark. While "system", the attribute is removed so
 *  the stylesheet's prefers-color-scheme block decides. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    const stored = window.localStorage.getItem("asi-theme");
    if (stored === "light" || stored === "dark") setChoice(stored);
  }, []);

  function cycle(): void {
    const next = NEXT[choice];
    setChoice(next);
    if (next === "system") {
      window.localStorage.removeItem("asi-theme");
      delete document.documentElement.dataset.asiTheme;
    } else {
      window.localStorage.setItem("asi-theme", next);
      document.documentElement.dataset.asiTheme = next;
    }
  }

  return (
    <button
      aria-label={`Theme: ${choice}. Activate to switch.`}
      onClick={cycle}
      style={{
        border: "var(--asi-border-width) solid var(--asi-border)",
        borderRadius: "var(--asi-radius-md)",
        background: "var(--asi-surface)",
        color: "var(--asi-text)",
        cursor: "pointer",
        insetBlockEnd: "var(--asi-space-8)",
        insetInlineEnd: "var(--asi-space-8)",
        minBlockSize: "var(--asi-control-md)",
        paddingInline: "var(--asi-space-4)",
        position: "fixed",
        zIndex: 30,
      }}
      title={`Theme: ${choice}`}
      type="button"
    >
      {choice === "dark" ? "●" : choice === "light" ? "○" : "◐"}
    </button>
  );
}
