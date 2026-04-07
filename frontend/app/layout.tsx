import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RemoteStudio",
  description:
    "Remote podcast studio for live sessions, local recording, and upload workflows.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
