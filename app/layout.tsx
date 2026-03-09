import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Containers",
  description: "A simple Next.js workspace for OpenAI hosted shell tasks.",
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
