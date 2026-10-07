import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Go Chat",
  description: "A quiet, real-time one-to-one messaging workspace.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
