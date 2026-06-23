import { useEffect, useState } from "react";

interface Props {
  ip: string;
  hostname: string;
  isRunning: boolean;
  success: boolean | null;
}

export default function NetworkRoute({ ip, hostname, isRunning, success }: Props) {
  const [dotPos, setDotPos] = useState(0);

  useEffect(() => {
    if (!isRunning) {
      setDotPos(success ? 100 : 50);
      return;
    }
    setDotPos(0);
    const interval = setInterval(() => {
      setDotPos((p) => (p >= 100 ? 0 : p + 2));
    }, 30);
    return () => clearInterval(interval);
  }, [isRunning, success]);

  const lineColor =
    success === null ? "#1e1e35" : success ? "#00c8a8" : "#ef4444";

  return (
    <div
      className="rounded-xl border border-[#1e1e35] p-5 relative overflow-hidden"
      style={{ background: "#0a0a14" }}
    >
      {/* Background grid pattern */}
      <svg
        className="absolute inset-0 w-full h-full opacity-[0.04]"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#00c8a8" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>

      <div className="relative z-10">
        <span className="text-[10px] tracking-widest text-[#4b5563] uppercase mb-5 block">
          Network Route
        </span>

        <div className="flex items-center justify-between px-2">
          {/* Origin */}
          <div className="text-center">
            <div
              className="w-8 h-8 rounded-full border border-[#252535] flex items-center justify-center mx-auto mb-2"
              style={{ background: "#13132a" }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="3" width="12" height="8" rx="1" stroke="#6366f1" strokeWidth="1.2" />
                <path d="M4 3V2M10 3V2" stroke="#6366f1" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </div>
            <div className="text-[10px] text-[#4b5563]">ORIGIN</div>
            <div className="text-xs text-[#8892a4] mt-0.5">Local Client</div>
          </div>

          {/* Animated line */}
          <div className="flex-1 mx-4 relative h-6 flex items-center">
            <div
              className="absolute inset-x-0 h-px"
              style={{ backgroundColor: "#1e1e35" }}
            />
            <div
              className="absolute h-px transition-all"
              style={{
                left: 0,
                width: `${dotPos}%`,
                backgroundColor: lineColor,
                boxShadow: `0 0 6px ${lineColor}`,
                transition: isRunning ? "none" : "width 0.4s ease",
              }}
            />
            {/* Moving dot */}
            {isRunning && (
              <div
                className="absolute w-2 h-2 rounded-full"
                style={{
                  left: `calc(${dotPos}% - 4px)`,
                  backgroundColor: "#00c8a8",
                  boxShadow: "0 0 8px #00c8a8",
                }}
              />
            )}
            {/* Hop node in middle */}
            <div
              className="absolute left-1/2 -translate-x-1/2 w-6 h-6 rounded-full border flex items-center justify-center z-10"
              style={{
                background: "#0a0a14",
                borderColor: isRunning ? "#6366f1" : lineColor,
                boxShadow: isRunning ? "0 0 8px #6366f140" : undefined,
              }}
            >
              <div
                className="w-1.5 h-1.5 rounded-full"
                style={{
                  backgroundColor: isRunning ? "#6366f1" : lineColor,
                }}
              />
            </div>
          </div>

          {/* Target */}
          <div className="text-center">
            <div
              className="w-8 h-8 rounded-full border border-[#252535] flex items-center justify-center mx-auto mb-2"
              style={{
                background: "#13132a",
                borderColor: success === false ? "#ef444430" : "#252535",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="2" y="1" width="10" height="12" rx="1" stroke={success === false ? "#ef4444" : "#00c8a8"} strokeWidth="1.2" />
                <path d="M5 5h4M5 8h4" stroke={success === false ? "#ef4444" : "#00c8a8"} strokeWidth="1" strokeLinecap="round" strokeOpacity="0.6" />
              </svg>
            </div>
            <div className="text-[10px] text-[#4b5563]">TARGET</div>
            <div className="text-xs text-[#8892a4] mt-0.5 font-mono">{hostname}</div>
          </div>
        </div>

        {/* IP below */}
        <div className="text-center mt-3">
          <span className="font-mono text-[11px] text-[#374151]">{ip}</span>
        </div>
      </div>
    </div>
  );
}
