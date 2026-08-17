"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type LoginFormProps = {
  returnTo: string;
};

const GENERIC_ERROR = "Unable to sign in with those credentials.";

export function LoginForm({ returnTo }: LoginFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error !== null) {
      errorRef.current?.focus();
    }
  }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const form = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
        }),
      });

      if (!response.ok) {
        setError(GENERIC_ERROR);
        return;
      }

      window.location.assign(returnTo);
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="login-form" onSubmit={submit} noValidate={false}>
      <div className="login-field">
        <label className="login-label" htmlFor="username">
          Username
        </label>
        <input
          className="login-input"
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
          disabled={isSubmitting}
        />
      </div>

      <div className="login-field">
        <label className="login-label" htmlFor="password">
          Password
        </label>
        <input
          className="login-input"
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={12}
          maxLength={1000}
          required
          disabled={isSubmitting}
        />
      </div>

      {error === null ? null : (
        <p className="login-error" ref={errorRef} role="alert" tabIndex={-1}>
          {error}
        </p>
      )}

      <button className="login-submit" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
