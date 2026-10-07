import { describe, expect, it } from "vitest";
import { maxVoiceNoteBytes, maxVoiceNoteDurationMs, voiceNoteSizeError } from "@/components/voice-note-recorder";

describe("voice-note safety limits", () => {
	it("keeps the recorder budget explicit and rejects only oversized recordings", () => {
		expect(maxVoiceNoteDurationMs).toBe(5 * 60 * 1000);
		expect(voiceNoteSizeError(maxVoiceNoteBytes)).toBe("");
		expect(voiceNoteSizeError(maxVoiceNoteBytes + 1)).toBe("Voice notes must be 8 MB or smaller.");
	});
});
