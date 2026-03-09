import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Containers",
  description: "An agent-first Next.js workspace for OpenAI hosted shell tasks.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full bg-gray-50">
      <head>
        <link rel="preconnect" href="https://rsms.me/" />
        <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
      </head>
      <body className="h-full">{children}</body>
    </html>
  );
}
