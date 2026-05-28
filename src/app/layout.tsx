import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mini Codex MVP",
  description: "A stripped-down Codex-style SWE agent demo.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
