export type PasswordState =
  | { phase: "locked"; error: null }
  | { phase: "decrypting"; error: null }
  | { phase: "unlocked"; error: null }
  | { phase: "error"; error: string };

export type PasswordAction =
  | { type: "submit"; password: string }
  | { type: "succeeded" }
  | { type: "failed"; message?: string }
  | { type: "reset" };

export const initialPasswordState = (): PasswordState => ({
  phase: "locked",
  error: null,
});

export function passwordReducer(
  state: PasswordState,
  action: PasswordAction,
): PasswordState {
  if (action.type === "reset") return initialPasswordState();
  if (action.type === "submit") {
    return action.password.length > 0
      ? { phase: "decrypting", error: null }
      : { phase: "error", error: "Enter a password" };
  }
  if (action.type === "succeeded" && state.phase === "decrypting") {
    return { phase: "unlocked", error: null };
  }
  if (action.type === "failed" && state.phase === "decrypting") {
    return {
      phase: "error",
      error: action.message || "Incorrect password",
    };
  }
  return state;
}
