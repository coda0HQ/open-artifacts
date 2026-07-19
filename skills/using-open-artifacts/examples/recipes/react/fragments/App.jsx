import { useState } from "react";

// A minimal, theme-aware React component. It reads the viewer's design tokens
// (--oa-*, set by the frame's reset in both light and dark) via inline styles,
// so it needs no separate stylesheet — react recipes ship one JSX/TSX entry and
// the builder precompiles + inlines React into a self-contained bundle.
export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
      }}
    >
      <div style={{ textAlign: "center", display: "grid", gap: "1rem" }}>
        <h1 style={{ margin: 0, fontSize: "2rem", color: "var(--oa-fg)" }}>
          {count}
        </h1>
        <div
          style={{ display: "flex", gap: ".5rem", justifyContent: "center" }}
        >
          <button type="button" onClick={() => setCount((n) => n - 1)}>
            −
          </button>
          <button
            type="button"
            onClick={() => setCount(0)}
            style={{ color: "var(--oa-muted)" }}
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => setCount((n) => n + 1)}
            style={{
              background: "var(--oa-accent)",
              color: "var(--oa-accent-on)",
              border: 0,
              borderRadius: "6px",
              padding: ".4rem .9rem",
              cursor: "pointer",
            }}
          >
            +
          </button>
        </div>
      </div>
    </main>
  );
}
