import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GetException · Error monitoring",
  description: "Your applications. Your errors. Your infrastructure.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
