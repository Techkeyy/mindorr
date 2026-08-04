import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mindorr — private XRP autopilot",
  description:
    "A confidential, non-custodial agent that puts idle XRP to work. Your keys never leave the enclave; your positions stay private.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
