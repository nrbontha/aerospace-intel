"use client";

import type { Role } from "@asi/contracts";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";

import { SignOutButton } from "@/components/sign-out-button";

type ShellUser = Readonly<{
  displayName: string;
  email: string;
  role: Role;
}>;

type AppShellProps = Readonly<{
  children: ReactNode;
  user: ShellUser;
}>;

type NavigationItem = Readonly<{
  href: string;
  label: string;
  adminOnly?: boolean;
}>;

const navigation: readonly NavigationItem[] = [
  { href: "/feed", label: "Targets" },
  { href: "/research", label: "Research" },
  { href: "/universe", label: "Universe" },
];

const adminNavigation: readonly NavigationItem[] = [
  { href: "/experiments", label: "Experiments" },
  { href: "/imports", label: "Imports" },
  { href: "/admin", label: "Users & access", adminOnly: true },
];

function isCurrentDestination(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children, user }: AppShellProps) {
  const pathname = usePathname();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const visibleNavigation = navigation.filter(
    (item) => !item.adminOnly || user.role === "admin",
  );
  const visibleAdminNavigation = adminNavigation.filter(
    (item) => !item.adminOnly || user.role === "admin",
  );
  const adminActive = visibleAdminNavigation.some((item) =>
    isCurrentDestination(pathname, item.href),
  );

  return (
    <>
      <a className="asi-skip-link" href="#main-content">
        Skip to main content
      </a>
      <div className="asi-shell">
        <header className="asi-shell__header">
          <div className="asi-shell__identity">
            <p className="asi-shell__eyebrow">Evidence operations</p>
            <Link className="asi-shell__product" href="/feed">
              Aerospace Supplier Intelligence
            </Link>
          </div>
          <div className="asi-shell__header-actions">
            <SignOutButton />
            <button
              aria-controls="primary-navigation"
              aria-expanded={navigationOpen}
              aria-label={
                navigationOpen
                  ? "Close primary navigation"
                  : "Open primary navigation"
              }
              className="asi-shell__nav-toggle"
              onClick={() => setNavigationOpen((open) => !open)}
              type="button"
            >
              <span aria-hidden="true">{navigationOpen ? "×" : "☰"}</span>
            </button>
          </div>
        </header>

        <div className="asi-shell__body">
          <aside className="asi-shell__rail">
            <nav
              aria-label="Primary navigation"
              className="asi-shell__nav"
              data-open={navigationOpen ? "true" : "false"}
              id="primary-navigation"
            >
              <ul className="asi-shell__nav-list">
                {visibleNavigation.map((item) => {
                  const current = isCurrentDestination(pathname, item.href);

                  return (
                    <li key={item.href}>
                      <Link
                        aria-current={current ? "page" : undefined}
                        className="asi-shell__nav-link"
                        href={item.href}
                        onClick={() => setNavigationOpen(false)}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
                {visibleAdminNavigation.length > 0 ? (
                  <li>
                    <details className="asi-shell__nav-group">
                      <summary
                        aria-current={adminActive ? "true" : undefined}
                        className="asi-shell__nav-link"
                      >
                        Admin
                      </summary>
                      <ul className="asi-shell__nav-list">
                        {visibleAdminNavigation.map((item) => {
                          const current = isCurrentDestination(
                            pathname,
                            item.href,
                          );

                          return (
                            <li key={item.href}>
                              <Link
                                aria-current={current ? "page" : undefined}
                                className="asi-shell__nav-link"
                                href={item.href}
                                onClick={() => setNavigationOpen(false)}
                              >
                                {item.label}
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  </li>
                ) : null}
              </ul>
            </nav>

            <div className="asi-shell__account">
              <p className="asi-shell__account-name">{user.displayName}</p>
              <p className="asi-shell__account-meta">
                <span>{user.role}</span>
                {", "}
                <span>{user.email}</span>
              </p>
            </div>
          </aside>

          <main className="asi-shell__main" id="main-content" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
