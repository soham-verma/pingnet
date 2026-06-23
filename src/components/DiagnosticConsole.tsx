import { useEffect, useRef } from "react";
import { LogEntry } from "../hooks/usePing";

interface Props {
  logs: LogEntry[];
}

const levelColor: Record<LogEntry["level"], string> = {
  INFO: "#6366f1",
  OK: "#22c55e",
  WARN: "#f59e0b",
  ERROR: "#ef4444",
  CRITICAL: "#ef4444",
  FATAL: "#dc2626",
};

export default function DiagnosticConsole({ logs }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div
      className="rounded-xl border border-[#1e1e35] flex flex-col"
      style={{ background: "#080810" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e35]">
        <span className="text-[10px] tracking-widest text-[#4b5563] uppercase">
          Diagnostic Console
        </span>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-[#ef4444] opacity-80" />
          <span className="w-2 h-2 rounded-full bg-[#f59e0b] opacity-80" />
          <span className="w-2 h-2 rounded-full bg-[#22c55e] opacity-80" />
        </div>
      </div>

      {/* Log output */}
      <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-[11px] min-h-[160px] max-h-[240px]">
        {logs.length === 0 ? (
          <div className="text-[#2d3748] italic">No activity yet. Run a ping to see output.</div>
        ) : (
          logs.map((entry, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className="text-[#2d3748] flex-shrink-0 tabular-nums">{entry.time}</span>
              <span
                className="flex-shrink-0 font-semibold"
                style={{ color: levelColor[entry.level] }}
              >
                {entry.level}:
              </span>
              <span className="text-[#8892a4] break-all">{entry.message}</span>
            </div>
          ))
        )}
        {/* Blinking cursor */}
        <div className="flex items-center gap-1 text-[#4b5563]">
          <span className="text-[#4b5563]">$</span>
          <span className="w-[6px] h-[12px] bg-[#4b5563] inline-block animate-pulse" />
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
