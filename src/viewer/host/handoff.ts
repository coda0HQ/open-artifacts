export type HandoffPhase =
  | "idle"
  | "countdown"
  | "recording"
  | "uploading"
  | "playing";

export type HandoffAction =
  | "start"
  | "countdown-complete"
  | "stop"
  | "upload-complete"
  | "play"
  | "exit"
  | "cancel";

export function handoffReducer(
  phase: HandoffPhase,
  action: HandoffAction,
): HandoffPhase {
  if (action === "cancel") return "idle";
  if (phase === "idle" && action === "start") return "countdown";
  if (phase === "countdown" && action === "countdown-complete") {
    return "recording";
  }
  if (phase === "recording" && action === "stop") return "uploading";
  if (phase === "uploading" && action === "upload-complete") return "idle";
  if (phase === "idle" && action === "play") return "playing";
  if (phase === "playing" && action === "exit") return "idle";
  return phase;
}

export function handoffCanYield(phase: HandoffPhase): boolean {
  return phase === "idle";
}
