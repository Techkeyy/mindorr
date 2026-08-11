import type { Metadata } from "next";
import { Fraunces, Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
  axes: ["opsz"],
});
const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-num", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Mindorr: private XRP autopilot",
  description:
    "A confidential, non-custodial agent that puts idle XRP to work. Your keys never leave the enclave; your positions stay private.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable} ${grotesk.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
