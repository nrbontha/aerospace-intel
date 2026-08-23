"use client";

import type { Role, User } from "@asi/contracts";
import {
  Badge,
  Button,
  Input,
  Select,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@asi/ui";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { OpsStatusPanel } from "@/components/ops-status-panel";

const roles: readonly Role[] = ["admin", "analyst", "viewer"];
const csrfCookieName = "asi_session_csrf";

type PageMeta = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

type ApiEnvelope<T> = { data: T; meta?: PageMeta };
type Feedback = { tone: "error" | "success"; message: string };

class ApiRequestError extends Error {}

function csrfToken(): string | undefined {
  let configuredToken: string | undefined;
  for (const pair of document.cookie.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = decodeURIComponent(pair.slice(0, separator).trim());
    const value = decodeURIComponent(pair.slice(separator + 1));
    if (name === csrfCookieName) return value;
    if (name.endsWith("_csrf")) configuredToken ??= value;
  }
  return configuredToken;
}

async function apiRequest<T>(
  url: string,
  init: RequestInit = {},
): Promise<ApiEnvelope<T>> {
  const method = init.method?.toUpperCase() ?? "GET";
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET" && method !== "HEAD") {
    const csrf = csrfToken();
    if (csrf === undefined) {
      throw new ApiRequestError(
        "Your session is missing CSRF protection. Sign in again.",
      );
    }
    headers.set("x-csrf-token", csrf);
  }

  const response = await fetch(url, {
    ...init,
    method,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError("The server returned an unreadable response.");
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const error = payload.error;
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
      ) {
        message = error.message;
      }
    }
    throw new ApiRequestError(message);
  }
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    throw new ApiRequestError("The server returned an invalid response.");
  }
  return payload as ApiEnvelope<T>;
}

function UserRow({
  user,
  onChanged,
}: Readonly<{ user: User; onChanged: (user: User) => void }>) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<Role>(user.role);
  const [disabled, setDisabled] = useState(user.disabled);
  const [newPassword, setNewPassword] = useState("");
  const [pendingAction, setPendingAction] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();

  async function saveUser(): Promise<void> {
    setPendingAction("save");
    setFeedback(undefined);
    try {
      const result = await apiRequest<User>(`/api/v1/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName, role, disabled }),
      });
      onChanged(result.data);
      setFeedback({ tone: "success", message: "Saved" });
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Unable to update user",
      });
    } finally {
      setPendingAction(undefined);
    }
  }

  async function resetPassword(): Promise<void> {
    setPendingAction("password");
    setFeedback(undefined);
    try {
      await apiRequest<{ reset: boolean }>(
        `/api/v1/admin/users/${user.id}/reset-password`,
        { method: "POST", body: JSON.stringify({ password: newPassword }) },
      );
      setNewPassword("");
      setFeedback({ tone: "success", message: "Password reset" });
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Unable to reset password",
      });
    } finally {
      setPendingAction(undefined);
    }
  }

  async function revokeSessions(): Promise<void> {
    setPendingAction("sessions");
    setFeedback(undefined);
    try {
      const result = await apiRequest<{ revokedSessionCount: number }>(
        `/api/v1/admin/users/${user.id}/sessions`,
        { method: "DELETE" },
      );
      setFeedback({
        tone: "success",
        message: `${result.data.revokedSessionCount} session${result.data.revokedSessionCount === 1 ? "" : "s"} revoked`,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Unable to revoke sessions",
      });
    } finally {
      setPendingAction(undefined);
    }
  }

  return (
    <TableRow>
      <TableCell>
        <div className="admin-user-meta">
          <strong>{user.email}</strong>
          <span>Created {new Date(user.createdAt).toLocaleDateString()}</span>
          {user.disabled ? <Badge tone="danger">Disabled</Badge> : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="admin-stack">
          <Input
            aria-label={`Display name for ${user.email}`}
            maxLength={200}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <Select
            aria-label={`Role for ${user.email}`}
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {roles.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          <label className="admin-inline-control">
            <input
              type="checkbox"
              checked={disabled}
              onChange={(event) => setDisabled(event.target.checked)}
            />
            Disabled
          </label>
          <Button
            size="small"
            isLoading={pendingAction === "save"}
            disabled={pendingAction !== undefined || displayName.trim() === ""}
            onClick={() => void saveUser()}
          >
            Save
          </Button>
        </div>
      </TableCell>
      <TableCell>
        <div className="admin-stack">
          <Input
            aria-label={`New password for ${user.email}`}
            type="password"
            minLength={12}
            maxLength={1000}
            autoComplete="new-password"
            placeholder="New password (12+ characters)"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <div className="admin-actions">
            <Button
              size="small"
              variant="secondary"
              isLoading={pendingAction === "password"}
              disabled={pendingAction !== undefined || newPassword.length < 12}
              onClick={() => void resetPassword()}
            >
              Reset password
            </Button>
            <Button
              size="small"
              variant="danger"
              isLoading={pendingAction === "sessions"}
              disabled={pendingAction !== undefined}
              onClick={() => void revokeSessions()}
            >
              Revoke sessions
            </Button>
          </div>
          {feedback ? (
            <p
              className="admin-feedback"
              data-tone={feedback.tone}
              role="status"
            >
              {feedback.message}
            </p>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [meta, setMeta] = useState<PageMeta>();
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [createFeedback, setCreateFeedback] = useState<Feedback>();
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("viewer");

  const loadUsers = useCallback(async (requestedPage: number) => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const result = await apiRequest<User[]>(
        `/api/v1/admin/users?page=${requestedPage}&pageSize=25`,
      );
      setUsers(result.data);
      setMeta(result.meta);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Unable to load users",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers(page);
  }, [loadUsers, page]);

  async function createUser(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setCreating(true);
    setCreateFeedback(undefined);
    try {
      await apiRequest<User>("/api/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({ email, displayName, password, role }),
      });
      setEmail("");
      setDisplayName("");
      setPassword("");
      setRole("viewer");
      setCreateFeedback({ tone: "success", message: "User created" });
      if (page === 1) await loadUsers(1);
      else setPage(1);
    } catch (error) {
      setCreateFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Unable to create user",
      });
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <OpsStatusPanel />
      <header className="asi-page-header">
        <div>
          <p className="asi-page-kicker">Administration</p>
          <h1 className="asi-page-title">User access</h1>
          <p className="asi-page-description">
            Create accounts, assign least-privilege roles, and invalidate
            access.
          </p>
        </div>
      </header>

      <div className="admin-grid">
        <section className="admin-panel" aria-labelledby="create-user-heading">
          <div className="admin-panel__header">
            <div>
              <h2 id="create-user-heading">Create user</h2>
              <p>There is no public signup. Issue credentials directly.</p>
            </div>
          </div>
          <form className="admin-form-grid" onSubmit={createUser}>
            <label className="admin-field">
              <span className="admin-field__label">Email</span>
              <Input
                type="email"
                required
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="admin-field">
              <span className="admin-field__label">Display name</span>
              <Input
                required
                maxLength={200}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <label className="admin-field">
              <span className="admin-field__label">Temporary password</span>
              <Input
                type="password"
                required
                minLength={12}
                maxLength={1000}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label className="admin-field">
              <span className="admin-field__label">Role</span>
              <Select
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                {roles.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </label>
            <div className="admin-actions">
              <Button type="submit" isLoading={creating} disabled={creating}>
                Create user
              </Button>
              {createFeedback ? (
                <p
                  className="admin-feedback"
                  data-tone={createFeedback.tone}
                  role="status"
                >
                  {createFeedback.message}
                </p>
              ) : null}
            </div>
          </form>
        </section>

        <section className="admin-panel" aria-labelledby="users-heading">
          <div className="admin-panel__header">
            <div>
              <h2 id="users-heading">Users</h2>
              <p>
                {meta ? `${meta.totalItems} total accounts` : "Account roster"}
              </p>
            </div>
            <Button
              size="small"
              variant="ghost"
              disabled={loading}
              onClick={() => void loadUsers(page)}
            >
              Refresh
            </Button>
          </div>

          {loadError ? (
            <p className="admin-feedback" data-tone="error" role="alert">
              {loadError}
            </p>
          ) : null}
          {loading && users.length === 0 ? <p>Loading users…</p> : null}
          {!loading && !loadError && users.length === 0 ? (
            <p>No users found.</p>
          ) : null}
          {users.length > 0 ? (
            <Table>
              <TableCaption>Application user accounts</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Security</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <UserRow
                    key={`${user.id}:${user.updatedAt}`}
                    user={user}
                    onChanged={(changed) =>
                      setUsers((current) =>
                        current.map((entry) =>
                          entry.id === changed.id ? changed : entry,
                        ),
                      )
                    }
                  />
                ))}
              </TableBody>
            </Table>
          ) : null}

          {meta && meta.totalPages > 1 ? (
            <nav className="admin-actions" aria-label="User pages">
              <Button
                size="small"
                variant="secondary"
                disabled={loading || page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </Button>
              <span>
                Page {meta.page} of {meta.totalPages}
              </span>
              <Button
                size="small"
                variant="secondary"
                disabled={loading || page >= meta.totalPages}
                onClick={() =>
                  setPage((current) => Math.min(meta.totalPages, current + 1))
                }
              >
                Next
              </Button>
            </nav>
          ) : null}
        </section>
      </div>
    </>
  );
}
