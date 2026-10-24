import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import MotionProviders from "@/components/motion/MotionProviders";
import Mochi from "@/components/mochi/Mochi";
import "./globals.css";

// Variable Fraunces with the SOFT/WONK axes the design uses.
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", style: ["normal", "italic"], axes: ["SOFT", "WONK", "opsz"] });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: { default: "ShelfSense — See your market the way shoppers do", template: "%s · ShelfSense" },
  description: "Pincode-level price, stock and true checkout price tracking for quick-commerce and marketplace sellers.",
};

export const viewport: Viewport = { themeColor: "#f4f1de" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${fraunces.variable} ${inter.variable}`}>
        <MotionProviders>
          {children}
          <Mochi />
        </MotionProviders>
      </body>
    </html>
  );
}
