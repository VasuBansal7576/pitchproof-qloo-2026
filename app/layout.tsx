import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#faf9f6", colorScheme: "light" };

export const metadata: Metadata = {
  title: "PitchProof | Good ideas. Grounded.",
  description: "An evidence-led campaign workspace for independent creative teams. Turn a real brief into cultural research and creative directions.",
  icons: { icon: "/pitchproof.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
