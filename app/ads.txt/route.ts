// Required by Google once AdSense ads are live: declares this site as an
// authorized seller for the configured publisher account, so ad fraud
// scanners can verify inventory isn't being resold. Served at the domain
// root per the IAB ads.txt spec (Google looks for it at /ads.txt).
// Content is empty until ADSENSE_CLIENT_ID is set -- see app/layout.tsx and
// .env.example, same "no-op until configured" pattern used there.
export async function GET() {
  const clientId = process.env.ADSENSE_CLIENT_ID;
  const body = clientId ? `google.com, ${clientId.replace(/^ca-/, "")}, DIRECT, f08c47fec0942fa0\n` : "";

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
