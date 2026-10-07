import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceNoteRecorder } from "@/components/voice-note-recorder";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VoiceNoteRecorder", () => {
  it("starts recording on tap and keeps recording until Stop is tapped", async () => {
    const stopTrack = vi.fn();
    const stopRecorder = vi.fn(function (this: MockMediaRecorder) {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["voice"], { type: "audio/webm" }) } as BlobEvent);
      this.onstop?.();
    });

    class MockMediaRecorder {
      static isTypeSupported = vi.fn((mimeType: string) => mimeType === "audio/webm;codecs=opus");
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType ?? this.mimeType;
      }

      start() {
        this.state = "recording";
      }

      pause() {
        this.state = "paused";
      }

      resume() {
        this.state = "recording";
      }

      stop = stopRecorder;
    }

    const stream = { getTracks: () => [{ stop: stopTrack }] };
    const mediaDevices = { getUserMedia: vi.fn().mockResolvedValue(stream) };
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { mediaDevices }));
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    vi.stubGlobal("AudioContext", class {
      createMediaStreamSource() { return { connect: vi.fn() }; }
      createAnalyser() { return { fftSize: 0, frequencyBinCount: 32, getByteFrequencyData: vi.fn() }; }
      close() { return Promise.resolve(); }
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:voice-note"), revokeObjectURL: vi.fn() }));

    const onRecord = vi.fn();
    render(<VoiceNoteRecorder onRecord={onRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Record voice note" }));

    await screen.findByText("Recording");
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    fireEvent.click(screen.getByRole("button", { name: "Pause recording" }));
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume recording" }));
    expect(await screen.findByText("Recording")).toBeInTheDocument();

    fireEvent.pointerUp(screen.getByLabelText("Voice waveform"));
    fireEvent.pointerLeave(screen.getByLabelText("Voice waveform"));
    expect(screen.getByText("Recording")).toBeInTheDocument();
    expect(stopRecorder).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add voice note to Send" })).toBeInTheDocument());
    expect(stopRecorder).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Add voice note to Send" }));
		expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^audio\/webm/), name: expect.stringMatching(/\.webm$/) }));
		expect(MockMediaRecorder.isTypeSupported).toHaveBeenCalledWith("audio/webm;codecs=opus");
  });
});
