import { useEffect, useState } from "react";
import type { ClockFont, ClockMode, ClockPosition } from "../state/settings";

/**
 * Optional time/date overlay drawn on top of the active scene — a staple of
 * top-rated screensavers (Fliqlo, Aerial). Pure DOM (not WebGL) so it stays
 * razor-sharp at any resolution and costs nothing on the GPU. Updates once a
 * second; unmounts entirely when the mode is "off". Typeface, position, and
 * 12/24-hour are user-selectable and mirror the native saver's clock options.
 */
export interface ClockOverlayProps {
  mode: ClockMode;
  font: ClockFont;
  position: ClockPosition;
  hour24: boolean;
}

function format(now: Date, hour24: boolean): { time: string; date: string } {
  const time = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: !hour24,
  });
  const date = now.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return { time, date };
}

export function ClockOverlay({ mode, font, position, hour24 }: ClockOverlayProps) {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    if (mode === "off") return;
    // Tick on the minute boundary-ish; 1s keeps it simple and cheap.
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [mode]);

  if (mode === "off") return null;
  const { time, date } = format(now, hour24);

  return (
    <div className={`clock-overlay clock-pos-${position} clock-font-${font}`} aria-hidden>
      <div className="clock-time">{time}</div>
      {mode === "datetime" && <div className="clock-date">{date}</div>}
    </div>
  );
}
