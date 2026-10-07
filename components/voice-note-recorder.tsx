"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Mic, Pause, Play, Square, Trash2, X } from "lucide-react";

export const maxVoiceNoteBytes = 8 * 1024 * 1024;
export const maxVoiceNoteDurationMs = 5 * 60 * 1000;

export function voiceNoteSizeError(byteSize: number) {
	return byteSize > maxVoiceNoteBytes ? "Voice notes must be 8 MB or smaller." : "";
}

export function VoiceNoteRecorder({ onRecord }: { onRecord: (file: File) => void }) {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [permission, setPermission] = useState<"idle" | "denied">("idle");
  const [preview, setPreview] = useState<{ url: string; file: File } | null>(null);
  const [levels, setLevels] = useState<number[]>(Array.from({ length: 20 }, () => 0.15));
	const [limitMessage, setLimitMessage] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const animationRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
	const stopTimerRef = useRef<number | null>(null);
	const limitReasonRef = useRef("");
	const elapsedRef = useRef(0);
	const activeSinceRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
		if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);

  function animateWaveform() {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const values = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(values);
    const next = Array.from({ length: 20 }, (_, index) => Math.max(0.12, (values[index * Math.max(1, Math.floor(values.length / 20))] ?? 0) / 255));
    setLevels(next);
    animationRef.current = requestAnimationFrame(animateWaveform);
  }

  async function startRecording() {
    if (recording || preview) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const supportedMimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((mimeType) =>
				typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(mimeType)
			);
      const recorder = supportedMimeType
				? new MediaRecorder(stream, { mimeType: supportedMimeType })
				: new MediaRecorder(stream);
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      streamRef.current = stream;
      recorderRef.current = recorder;
      analyserRef.current = analyser;
      chunksRef.current = [];
			limitReasonRef.current = "";
			elapsedRef.current = 0;
			activeSinceRef.current = Date.now();
			setLimitMessage("");
	      recorder.ondataavailable = (event) => {
				if (event.data.size <= 0) return;
				chunksRef.current.push(event.data);
				const bytes = chunksRef.current.reduce((total, chunk) => total + (chunk instanceof Blob ? chunk.size : 0), 0);
				if (bytes > maxVoiceNoteBytes && recorder.state !== "inactive") {
					limitReasonRef.current = "Voice notes must be 8 MB or smaller.";
					recorder.stop();
				}
			};
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || supportedMimeType || "audio/webm" });
				if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
				stopTimerRef.current = null;
				activeSinceRef.current = null;
				setRecording(false);
				setPaused(false);
				const sizeError = voiceNoteSizeError(blob.size);
				if (sizeError || limitReasonRef.current) {
					setLimitMessage(limitReasonRef.current || sizeError);
					stream.getTracks().forEach((track) => track.stop());
					void context.close();
					setLevels(Array.from({ length: 20 }, () => 0.15));
					return;
				}
				const extension = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `voice-note-${Date.now()}.${extension}`, { type: blob.type || supportedMimeType || "audio/webm" });
        setPreview({ url: URL.createObjectURL(blob), file });
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
        setLevels(Array.from({ length: 20 }, () => 0.15));
      };
      recorder.start(120);
      setPermission("idle");
      setRecording(true);
			setPaused(false);
			scheduleDurationLimit();
      animateWaveform();
    } catch {
      setPermission("denied");
    }
  }

	function scheduleDurationLimit() {
		if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
		const remaining = maxVoiceNoteDurationMs - elapsedRef.current;
		stopTimerRef.current = window.setTimeout(() => {
			limitReasonRef.current = "Voice notes can be up to five minutes long.";
			stopRecording();
		}, remaining);
	}

	function togglePause() {
		const recorder = recorderRef.current;
		if (!recorder || recorder.state === "inactive") return;
		if (recorder.state === "recording") {
			recorder.pause();
			if (activeSinceRef.current !== null) elapsedRef.current += Date.now() - activeSinceRef.current;
			activeSinceRef.current = null;
			if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
			stopTimerRef.current = null;
			if (animationRef.current) cancelAnimationFrame(animationRef.current);
			animationRef.current = null;
			setPaused(true);
			return;
		}
		recorder.resume();
		activeSinceRef.current = Date.now();
		setPaused(false);
		scheduleDurationLimit();
		animateWaveform();
	}

  function stopRecording() {
    if (!recorderRef.current || recorderRef.current.state === "inactive") return;
		if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
		stopTimerRef.current = null;
		if (activeSinceRef.current !== null) elapsedRef.current += Date.now() - activeSinceRef.current;
		activeSinceRef.current = null;
    recorderRef.current.stop();
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    setRecording(false);
  }

  function discardPreview() {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

  if (preview) {
    return <div className="flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--canvas)] px-2 py-1"><audio src={preview.url} controls className="h-8 max-w-40" /><button type="button" onClick={() => { onRecord(preview.file); discardPreview(); }} aria-label="Add voice note to Send" title="Add voice note to Send" className="grid size-8 place-items-center rounded-lg bg-[var(--signal)] text-white"><Check className="size-4" /></button><button type="button" onClick={discardPreview} aria-label="Discard voice note" title="Discard voice note" className="grid size-8 place-items-center rounded-lg border border-[var(--border)] text-[var(--muted)]"><Trash2 className="size-4" /></button></div>;
  }

  if (recording) {
    return <div className="flex items-center gap-2 rounded-xl border border-[var(--signal)] bg-[var(--signal-soft)] px-2 py-1"><div className="flex h-8 items-center gap-0.5" aria-label="Voice waveform">{levels.map((level, index) => <span key={index} className="w-1 rounded-full bg-[var(--signal)] transition-[height]" style={{ height: `${Math.max(5, level * 28)}px` }} />)}</div><span className="min-w-14 text-xs font-semibold text-[var(--foreground)]">{paused ? "Paused" : "Recording"}</span><button type="button" onClick={togglePause} aria-label={paused ? "Resume recording" : "Pause recording"} title={paused ? "Resume recording" : "Pause recording"} className="grid size-8 place-items-center rounded-lg border border-[var(--border)] text-[var(--foreground)]">{paused ? <Play className="size-3 fill-current" /> : <Pause className="size-3 fill-current" />}</button><button type="button" onClick={stopRecording} aria-label="Stop recording" title="Stop recording and review voice note" className="grid size-8 place-items-center rounded-lg bg-[var(--warning)] text-white"><Square className="size-3 fill-current" /></button></div>;
  }

	return <div className="relative"><button type="button" onClick={() => void startRecording()} aria-label="Record voice note" title="Tap to record voice note" className="grid size-10 place-items-center rounded-xl border border-[var(--border)] text-[var(--muted)]"><Mic className="size-4" /></button>{(permission === "denied" || limitMessage) && <div className="absolute bottom-12 right-0 z-10 flex w-52 items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs shadow-lg"><X className="mt-0.5 size-3 shrink-0 text-[var(--warning)]" />{limitMessage || "Microphone permission is required for voice notes."}</div>}</div>;
}
