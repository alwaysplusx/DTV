import { invoke } from "@tauri-apps/api/core";

export async function openInDefaultBrowser(url: string): Promise<void> {
  const raw = String(url || "").trim();
  if (!raw) return;

  const normalizedUrl = (() => {
    try {
      return new URL(raw).toString();
    } catch {
      // allow passing github.com/xxx
      try {
        return new URL(`https://${raw}`).toString();
      } catch {
        return raw;
      }
    }
  })();

  try {
    await invoke("open_in_default_browser", { url: normalizedUrl });
    return;
  } catch {
    // ignore
  }
  try {
    const opener: any = await import("@tauri-apps/plugin-opener");
    if (typeof opener?.open === "function") {
      await opener.open(normalizedUrl);
      return;
    }
  } catch {
    // ignore
  }
  try {
    window.open(normalizedUrl, "_blank", "noopener,noreferrer");
  } catch {
    // ignore
  }
}
