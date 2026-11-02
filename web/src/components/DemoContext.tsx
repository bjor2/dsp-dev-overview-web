import { createContext, useContext, useState, type ReactNode } from "react";
const Ctx = createContext({ demoMode: false, setDemoMode: (_: boolean) => {} });
export function DemoProvider({ children }: { children: ReactNode }) {
  const [demoMode, setDemoMode] = useState(false);
  return <Ctx.Provider value={{ demoMode, setDemoMode }}>{children}</Ctx.Provider>;
}
export const useDemo = () => useContext(Ctx);
