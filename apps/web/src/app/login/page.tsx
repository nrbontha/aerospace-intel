import type { Metadata } from "next";

import { LoginForm } from "../../components/login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function safeReturnPath(value: string | string[] | undefined): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return "/";
  }

  try {
    const base = new URL("https://app.invalid");
    const target = new URL(value, base);

    if (
      target.origin !== base.origin ||
      target.pathname === "/login" ||
      target.pathname.startsWith("/login/")
    ) {
      return "/";
    }

    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const parameters = await searchParams;

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <header className="login-header">
          <p className="login-eyebrow">Aerospace Supplier Intelligence</p>
          <h1 className="login-title" id="login-title">
            Sign in
          </h1>
          <p className="login-description">
            Use the account provided by your administrator.
          </p>
        </header>
        <LoginForm returnTo={safeReturnPath(parameters.next)} />
      </section>
    </main>
  );
}
