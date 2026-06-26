import type { ITheme } from "@xterm/xterm";

export interface TerminalThemeDef {
  id: string;
  name: string;
  xterm: ITheme;
  /** Ghost-text suggestion overlay color */
  ghostColor: string;
}


export const TERMINAL_THEMES: TerminalThemeDef[] = [
  {
    id: "pingnet-dark",
    name: "Pingnet Dark",
    ghostColor: "#4b5563",
    xterm: {
      background: "#08080f",
      foreground: "#e2e8f0",
      cursor: "#00c8a8",
      cursorAccent: "#08080f",
      selectionBackground: "#6366f140",
      black: "#1a1a2e", brightBlack: "#374151",
      red: "#ef4444", brightRed: "#f87171",
      green: "#22c55e", brightGreen: "#4ade80",
      yellow: "#f59e0b", brightYellow: "#fbbf24",
      blue: "#6366f1", brightBlue: "#818cf8",
      magenta: "#a855f7", brightMagenta: "#c084fc",
      cyan: "#00c8a8", brightCyan: "#34d399",
      white: "#e2e8f0", brightWhite: "#f8fafc",
    },
  },
  {
    id: "classic",
    name: "Classic",
    ghostColor: "#336633",
    xterm: {
      background: "#000000",
      foreground: "#cccccc",
      cursor: "#00ff00",
      cursorAccent: "#000000",
      selectionBackground: "#ffffff30",
      black: "#000000", brightBlack: "#555555",
      red: "#cc0000", brightRed: "#ff5555",
      green: "#00cc00", brightGreen: "#00ff00",
      yellow: "#cccc00", brightYellow: "#ffff55",
      blue: "#0066cc", brightBlue: "#5555ff",
      magenta: "#cc00cc", brightMagenta: "#ff55ff",
      cyan: "#00cccc", brightCyan: "#55ffff",
      white: "#cccccc", brightWhite: "#ffffff",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    ghostColor: "#6272a4",
    xterm: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      black: "#21222c", brightBlack: "#6272a4",
      red: "#ff5555", brightRed: "#ff6e6e",
      green: "#50fa7b", brightGreen: "#69ff94",
      yellow: "#f1fa8c", brightYellow: "#ffffa5",
      blue: "#bd93f9", brightBlue: "#d6acff",
      magenta: "#ff79c6", brightMagenta: "#ff92df",
      cyan: "#8be9fd", brightCyan: "#a4ffff",
      white: "#f8f8f2", brightWhite: "#ffffff",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    ghostColor: "#75715e",
    xterm: {
      background: "#272822",
      foreground: "#f8f8f2",
      cursor: "#f8f8f0",
      cursorAccent: "#272822",
      selectionBackground: "#49483e",
      black: "#272822", brightBlack: "#75715e",
      red: "#f92672", brightRed: "#ff669d",
      green: "#a6e22e", brightGreen: "#b8e855",
      yellow: "#e6db74", brightYellow: "#f4e589",
      blue: "#66d9ef", brightBlue: "#8be9fd",
      magenta: "#ae81ff", brightMagenta: "#c4a2ff",
      cyan: "#a1efe4", brightCyan: "#b8fff5",
      white: "#f8f8f2", brightWhite: "#ffffff",
    },
  },
  {
    id: "nord",
    name: "Nord",
    ghostColor: "#4c566a",
    xterm: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      black: "#3b4252", brightBlack: "#4c566a",
      red: "#bf616a", brightRed: "#d08770",
      green: "#a3be8c", brightGreen: "#b4d398",
      yellow: "#ebcb8b", brightYellow: "#f0d9a8",
      blue: "#81a1c1", brightBlue: "#88c0d0",
      magenta: "#b48ead", brightMagenta: "#c6a2c6",
      cyan: "#88c0d0", brightCyan: "#8fbcbb",
      white: "#e5e9f0", brightWhite: "#eceff4",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    ghostColor: "#586e75",
    xterm: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#839496",
      cursorAccent: "#002b36",
      selectionBackground: "#073642",
      black: "#073642", brightBlack: "#586e75",
      red: "#dc322f", brightRed: "#cb4b16",
      green: "#859900", brightGreen: "#93a1a1",
      yellow: "#b58900", brightYellow: "#eee8d5",
      blue: "#268bd2", brightBlue: "#2aa198",
      magenta: "#d33682", brightMagenta: "#6c71c4",
      cyan: "#2aa198", brightCyan: "#839496",
      white: "#eee8d5", brightWhite: "#fdf6e3",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    ghostColor: "#93a1a1",
    xterm: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#657b83",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5",
      black: "#073642", brightBlack: "#586e75",
      red: "#dc322f", brightRed: "#cb4b16",
      green: "#859900", brightGreen: "#93a1a1",
      yellow: "#b58900", brightYellow: "#eee8d5",
      blue: "#268bd2", brightBlue: "#2aa198",
      magenta: "#d33682", brightMagenta: "#6c71c4",
      cyan: "#2aa198", brightCyan: "#839496",
      white: "#eee8d5", brightWhite: "#fdf6e3",
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    ghostColor: "#8c959f",
    xterm: {
      background: "#ffffff",
      foreground: "#24292f",
      cursor: "#24292f",
      cursorAccent: "#ffffff",
      selectionBackground: "#b6e3ff80",
      black: "#24292f", brightBlack: "#57606a",
      red: "#cf222e", brightRed: "#a40e26",
      green: "#116329", brightGreen: "#1a7f37",
      yellow: "#4d2d00", brightYellow: "#633c01",
      blue: "#0969da", brightBlue: "#0550ae",
      magenta: "#8250df", brightMagenta: "#6639ba",
      cyan: "#1b7c83", brightCyan: "#3192aa",
      white: "#6e7781", brightWhite: "#24292f",
    },
  },
];

export const DEFAULT_TERMINAL_THEME_ID = "pingnet-dark";
export const TERMINAL_THEME_STORAGE_KEY = "pingnet_terminal_theme";

export function getTerminalTheme(id: string): TerminalThemeDef {
  return TERMINAL_THEMES.find((t) => t.id === id) ?? TERMINAL_THEMES[0];
}

export function readTerminalThemeId(): string {
  try {
    const raw = localStorage.getItem(TERMINAL_THEME_STORAGE_KEY);
    if (raw && TERMINAL_THEMES.some((t) => t.id === raw)) return raw;
  } catch { /* ignore */ }
  return DEFAULT_TERMINAL_THEME_ID;
}

export function saveTerminalThemeId(id: string): void {
  try {
    localStorage.setItem(TERMINAL_THEME_STORAGE_KEY, id);
  } catch { /* ignore */ }
}
