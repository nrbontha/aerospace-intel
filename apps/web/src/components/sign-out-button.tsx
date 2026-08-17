"use client";

import { Button } from "@asi/ui";
import { useState } from "react";

import { csrfFetch } from "@/components/csrf-client";

export function SignOutButton() {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut(): Promise<void> {
    setIsSigningOut(true);
    setError(null);

    try {
      const response = await csrfFetch("/api/v1/auth/logout", {
        method: "POST",
      });

      if (response.ok || response.status === 401) {
        window.location.assign("/login");
        return;
      }

      setError("Unable to sign out. Try again.");
    } catch {
      setError("Unable to sign out. Try again.");
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="asi-shell__sign-out">
      <Button
        className="asi-shell__sign-out-button"
        isLoading={isSigningOut}
        onClick={() => {
          void signOut();
        }}
        size="small"
        type="button"
        variant="ghost"
      >
        Sign out
      </Button>
      {error === null ? null : (
        <p className="asi-shell__sign-out-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
