// Shared between app/opengraph-image.tsx and app/twitter-image.tsx so the
// two special route files render identically without one re-exporting the
// other's default export (next/og's file-convention detection runs on each
// route file independently, so each needs its own default export).
export const OG_IMAGE_SIZE = { width: 1200, height: 630 };
export const OG_IMAGE_ALT = "Release Watcher - TCG Release Date Calendar";

export function OgImageContent() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0f172a",
        backgroundImage: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%)",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ fontSize: 76, fontWeight: 700, color: "#ffffff", letterSpacing: -1 }}>Release Watcher</div>
      <div style={{ fontSize: 34, color: "#a5b4fc", marginTop: 20 }}>TCG Release Date Calendar</div>
      <div style={{ fontSize: 24, color: "#94a3b8", marginTop: 36 }}>
        MTG · Pokémon · Yu-Gi-Oh · Lorcana · One Piece · and more
      </div>
    </div>
  );
}
