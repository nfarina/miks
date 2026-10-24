import { useEffect, useRef, useState } from "react";
import { daemon } from "./daemon";

export type DictationState = "idle" | "recording" | "transcribing";

/** What MediaRecorder makes, in the order Groq and the browsers like best. */
const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/wav"];

/**
 * Dictation for the chat panel: records from the microphone until stopped,
 * then the daemon's Mac turns it into words (Dictation.ts), so it works the
 * same in the iOS app as on a Mac.
 */
export function useDictation({ onText, onError }: { onText: (text: string) => void; onError: (error: string) => void }) {
  const [state, setState] = useState<DictationState>("idle");
  const recorder = useRef<MediaRecorder | null>(null);

  // Gone mid-recording: the microphone goes off, and nothing's sent.
  useEffect(() => () => cancel(), []);

  async function start() {
    // Missing where the page isn't a secure context (plain http).
    if (!navigator.mediaDevices?.getUserMedia) return onError("The microphone isn't available here.");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return onError("Miks isn't allowed to use the microphone.");
    }
    const mimeType = AUDIO_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const next = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    next.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    next.onstop = async () => {
      for (const track of stream.getTracks()) track.stop();
      if (recorder.current !== next) return;
      recorder.current = null;
      const audio = new Blob(chunks, { type: next.mimeType || mimeType || "audio/webm" });
      if (audio.size === 0) return setState("idle");
      setState("transcribing");
      const result = await daemon.transcribe(audio);
      setState("idle");
      if (result.text) onText(result.text);
      else if (result.error) onError(result.error);
    };
    recorder.current = next;
    // With a timeslice, or Safari (the iOS app) hands over nothing (as chatwing found).
    next.start(1000);
    setState("recording");
  }

  function stop() {
    recorder.current?.stop();
  }

  function cancel() {
    const current = recorder.current;
    recorder.current = null;
    current?.stop();
    setState("idle");
  }

  function toggle() {
    if (state === "idle") void start();
    else if (state === "recording") stop();
  }

  return { state, toggle, cancel };
}
