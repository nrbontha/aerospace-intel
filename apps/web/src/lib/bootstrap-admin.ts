import { pathToFileURL } from "node:url";

import { getServerEnv } from "@asi/config";
import { auditEvents, sessions, users } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { and, eq, isNull, sql } from "drizzle-orm";

import { hashPassword, verifyPassword } from "./auth";

export async function bootstrapAdmin(): Promise<
  "skipped" | "created" | "updated" | "unchanged"
> {
  const env = getServerEnv();
  if (
    env.BOOTSTRAP_ADMIN_EMAIL === undefined ||
    env.BOOTSTRAP_ADMIN_PASSWORD === undefined
  ) {
    return "skipped";
  }

  const email = env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();
  const password = env.BOOTSTRAP_ADMIN_PASSWORD;

  return getDatabase().transaction(async (transaction) => {
    const [existing] = await transaction
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        passwordHash: users.passwordHash,
        role: users.role,
        isDisabled: users.isDisabled,
      })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    if (existing === undefined) {
      const passwordHash = await hashPassword(password);
      const [created] = await transaction
        .insert(users)
        .values({
          email,
          displayName: "Bootstrap Administrator",
          passwordHash,
          role: "admin",
          isDisabled: false,
        })
        .returning({ id: users.id });

      if (created === undefined) {
        throw new Error("Failed to create the bootstrap administrator");
      }

      await transaction.insert(auditEvents).values({
        actorUserId: null,
        action: "bootstrap_admin.created",
        entityType: "user",
        entityId: created.id,
        before: null,
        after: {
          email,
          displayName: "Bootstrap Administrator",
          role: "admin",
          isDisabled: false,
        },
        metadata: { source: "environment" },
      });
      return "created";
    }

    const passwordMatches = await verifyPassword(
      password,
      existing.passwordHash,
    );
    const needsUpdate =
      !passwordMatches ||
      existing.email !== email ||
      existing.role !== "admin" ||
      existing.isDisabled;
    if (!needsUpdate) {
      return "unchanged";
    }

    const now = new Date();
    const nextPasswordHash = passwordMatches
      ? existing.passwordHash
      : await hashPassword(password);
    await transaction
      .update(users)
      .set({
        email,
        passwordHash: nextPasswordHash,
        role: "admin",
        isDisabled: false,
        updatedAt: now,
      })
      .where(eq(users.id, existing.id));

    if (!passwordMatches || existing.role !== "admin" || existing.isDisabled) {
      await transaction
        .update(sessions)
        .set({ revokedAt: now })
        .where(
          and(eq(sessions.userId, existing.id), isNull(sessions.revokedAt)),
        );
    }

    await transaction.insert(auditEvents).values({
      actorUserId: null,
      action: "bootstrap_admin.updated",
      entityType: "user",
      entityId: existing.id,
      before: {
        email: existing.email,
        displayName: existing.displayName,
        role: existing.role,
        isDisabled: existing.isDisabled,
      },
      after: {
        email,
        displayName: existing.displayName,
        role: "admin",
        isDisabled: false,
      },
      metadata: {
        source: "environment",
        passwordRotated: !passwordMatches,
        sessionsRevoked:
          !passwordMatches || existing.role !== "admin" || existing.isDisabled,
      },
    });

    return "updated";
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await bootstrapAdmin();
}
