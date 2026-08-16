import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@asi/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Aerospace Supplier Intelligence",
    template: "%s | Aerospace Supplier Intelligence",
  },
  description:
    "Evidence-led aerospace supplier research, qualification, and review.",
};

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
