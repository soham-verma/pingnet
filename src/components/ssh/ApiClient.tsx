import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Header { id: string; enabled: boolean; name: string; value: string; }
interface EnvVar  { id: string; enabled: boolean; key: string; value: string; }

type BodyType = "none" | "json" | "form" | "text";
type ReqTab   = "headers" | "body" | "params" | "env";
type RespTab  = "body" | "headers";
type Method   = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

interface SavedRequest {
  id: string;
  name: string;
  method: Method;
  url: string;
  headers: Header[];
  body: string;
  bodyType: BodyType;
  savedAt: number;
}

interface HttpHeader { name: string; value: string; }
interface HttpResponse {
  status: number;
  status_text: string;
  headers: HttpHeader[];
  body: string;
  latency_ms: number;
  tunneled: boolean;
}

// ── Storage ───────────────────────────────────────────────────────────────────

function storageKey(hostId: string) { return `pingnet_api_${hostId}`; }

function loadStorage(hostId: string): { collections: SavedRequest[]; envVars: EnvVar[] } {
  try {
    const raw = localStorage.getItem(storageKey(hostId));
    if (!raw) return { collections: [], envVars: [] };
    return JSON.parse(raw);
  } catch { return { collections: [], envVars: [] }; }
}

function saveStorage(hostId: string, collections: SavedRequest[], envVars: EnvVar[]) {
  localStorage.setItem(storageKey(hostId), JSON.stringify({ collections, envVars }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// crypto.randomUUID() provides full RFC 4122 UUID entropy vs ~30 bits from Math.random()
function uid() { return crypto.randomUUID(); }

function emptyHeader(): Header { return { id: uid(), enabled: true, name: "", value: "" }; }
function emptyEnvVar(): EnvVar  { return { id: uid(), enabled: true, key: "", value: "" }; }

function interpolate(s: string, envVars: EnvVar[]): string {
  return s.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const found = envVars.find(v => v.enabled && v.key === key.trim());
    return found ? found.value : `{{${key}}}`;
  });
}

function parseUrl(url: string): { host: string; port: number; path: string } | null {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
    const path = (u.pathname || "/") + (u.search || "");
    return { host: u.hostname, port, path };
  } catch { return null; }
}

const METHOD_COLORS: Record<Method, string> = {
  GET:     "#34d399",
  POST:    "#60a5fa",
  PUT:     "#f59e0b",
  PATCH:   "#a78bfa",
  DELETE:  "#f87171",
  HEAD:    "var(--text3)",
  OPTIONS: "var(--text3)",
};

const METHOD_BG: Record<Method, string> = {
  GET:     "#0d2e22",
  POST:    "#0d1e3a",
  PUT:     "#2e1f05",
  PATCH:   "#1a1530",
  DELETE:  "#2e0d0d",
  HEAD:    "#141414",
  OPTIONS: "#141414",
};

function statusColor(code: number) {
  if (code >= 500) return "#f87171";
  if (code >= 400) return "#f59e0b";
  if (code >= 300) return "#a78bfa";
  if (code >= 200) return "#34d399";
  return "var(--text3)";
}

function highlightJson(json: string): string {
  return json
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = "color:#60a5fa";
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? "color:#93c5fd;font-weight:600" : "color:#86efac";
        } else if (/true|false/.test(match)) {
          cls = "color:#f59e0b";
        } else if (/null/.test(match)) {
          cls = "color:#f87171";
        }
        return `<span style="${cls}">${match}</span>`;
      }
    );
}

function tryPrettyJson(raw: string): { pretty: string; isJson: boolean } {
  try {
    const parsed = JSON.parse(raw);
    return { pretty: JSON.stringify(parsed, null, 2), isJson: true };
  } catch {
    return { pretty: raw, isJson: false };
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function HeaderRow({ h, onChange, onRemove }: {
  h: Header;
  onChange: (field: keyof Header, val: string | boolean) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 group">
      <input
        type="checkbox"
        checked={h.enabled}
        onChange={e => onChange("enabled", e.target.checked)}
        className="accent-[#6366f1] shrink-0 mt-px"
      />
      <input
        className="flex-1 min-w-0 bg-[var(--bg2)] border border-[var(--border)] rounded-md px-3 py-1.5 text-[12px] text-[var(--text)] placeholder-[var(--text5)] focus:outline-none focus:border-[#6366f150] transition-colors font-mono"
        placeholder="Header name"
        value={h.name}
        onChange={e => onChange("name", e.target.value)}
      />
      <input
        className="flex-1 min-w-0 bg-[var(--bg2)] border border-[var(--border)] rounded-md px-3 py-1.5 text-[12px] text-[var(--text)] placeholder-[var(--text5)] focus:outline-none focus:border-[#6366f150] transition-colors font-mono"
        placeholder="Value"
        value={h.value}
        onChange={e => onChange("value", e.target.value)}
      />
      <button
        onClick={onRemove}
        className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-[var(--text4)] hover:text-[#ef4444] transition-all shrink-0"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  hostId: string;
  sessionId: string | null;
}

export default function ApiClient({ hostId, sessionId }: Props) {
  // ── Request state ──
  const [method, setMethod]       = useState<Method>("GET");
  const [url, setUrl]             = useState("");
  const [reqTab, setReqTab]       = useState<ReqTab>("headers");
  const [headers, setHeaders]     = useState<Header[]>([emptyHeader()]);
  const [body, setBody]           = useState("");
  const [bodyType, setBodyType]   = useState<BodyType>("none");
  const [tunnel, setTunnel]       = useState(false);
  const [sending, setSending]     = useState(false);
  const [methodOpen, setMethodOpen] = useState(false);
  const methodRef = useRef<HTMLDivElement>(null);

  // ── Response state ──
  const [response, setResponse]   = useState<HttpResponse | null>(null);
  const [respTab, setRespTab]     = useState<RespTab>("body");
  const [error, setError]         = useState<string | null>(null);

  // ── Collections + env ──
  const [collections, setCollections] = useState<SavedRequest[]>([]);
  const [envVars, setEnvVars]         = useState<EnvVar[]>([emptyEnvVar()]);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName]       = useState("");
  const [showCollections, setShowCollections] = useState(true);

  useEffect(() => {
    const stored = loadStorage(hostId);
    setCollections(stored.collections);
    setEnvVars(stored.envVars.length ? stored.envVars : [emptyEnvVar()]);
  }, [hostId]);

  // Close method dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (methodRef.current && !methodRef.current.contains(e.target as Node)) {
        setMethodOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const persistCollections = useCallback((c: SavedRequest[], e: EnvVar[]) => {
    saveStorage(hostId, c, e);
  }, [hostId]);

  // ── Send ──────────────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    if (!url.trim()) return;
    setSending(true);
    setError(null);
    setResponse(null);

    const resolvedUrl = interpolate(url.trim(), envVars);
    const activeHeaders: HttpHeader[] = headers
      .filter(h => h.enabled && h.name.trim())
      .map(h => ({
        name: interpolate(h.name, envVars),
        value: interpolate(h.value, envVars),
      }));

    const bodyPayload = bodyType !== "none" ? interpolate(body, envVars) : undefined;

    try {
      let resp: HttpResponse;
      if (tunnel && sessionId) {
        const parsed = parseUrl(resolvedUrl);
        if (!parsed) throw new Error("Invalid URL for tunnel mode");
        resp = await invoke<HttpResponse>("tunnel_http_request", {
          sessionId,
          remoteHost: parsed.host,
          remotePort: parsed.port,
          method,
          path: parsed.path,
          headers: activeHeaders,
          body: bodyPayload ?? null,
        });
      } else {
        resp = await invoke<HttpResponse>("make_http_request", {
          method,
          url: resolvedUrl,
          headers: activeHeaders,
          body: bodyPayload ?? null,
        });
      }
      setResponse(resp);
      setRespTab("body");
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }, [url, method, headers, body, bodyType, envVars, tunnel, sessionId]);

  // ── Collections ───────────────────────────────────────────────────────────

  function saveRequest() {
    if (!saveName.trim()) return;
    const req: SavedRequest = {
      id: uid(), name: saveName.trim(), method, url, headers, body, bodyType,
      savedAt: Date.now(),
    };
    const updated = [req, ...collections];
    setCollections(updated);
    persistCollections(updated, envVars);
    setShowSaveModal(false);
    setSaveName("");
  }

  function loadRequest(req: SavedRequest) {
    setMethod(req.method);
    setUrl(req.url);
    setHeaders(req.headers.length ? req.headers : [emptyHeader()]);
    setBody(req.body);
    setBodyType(req.bodyType);
  }

  function deleteCollection(id: string) {
    const updated = collections.filter(c => c.id !== id);
    setCollections(updated);
    persistCollections(updated, envVars);
  }

  // ── Header / env helpers ──────────────────────────────────────────────────

  function updateHeader(id: string, field: keyof Header, val: string | boolean) {
    setHeaders(prev => prev.map(h => h.id === id ? { ...h, [field]: val } : h));
  }
  function addHeader() { setHeaders(prev => [...prev, emptyHeader()]); }
  function removeHeader(id: string) {
    setHeaders(prev => prev.length > 1 ? prev.filter(h => h.id !== id) : prev);
  }

  function updateEnvVar(id: string, field: keyof EnvVar, val: string | boolean) {
    const updated = envVars.map(v => v.id === id ? { ...v, [field]: val } : v);
    setEnvVars(updated);
    persistCollections(collections, updated);
  }
  function addEnvVar() { setEnvVars(prev => [...prev, emptyEnvVar()]); }
  function removeEnvVar(id: string) {
    const updated = envVars.length > 1 ? envVars.filter(v => v.id !== id) : envVars;
    setEnvVars(updated);
    persistCollections(collections, updated);
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const { pretty: prettyBody, isJson } = response
    ? tryPrettyJson(response.body)
    : { pretty: "", isJson: false };

  const activeHeaderCount = headers.filter(h => h.enabled && h.name.trim()).length;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden" style={{ background: "var(--bg)" }}>

      {/* ── Collections sidebar ── */}
      {showCollections && (
        <div
          className="flex flex-col shrink-0 border-r border-[var(--border)] overflow-hidden"
          style={{ width: 220, background: "var(--bg1)" }}
        >
          <div className="px-3 py-2.5 border-b border-[var(--border)] flex items-center justify-between shrink-0">
            <span className="text-[10px] text-[var(--text3)] tracking-widest uppercase font-semibold">Collections</span>
            <button
              onClick={() => setShowSaveModal(true)}
              title="Save current request"
              className="w-5 h-5 flex items-center justify-center rounded text-[var(--text3)] hover:text-[#6366f1] hover:bg-[var(--bg4)] transition-all text-base leading-none"
            >+</button>
          </div>

          <div className="flex-1 overflow-y-auto py-1">
            {collections.length === 0 ? (
              <p className="text-[11px] text-[var(--text5)] px-4 py-5 text-center leading-relaxed">
                No saved requests yet.<br />Hit + to save the current one.
              </p>
            ) : collections.map(req => (
              <div
                key={req.id}
                className="group flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--bg3)] transition-colors"
                onClick={() => loadRequest(req)}
              >
                <span
                  className="text-[10px] font-bold font-mono shrink-0 w-8"
                  style={{ color: METHOD_COLORS[req.method] }}
                >
                  {req.method.slice(0, 3)}
                </span>
                <span className="text-[11.5px] text-[var(--text3)] truncate flex-1">{req.name}</span>
                <button
                  className="opacity-0 group-hover:opacity-100 text-[var(--text4)] hover:text-[#ef4444] transition-all shrink-0"
                  onClick={e => { e.stopPropagation(); deleteCollection(req.id); }}
                >
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                    <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Main panel ── */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">

        {/* ── URL bar ── */}
        <div
          className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border)] shrink-0"
          style={{ background: "var(--bg1)" }}
        >
          {/* Sidebar toggle */}
          <button
            onClick={() => setShowCollections(v => !v)}
            title="Toggle collections"
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-[var(--text4)] hover:text-[var(--text3)] hover:bg-[var(--bg3)] transition-all"
          >
            <svg width="13" height="11" viewBox="0 0 13 11" fill="none">
              <rect y="0" width="13" height="1.5" rx="0.75" fill="currentColor"/>
              <rect y="4.5" width="13" height="1.5" rx="0.75" fill="currentColor"/>
              <rect y="9" width="13" height="1.5" rx="0.75" fill="currentColor"/>
            </svg>
          </button>

          {/* Method picker — custom dropdown */}
          <div className="relative shrink-0" ref={methodRef}>
            <button
              onClick={() => setMethodOpen(v => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12px] font-bold font-mono transition-all select-none"
              style={{
                color: METHOD_COLORS[method],
                background: METHOD_BG[method],
                borderColor: METHOD_COLORS[method] + "40",
              }}
            >
              {method}
              <svg width="8" height="5" viewBox="0 0 8 5" fill="none" style={{ opacity: 0.6 }}>
                <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {methodOpen && (
              <div
                className="absolute top-full left-0 mt-1 z-50 rounded-lg border border-[var(--border)] py-1 min-w-[110px] shadow-2xl"
                style={{ background: "var(--bg2)" }}
              >
                {(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"] as Method[]).map(m => (
                  <button
                    key={m}
                    onClick={() => { setMethod(m); setMethodOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] font-mono font-bold hover:bg-[var(--bg4)] transition-colors text-left"
                    style={{ color: METHOD_COLORS[m] }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* URL input */}
          <input
            className="flex-1 min-w-0 bg-[var(--bg2)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-[13px] text-[var(--text)] placeholder-[var(--text5)] focus:outline-none focus:border-[#6366f150] transition-colors font-mono"
            placeholder="https://api.example.com/endpoint  or  http://localhost:8000/…"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSend()}
          />

          {/* Tunnel toggle */}
          <button
            title={tunnel ? "SSH tunnel ON" : "SSH tunnel OFF — click to route through remote"}
            onClick={() => setTunnel(v => !v)}
            disabled={!sessionId}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold transition-all disabled:opacity-30"
            style={tunnel
              ? { background: "var(--bg4)", borderColor: "#6366f1", color: "#818cf8" }
              : { background: "transparent", borderColor: "var(--border)", color: "var(--text3)" }
            }
          >
            <svg width="13" height="10" viewBox="0 0 13 10" fill="none">
              <path d="M1 5h11M9 2l3 3-3 3M4 2L1 5l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Tunnel
          </button>

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={sending || !url.trim()}
            className="shrink-0 flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[13px] font-semibold transition-all disabled:opacity-40"
            style={{ background: "#6366f1", color: "#fff" }}
          >
            {sending ? (
              <span className="opacity-70">…</span>
            ) : (
              <>
                Send
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M1 5.5h9M6.5 2l3.5 3.5L6.5 9" stroke="white" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </>
            )}
          </button>
        </div>

        {/* ── Request + Response split ── */}
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

          {/* Request config — auto-height, capped so response always has room */}
          <div className="flex flex-col" style={{ flex: "0 0 auto", minHeight: 110, maxHeight: "38%" }}>

            {/* Request tabs */}
            <div
              className="flex items-center px-3 border-b border-[var(--border)] shrink-0"
              style={{ background: "var(--bg1)" }}
            >
              {(["headers","body","params","env"] as ReqTab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setReqTab(t)}
                  className="px-3 py-2 text-[11.5px] font-medium capitalize transition-colors border-b-2 -mb-px"
                  style={reqTab === t
                    ? { color: "#818cf8", borderColor: "#6366f1" }
                    : { color: "var(--text4)", borderColor: "transparent" }}
                >
                  {t === "env" ? "Env Vars" : t}
                  {t === "headers" && activeHeaderCount > 0 && (
                    <span className="ml-1 text-[9px] px-1 py-px rounded-full font-semibold" style={{ background: "var(--bg4)", color: "#6366f1" }}>
                      {activeHeaderCount}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Request tab content */}
            <div className="flex-1 overflow-y-auto px-4 py-3" style={{ background: "var(--bg)" }}>

              {reqTab === "headers" && (
                <div className="space-y-1.5">
                  {headers.map(h => (
                    <HeaderRow
                      key={h.id}
                      h={h}
                      onChange={(f, v) => updateHeader(h.id, f, v)}
                      onRemove={() => removeHeader(h.id)}
                    />
                  ))}
                  <button
                    onClick={addHeader}
                    className="text-[11px] text-[var(--text4)] hover:text-[#6366f1] transition-colors mt-1"
                  >
                    + Add header
                  </button>
                </div>
              )}

              {reqTab === "body" && (
                <div className="space-y-2.5">
                  <div className="flex gap-1">
                    {(["none","json","form","text"] as BodyType[]).map(bt => (
                      <button
                        key={bt}
                        onClick={() => setBodyType(bt)}
                        className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-all"
                        style={bodyType === bt
                          ? { background: "#6366f1", color: "#fff" }
                          : { background: "var(--bg2)", color: "var(--text3)", border: "1px solid var(--border)" }}
                      >
                        {bt === "none" ? "None" : bt === "json" ? "JSON" : bt === "form" ? "Form" : "Text"}
                      </button>
                    ))}
                  </div>
                  {bodyType !== "none" && (
                    <textarea
                      className="w-full bg-[var(--bg2)] border border-[var(--border)] rounded-lg px-3 py-2 text-[12px] text-[var(--text)] font-mono placeholder-[var(--text5)] focus:outline-none focus:border-[#6366f150] transition-colors resize-none"
                      rows={5}
                      placeholder={bodyType === "json" ? '{\n  "key": "value"\n}' : bodyType === "form" ? "key=value&key2=value2" : "Request body…"}
                      value={body}
                      onChange={e => setBody(e.target.value)}
                    />
                  )}
                </div>
              )}

              {reqTab === "params" && (
                <p className="text-[12px] text-[var(--text4)] leading-relaxed">
                  Append query params to the URL directly, e.g.{" "}
                  <span className="font-mono text-[#6366f1]">?page=1&limit=20</span>
                </p>
              )}

              {reqTab === "env" && (
                <div className="space-y-1.5">
                  <p className="text-[11px] text-[var(--text4)] mb-2">
                    Use <span className="font-mono text-[#818cf8]">{"{{VARIABLE}}"}</span> in URL, headers, and body.
                  </p>
                  {envVars.map(v => (
                    <div key={v.id} className="flex items-center gap-2 group">
                      <input
                        type="checkbox"
                        checked={v.enabled}
                        onChange={e => updateEnvVar(v.id, "enabled", e.target.checked)}
                        className="accent-[#6366f1] shrink-0"
                      />
                      <input
                        className="flex-1 min-w-0 bg-[var(--bg2)] border border-[var(--border)] rounded-md px-3 py-1.5 text-[12px] text-[var(--text)] placeholder-[var(--text5)] focus:outline-none focus:border-[#6366f150] transition-colors font-mono"
                        placeholder="VARIABLE_NAME"
                        value={v.key}
                        onChange={e => updateEnvVar(v.id, "key", e.target.value)}
                      />
                      <input
                        className="flex-1 min-w-0 bg-[var(--bg2)] border border-[var(--border)] rounded-md px-3 py-1.5 text-[12px] text-[var(--text)] placeholder-[var(--text5)] focus:outline-none focus:border-[#6366f150] transition-colors font-mono"
                        placeholder="value"
                        value={v.value}
                        onChange={e => updateEnvVar(v.id, "value", e.target.value)}
                      />
                      <button
                        onClick={() => removeEnvVar(v.id)}
                        className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center text-[var(--text4)] hover:text-[#ef4444] transition-all shrink-0"
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addEnvVar}
                    className="text-[11px] text-[var(--text4)] hover:text-[#6366f1] transition-colors mt-1"
                  >
                    + Add variable
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ── Response ── */}
          <div className="flex flex-col flex-1 min-h-0 border-t border-[var(--border)]">

            {/* Response meta bar */}
            <div
              className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] shrink-0"
              style={{ background: "var(--bg1)" }}
            >
              <div className="flex-1 flex items-center gap-3 min-w-0">
                {response ? (
                  <>
                    <span
                      className="text-[13px] font-bold font-mono shrink-0"
                      style={{ color: statusColor(response.status) }}
                    >
                      {response.status} {response.status_text}
                    </span>
                    <span className="text-[11px] text-[var(--text4)] shrink-0">{response.latency_ms}ms</span>
                    <span className="text-[11px] text-[var(--text4)] shrink-0">{response.body.length}B</span>
                    {response.tunneled && (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0"
                        style={{ background: "var(--bg4)", color: "#818cf8", border: "1px solid #6366f130" }}
                      >
                        via tunnel
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-[11.5px] text-[var(--text5)]">
                    {sending ? "Sending…" : error ? "" : "Hit Send to see a response"}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-0.5 shrink-0">
                {(["body","headers"] as RespTab[]).map(t => (
                  <button
                    key={t}
                    onClick={() => setRespTab(t)}
                    className="px-2.5 py-1 text-[11px] font-medium capitalize transition-all rounded-md"
                    style={respTab === t
                      ? { color: "#818cf8", background: "var(--bg4)" }
                      : { color: "var(--text4)" }}
                  >
                    {t}
                  </button>
                ))}
                {response && (
                  <button
                    onClick={() => navigator.clipboard.writeText(response.body)}
                    title="Copy response body"
                    className="ml-1 px-2 py-1 rounded-md text-[var(--text4)] hover:text-[var(--text2)] transition-colors"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.1"/>
                      <path d="M3.5 8.5H2A1.5 1.5 0 0 1 .5 7V2A1.5 1.5 0 0 1 2 .5h5A1.5 1.5 0 0 1 8.5 2v1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* Response content */}
            <div className="flex-1 min-h-0 overflow-auto p-4" style={{ background: "var(--bg)" }}>
              {error && (
                <div
                  className="rounded-lg border px-4 py-3"
                  style={{ background: "#160808", borderColor: "#ef444425" }}
                >
                  <p className="text-[12.5px] text-[#f87171] font-mono leading-relaxed">{error}</p>
                </div>
              )}

              {!error && !response && !sending && (
                <div className="h-full flex flex-col items-center justify-center gap-2 select-none">
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" style={{ opacity: 0.12 }}>
                    <circle cx="16" cy="16" r="13" stroke="white" strokeWidth="1.5"/>
                    <path d="M11 16h10M18 12l4 4-4 4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span className="text-[12px] text-[var(--border)]">Waiting for request</span>
                </div>
              )}

              {response && respTab === "body" && (
                <pre
                  className="text-[12px] font-mono leading-relaxed whitespace-pre-wrap break-all"
                  style={{ color: "var(--text2)" }}
                  dangerouslySetInnerHTML={{
                    __html: isJson
                      ? highlightJson(prettyBody)
                      : prettyBody.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                  }}
                />
              )}

              {response && respTab === "headers" && (
                <table className="w-full text-[12px] font-mono border-collapse">
                  <tbody>
                    {response.headers.map((h, i) => (
                      <tr key={i} className="border-b border-[var(--bg3)]">
                        <td className="py-1.5 pr-6 text-[#93c5fd] font-semibold whitespace-nowrap align-top w-0">{h.name}</td>
                        <td className="py-1.5 text-[var(--text2)] break-all">{h.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Save modal ── */}
      {showSaveModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={e => e.target === e.currentTarget && setShowSaveModal(false)}
        >
          <div
            className="rounded-xl border border-[var(--border)] p-5 w-72"
            style={{ background: "var(--bg2)" }}
          >
            <h3 className="text-[14px] text-[var(--text)] font-semibold mb-3">Save request</h3>
            <input
              className="w-full bg-[var(--bg1)] border border-[var(--border)] rounded-lg px-3 py-2 text-[13px] text-[var(--text)] placeholder-[var(--text5)] focus:outline-none focus:border-[#6366f150] transition-colors font-mono mb-4"
              placeholder="Request name…"
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && saveRequest()}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSaveModal(false)}
                className="px-3 py-1.5 text-[12px] text-[var(--text3)] hover:text-[var(--text)] transition-colors"
              >Cancel</button>
              <button
                onClick={saveRequest}
                disabled={!saveName.trim()}
                className="px-4 py-1.5 text-[12px] font-semibold rounded-lg disabled:opacity-40 transition-all"
                style={{ background: "#6366f1", color: "#fff" }}
              >Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
