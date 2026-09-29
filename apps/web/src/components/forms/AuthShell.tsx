import type { ReactNode } from "react";
import { Brand } from "../branding/Brand";

export function AuthShell({
  children,
  home = "/login",
}: {
  children: ReactNode;
  home?: string;
}) {
  return (
    <main className="auth-shell">
      <header className="auth-header">
        <Brand href={home} />
      </header>
      <section className="auth-panel">{children}</section>
    </main>
  );
}
