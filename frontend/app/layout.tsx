import "./globals.css";

export const metadata = {
  title: "Sheets PoC",
  description: "GPU-accelerated canvas grid PoC",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
