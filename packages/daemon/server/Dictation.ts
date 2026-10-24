import fs from "fs";
import path from "path";

/** Groq's quicker Whisper: dictation waits on it. */
const MODEL = "whisper-large-v3-turbo";

/**
 * Speech to text for the chat panel's microphone, from any window (the iOS
 * app's included), by Groq. The key stays on this Mac, as `groq` in
 * `keys.json` in Miks's home: a page can't keep one, since anyone can
 * download it.
 */
export async function transcribe(home: string, audio: Buffer, mime: string): Promise<{ text?: string; error?: string }> {
  const keysPath = path.join(home, "keys.json");
  let key: unknown;
  try {
    key = JSON.parse(fs.readFileSync(keysPath, "utf8")).groq;
  } catch {}
  if (typeof key !== "string" || !key) return { error: `There's no Groq key on this Mac (groq in ${keysPath}).` };

  const form = new FormData();
  // Groq goes by the name's extension: webm, mp4, wav…
  const extension = mime.split("/")[1]?.split(";")[0] || "webm";
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `dictation.${extension}`);
  form.append("model", MODEL);
  try {
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) return { error: body?.error?.message ?? `Groq answered ${response.status}.` };
    return { text: String(body?.text ?? "").trim() };
  } catch (error: any) {
    return { error: `Couldn't reach Groq: ${error?.message ?? error}` };
  }
}
