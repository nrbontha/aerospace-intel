import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Admin | ASI" };

const sections = [
  {
    href: "/experiments",
    title: "Experiments",
    description:
      "Qualifier Lab: champion/challenger scoring-program evaluation over the frozen golden set with journaled promotion decisions.",
  },
  {
    href: "/imports",
    title: "Imports",
    description:
      "Durable import batches and row outcomes for dataset ingestion.",
  },
  {
    href: "/admin/users",
    title: "Users & access",
    description:
      "Create accounts, assign least-privilege roles, and invalidate access.",
  },
] as const;

export default function AdminHubPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Administration</p>
        <h1 className="asi-page-title">Admin</h1>
        <p className="asi-page-description">
          Operational back office: experiments, imports, and user access.
        </p>
      </header>
      <div className="admin-grid">
        {sections.map((section) => (
          <section className="admin-panel" key={section.href}>
            <div className="admin-panel__header">
              <div>
                <h2>
                  <Link href={section.href}>{section.title}</Link>
                </h2>
                <p>{section.description}</p>
              </div>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
