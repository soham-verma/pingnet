import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  sessionId: string;
  isConnected: boolean;
  /** Command strings sorted by recency — used for ghost-text suggestions. */
  suggestions?: string[];
  /** Called whenever the user submits a command (presses Enter). */
  onCommand?: (cmd: string) => void;
  /** Additional session IDs to mirror all input to (broadcast mode). */
  broadcastTo?: string[];
}

// Pull xterm's internal cell dimensions — more accurate than measuring DOM.
// Falls back to a sensible approximation if the internal API ever changes.
function getCellDims(term: Terminal): { w: number; h: number } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dims = (term as any)._core._renderService.dimensions;
    return {
      w: dims.actualCellWidth ?? dims.css?.cell?.width ?? 8.4,
      h: dims.actualCellHeight ?? dims.css?.cell?.height ?? 18.2,
    };
  } catch {
    return { w: 8.4, h: 18.2 };
  }
}

export default function SSHTerminal({ sessionId, isConnected, suggestions = [], onCommand, broadcastTo = [] }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);

  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unlistenOutputRef = useRef<(() => void) | null>(null);
  const unlistenCloseRef = useRef<(() => void) | null>(null);

  // Keep latest suggestions + onCommand in refs so the stable onData handler sees fresh values.
  const suggestionsRef = useRef(suggestions);
  useEffect(() => { suggestionsRef.current = suggestions; }, [suggestions]);
  const onCommandRef = useRef(onCommand);
  useEffect(() => { onCommandRef.current = onCommand; }, [onCommand]);

  // isConnected via ref — avoids stale closure in the useEffect onData handler
  const isConnectedRef = useRef(isConnected);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);

  // broadcastTo via ref so the stable onData handler sees fresh values
  const broadcastToRef = useRef(broadcastTo);
  useEffect(() => { broadcastToRef.current = broadcastTo; }, [broadcastTo]);

  // Commands that exit / restart the shell — never ghost-suggest these
  const SKIP_SUGGEST = new Set(["exit", "logout", "bye", "quit", "reboot", "shutdown", "halt", "poweroff"]);

  // What the user has typed since the last prompt — used ONLY for ghost-text matching.
  // Tab completions from bash arrive as SSH output, not as key presses, so this
  // buffer deliberately does NOT represent the true command line — we read that
  // from the xterm buffer instead (see extractCommandFromLine).
  const inputBufRef = useRef("");
  // Ghost completion currently shown (the *suffix* only, not the full command)
  const ghostCompletionRef = useRef("");

  // ── Ghost text helpers ─────────────────────────────────────────────────────

  const hideGhost = () => {
    if (ghostRef.current) {
      ghostRef.current.style.display = "none";
      ghostRef.current.textContent = "";
    }
    ghostCompletionRef.current = "";
  };

  const showGhost = (completion: string) => {
    const term = termRef.current;
    const ghost = ghostRef.current;
    if (!ghost || !term) return;

    ghostCompletionRef.current = completion;
    ghost.textContent = completion;

    const { w, h } = getCellDims(term);
    const cx = term.buffer.active.cursorX;
    const cy = term.buffer.active.cursorY;

    // 8 px = the padding on the container div below
    ghost.style.left = `${8 + cx * w}px`;
    ghost.style.top  = `${8 + cy * h}px`;
    ghost.style.display = "block";
  };

  const updateGhost = () => {
    const buf = inputBufRef.current;
    // Don't suggest until user has typed at least 2 chars
    if (buf.length < 2) { hideGhost(); return; }

    const match = suggestionsRef.current.find(s => {
      if (!s.startsWith(buf) || s === buf) return false;
      // Never suggest commands that would close the shell
      const baseCmd = s.trim().split(/\s+/)[0];
      return !SKIP_SUGGEST.has(baseCmd);
    });

    if (match) {
      // Strip any control characters from the suffix before showing
      const suffix = match.slice(buf.length).replace(/[\r\n\x00-\x1f\x7f]/g, "");
      if (suffix) showGhost(suffix);
      else hideGhost();
    } else {
      hideGhost();
    }
  };

  // ── Read actual command from xterm buffer ──────────────────────────────────
  //
  // We can't rely on inputBufRef for history because bash tab-completions and
  // up-arrow history replacements arrive as *output* from SSH, not as key
  // presses. So we read what's actually rendered on the current line when Enter
  // is pressed, then strip the shell prompt.
  //
  // Handles: $  #  %  ❯  ›  (covers bash/zsh/fish default prompts)
  const extractCommandFromLine = (term: Terminal): string => {
    const cy = term.buffer.active.cursorY;
    const line = term.buffer.active.getLine(cy);
    if (!line) return "";

    // translateToString(true) trims trailing whitespace automatically
    const text = line.translateToString(true);

    // Only record if the line starts with a recognisable shell prompt.
    // This prevents saving commands typed inside sub-tools (python REPL,
    // mysql, psql, node, etc.) which have different prompt styles.
    const match = text.match(/(?:[$#%❯›])\s+(.+)$/);
    if (match) return match[1].trim();

    // Not at a shell prompt — return empty so nothing gets saved to history
    return "";
  };

  // ── Terminal setup ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background:         "var(--bg)",
        foreground:         "var(--text)",
        cursor:             "#00c8a8",
        cursorAccent:       "var(--bg)",
        selectionBackground:"#6366f140",
        black:        "var(--bg4)", brightBlack:   "var(--text4)",
        red:          "#ef4444", brightRed:     "#f87171",
        green:        "#22c55e", brightGreen:   "#4ade80",
        yellow:       "#f59e0b", brightYellow:  "#fbbf24",
        blue:         "#6366f1", brightBlue:    "#818cf8",
        magenta:      "#a855f7", brightMagenta: "#c084fc",
        cyan:         "#00c8a8", brightCyan:    "#34d399",
        white:        "var(--text)", brightWhite:   "#f8fafc",
      },
      fontFamily:   '"JetBrains Mono", "Fira Code", monospace',
      fontSize:     13,
      lineHeight:   1.4,
      cursorBlink:  true,
      cursorStyle:  "block",
      scrollback:   5000,
      allowTransparency: true,
    });

    const fitAddon   = new FitAddon();
    const linksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(linksAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current  = fitAddon;

    // ── Custom key handler: intercept Tab / Right-arrow for completions ──────
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== "keydown") return true;

      const hasCompletion = !!ghostCompletionRef.current;

      // Always prevent Tab from moving DOM focus away from the terminal.
      // Without this, the browser shifts focus to the next element (the tab
      // close button), and a subsequent Enter keystroke closes the terminal.
      if (event.key === "Tab") {
        event.preventDefault();
        if (hasCompletion) {
          const completion = ghostCompletionRef.current;
          invoke("ssh_send", { sessionId, data: completion }).catch(() => {});
          inputBufRef.current += completion;
          hideGhost();
          return false; // consumed — don't let xterm send Tab to SSH
        }
        return true; // no ghost — let xterm forward Tab to SSH for bash completion
      }

      if (hasCompletion && event.key === "ArrowRight") {
        event.preventDefault();
        const completion = ghostCompletionRef.current;
        invoke("ssh_send", { sessionId, data: completion }).catch(() => {});
        inputBufRef.current += completion;
        hideGhost();
        return false;
      }

      // Any other special key while ghost is visible → clear ghost
      // (user changed direction, hit Ctrl+something, etc.)
      if (event.key.length > 1 && event.key !== "Backspace") {
        hideGhost();
        // Also clear our line buffer on navigation keys — we lose track of cursor
        if (
          event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "ArrowDown" ||
          event.key === "Home" || event.key === "End"
        ) {
          inputBufRef.current = "";
        }
      }

      return true;
    });

    // ── onData: track line, send to SSH ─────────────────────────────────────
    term.onData((data: string) => {
      if (!isConnectedRef.current) return;

      if (data === "\r") {
        // Enter — read actual command from the rendered xterm buffer, not
        // inputBufRef, so tab-completions and up-arrow replacements are captured.
        const cmd = extractCommandFromLine(term);
        if (cmd) onCommandRef.current?.(cmd);
        inputBufRef.current = "";
        hideGhost();
      } else if (data === "\x7f") {
        // Backspace
        inputBufRef.current = inputBufRef.current.slice(0, -1);
        updateGhost();
      } else if (data === "\x03" || data === "\x04") {
        // Ctrl+C / Ctrl+D — clear line
        inputBufRef.current = "";
        hideGhost();
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        // Printable character
        inputBufRef.current += data;
        updateGhost();
      } else {
        // Control sequence (paste, ESC, etc.) — stop tracking to avoid corruption
        if (data.startsWith("\x1b") || data.length > 1) {
          inputBufRef.current = "";
          hideGhost();
        }
      }

      invoke("ssh_send", { sessionId, data }).catch(() => {});
      // Broadcast to mirrored sessions
      broadcastToRef.current.forEach(targetId => {
        invoke("ssh_send", { sessionId: targetId, data }).catch(() => {});
      });
    });

    // ── Listen for terminal output from Rust ─────────────────────────────────
    // Use a cancelled flag so that if the component unmounts before the listen()
    // promise resolves, we call the returned unlisten immediately rather than
    // storing it — otherwise the listener leaks permanently.
    let cleanedUp = false;

    listen<string>(`ssh-output-${sessionId}`, (event) => {
      term.write(event.payload);
    }).then((ul) => {
      if (cleanedUp) { ul(); return; }
      unlistenOutputRef.current = ul;
    });

    // ── Listen for connection closed ─────────────────────────────────────────
    listen<void>(`ssh-closed-${sessionId}`, () => {
      term.writeln("\r\n\x1b[33m[Connection closed]\x1b[0m");
      hideGhost();
      inputBufRef.current = "";
    }).then((ul) => {
      if (cleanedUp) { ul(); return; }
      unlistenCloseRef.current = ul;
    });

    // ── ResizeObserver ────────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      const d = fitAddon.proposeDimensions();
      if (d) invoke("ssh_resize", { sessionId, cols: d.cols, rows: d.rows }).catch(() => {});
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      cleanedUp = true;
      unlistenOutputRef.current?.();
      unlistenCloseRef.current?.();
      ro.disconnect();
      term.dispose();
    };
    // sessionId is stable per tab; intentionally not re-running on isConnected change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Show "[Connected]" banner once when session goes live
  useEffect(() => {
    if (isConnected && termRef.current) {
      termRef.current.writeln("\x1b[32m[Connected]\x1b[0m\r");
    }
  }, [isConnected]);

  return (
    // Wrapper is position:relative so the ghost div can be positioned inside it
    <div className="relative w-full h-full overflow-hidden">
      {/* xterm mounts here; 8 px padding keeps text off the edges */}
      <div ref={containerRef} className="absolute inset-0" style={{ padding: "8px" }} />

      {/* Ghost-text suggestion overlay */}
      <div
        ref={ghostRef}
        style={{
          position:   "absolute",
          display:    "none",
          pointerEvents: "none",
          userSelect: "none",
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          fontSize:   "13px",
          lineHeight: "1.4",
          color:      "var(--text4)",   // muted — clearly "ghost"
          whiteSpace: "pre",
          zIndex:     20,
        }}
      />
    </div>
  );
}
