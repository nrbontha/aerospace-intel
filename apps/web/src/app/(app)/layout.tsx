import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth";

export default async function ProtectedAppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const user = await requireUser();

  return <AppShell user={user}>{children}</AppShell>;
}
