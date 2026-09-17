import Script from "next/script";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";

// Google's rejection reason was literal: "Google-served ads on screens
// without publisher-content." Auto Ads has no per-page exclusion list, and
// the old sitewide <Script> in app/layout.tsx loaded it on every route --
// including /profile and /subscriptions (settings forms), /admin, the
// error boundary, and every signed-out SignInPrompt screen. Auto Ads then
// placed ads on those regardless. Fix: don't load the script at all except
// from pages that are known to always render substantive content -- each
// such page renders this explicitly instead of it being sitewide.
//
// Premium stays ad-free the same way as before: checked server-side so the
// script genuinely never loads for a premium user, not just hidden by CSS.
export async function AdsenseAutoAds() {
  const adsenseClientId = process.env.ADSENSE_CLIENT_ID;
  if (!adsenseClientId) return null;

  const session = await getServerSession(authOptions);
  if (session?.user?.isPremium) return null;

  return (
    <Script
      async
      src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adsenseClientId}`}
      crossOrigin="anonymous"
      strategy="afterInteractive"
    />
  );
}
