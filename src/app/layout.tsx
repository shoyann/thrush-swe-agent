import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Thrush",
  description: "Thrush is a lightweight SWE agent workspace.",
  icons: {
    icon: "/icon.png",
    shortcut: "/icon.png",
    apple: "/icon.png",
  },
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
