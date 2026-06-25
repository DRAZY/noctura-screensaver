import { useEffect, useState } from "react";
import type { ClockMode } from "../state/settings";

/**
 * Optional time/date overlay drawn on top of the active scene — a staple of
 * top-rated screensavers (Fliqlo, Aerial). Pure DOM (not WebGL) so it stays
 * razor-sharp at any resolution and costs nothing on the GPU. Updates once a
 * second; unmounts entirely when the mode is "off".
 */
export interface ClockOverlayProps {
  mode: ClockMode;
}

function format(now: Date): { time: string; date: string } {
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return { time, date };
}

export function ClockOverlay({ mode }: ClockOverlayProps) {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    if (mode === "off") return;
    // Tick on the minute boundary-ish; 1s keeps it simple and cheap.
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [mode]);

  if (mode === "off") return null;
  const { time, date } = format(now);

  return (
    <div className="clock-overlay" aria-hidden>
      <div className="clock-time">{time}</div>
      {mode === "datetime" && <div className="clock-date">{date}</div>}
    </div>
  );
}
