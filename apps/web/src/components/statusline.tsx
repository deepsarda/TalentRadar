import { createContext, type PropsWithChildren, useCallback, useContext, useState } from "react";

export type StatusMessage = { id: number; text: string; tone?: "error" | "warn" };

const StatusContext = createContext<{
  message: StatusMessage | null;
  post: (text: string, tone?: StatusMessage["tone"]) => void;
}>({ message: null, post: () => undefined });

/** Toasts are lines appended to the status bar at the bottom (spec: element treatments). */
export function StatusProvider({ children }: PropsWithChildren) {
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const post = useCallback((text: string, tone?: StatusMessage["tone"]) => {
    setMessage({ id: Date.now(), text, ...(tone ? { tone } : {}) });
  }, []);
  return <StatusContext value={{ message, post }}>{children}</StatusContext>;
}

export function useStatusLine() {
  return useContext(StatusContext);
}
