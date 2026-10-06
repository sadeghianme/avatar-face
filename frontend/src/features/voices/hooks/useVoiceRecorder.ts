import { useEffect, useRef, useState } from "react";

import { MicRecorder, type Recording } from "@/lib/recorder";

/**
 * The microphone, as a reference voice is recorded: whether it records,
 * for how long so far, and the recording made (its object URL dropped when
 * replaced or unmounted). `toggle` starts or stops; a refused microphone
 * calls `onDenied`.
 */
export function useVoiceRecorder(onDenied: () => void) {
  const recorder = useRef<MicRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [reference, setReference] = useState<Recording | null>(null);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 200);
    return () => clearInterval(timer);
  }, [recording]);
  // Object URLs are real allocations; drop the old one on replace/unmount.
  useEffect(
    () => () => {
      if (reference) URL.revokeObjectURL(reference.url);
    },
    [reference]
  );

  const toggle = async () => {
    if (recording) {
      const result = await recorder.current!.stop();
      setRecording(false);
      setReference(result);
      return;
    }
    try {
      recorder.current = new MicRecorder();
      await recorder.current.start();
      setElapsed(0);
      setRecording(true);
    } catch {
      onDenied();
    }
  };

  return { recording, elapsed, reference, toggle, clear: () => setReference(null) };
}
