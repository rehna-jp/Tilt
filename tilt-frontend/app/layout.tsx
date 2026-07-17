import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tilt — Call the Line",
  description:
    "Predict which way live match stats move. A real-time sports prediction game built on Solana.",
  openGraph: {
    title: "Tilt — Call the Line",
    description: "Real-time football stat predictions. Built on Solana.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#060810",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{<Providers>{children}</Providers>}</body>
    </html>
  );
}