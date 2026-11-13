import type { DesktopApi } from "../../electron/preload";
import {
  isApiKeyError,
  showNeedApiKeyToast,
} from "./cursor-api-key.js";
import { icons } from "./icons.js";
import { getLocale, t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import { showToast } from "./toast.js";

type MeetingStatus = "idle" | "recording" | "paused" | "done";

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export type MeetingPaneController = {
  el: HTMLDivElement;
  meetingId: string;
  title: string;
  dispose: () => void;
  setTitle: (title: string) => void;
};

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function pickMimeType(): string | undefined {
  // Chromium on Windows often prefers webm/opus; fall back broadly.
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const type of candidates) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(type)
    ) {
      return type;
    }
  }
  return undefined;
}

function speechLang(): string {
  return getLocale() === "ko" ? "ko-KR" : "en-US";
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function createMeetingPane(opts: {
  api: DesktopApi;
  meetingId: string;
  title: string;
  transcript?: string;
  notes?: string;
  summary?: string;
  durationMs?: number;
  onTitleChange?: (title: string) => void;
  onNeedApiKey?: () => void;
}): MeetingPaneController {
  const el = document.createElement("div");
  el.className = "meeting-pane";

  let title = opts.title;
  let transcriptFinal = opts.transcript ?? "";
  let transcriptInterim = "";
  let notes = opts.notes ?? "";
  let summary = opts.summary ?? "";
  let status: MeetingStatus = "idle";
  let durationMs = opts.durationMs ?? 0;
  let recordingStartedAt: number | null = null;
  let accumulatedMs = durationMs;
  let timerId: number | undefined;
  let saveTimer: number | undefined;
  let disposed = false;

  let mediaStream: MediaStream | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  const chunks: BlobPart[] = [];
  let recognition: SpeechRecognitionLike | null = null;
  let wantRecognition = false;
  let recognitionRestartTimer: number | undefined;
  let summarizing = false;
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let meterRaf = 0;

  el.innerHTML = `
    <div class="meeting-toolbar">
      <input class="meeting-title" type="text" spellcheck="false" />
      <div class="meeting-timer" data-role="timer">00:00</div>
      <div class="meeting-meter hidden" data-role="meter" title="${escapeHtml(t("meeting.meterHint"))}">
        <span class="meeting-meter-label">${icons.mic(12)}</span>
        <span class="meeting-meter-track"><span class="meeting-meter-fill" data-role="meter-fill"></span></span>
      </div>
      <div class="meeting-status" data-role="status"></div>
      <div class="meeting-actions">
        <button type="button" class="meeting-btn primary" data-action="record">${icons.mic(14)}<span data-i18n-label="record">${t("meeting.record")}</span></button>
        <button type="button" class="meeting-btn" data-action="pause" disabled>${icons.pause(14)}<span>${t("meeting.pause")}</span></button>
        <button type="button" class="meeting-btn danger" data-action="stop" disabled>${icons.stopRec(14)}<span>${t("meeting.stop")}</span></button>
        <button type="button" class="meeting-btn" data-action="summarize">${icons.sparkles(14)}<span>${t("meeting.summarize")}</span></button>
        <button type="button" class="meeting-btn" data-action="export">${icons.export(14)}<span>${t("meeting.export")}</span></button>
      </div>
      <div class="meeting-saved" data-role="saved">${t("meeting.saved")}</div>
    </div>
    <div class="meeting-body">
      <section class="meeting-col">
        <header class="meeting-col-head">
          <h3>${t("meeting.transcript")}</h3>
          <span class="meeting-hint" data-role="stt-hint"></span>
        </header>
        <div class="meeting-transcript" data-role="transcript"></div>
      </section>
      <section class="meeting-col">
        <header class="meeting-col-head"><h3>${t("meeting.notes")}</h3></header>
        <textarea class="meeting-notes" data-role="notes" spellcheck="true" placeholder="${t("meeting.notesPlaceholder")}"></textarea>
      </section>
      <section class="meeting-col">
        <header class="meeting-col-head"><h3>${t("meeting.summary")}</h3></header>
        <div class="meeting-summary md" data-role="summary"></div>
      </section>
    </div>
  `;

  const titleInput = el.querySelector(".meeting-title") as HTMLInputElement;
  const timerEl = el.querySelector('[data-role="timer"]') as HTMLElement;
  const meterEl = el.querySelector('[data-role="meter"]') as HTMLElement;
  const meterFillEl = el.querySelector(
    '[data-role="meter-fill"]'
  ) as HTMLElement;
  const statusEl = el.querySelector('[data-role="status"]') as HTMLElement;
  const savedEl = el.querySelector('[data-role="saved"]') as HTMLElement;
  const transcriptEl = el.querySelector(
    '[data-role="transcript"]'
  ) as HTMLElement;
  const notesEl = el.querySelector(
    '[data-role="notes"]'
  ) as HTMLTextAreaElement;
  const summaryEl = el.querySelector('[data-role="summary"]') as HTMLElement;
  const sttHintEl = el.querySelector('[data-role="stt-hint"]') as HTMLElement;
  const btnRecord = el.querySelector(
    '[data-action="record"]'
  ) as HTMLButtonElement;
  const btnPause = el.querySelector(
    '[data-action="pause"]'
  ) as HTMLButtonElement;
  const btnStop = el.querySelector(
    '[data-action="stop"]'
  ) as HTMLButtonElement;
  const btnSummarize = el.querySelector(
    '[data-action="summarize"]'
  ) as HTMLButtonElement;
  const btnExport = el.querySelector(
    '[data-action="export"]'
  ) as HTMLButtonElement;

  titleInput.value = title;
  notesEl.value = notes;
  savedEl.classList.add("hidden");

  function flashSaved(): void {
    savedEl.classList.remove("hidden");
    window.clearTimeout((flashSaved as unknown as { t?: number }).t);
    (flashSaved as unknown as { t?: number }).t = window.setTimeout(() => {
      savedEl.classList.add("hidden");
    }, 1400);
  }

  function renderTranscript(): void {
    const finalHtml = escapeHtml(transcriptFinal).replace(/\n/g, "<br>");
    const interim = transcriptInterim
      ? `<span class="meeting-interim">${escapeHtml(transcriptInterim)}</span>`
      : "";
    transcriptEl.innerHTML =
      finalHtml || interim
        ? `${finalHtml}${finalHtml && interim ? " " : ""}${interim}`
        : `<span class="meeting-placeholder">${escapeHtml(t("meeting.transcriptEmpty"))}</span>`;
  }

  function renderSummary(): void {
    if (!summary.trim()) {
      summaryEl.innerHTML = `<span class="meeting-placeholder">${escapeHtml(t("meeting.summaryEmpty"))}</span>`;
      return;
    }
    summaryEl.innerHTML = renderMarkdown(summary);
  }

  function updateStatusUi(): void {
    const label =
      status === "recording"
        ? t("meeting.status.recording")
        : status === "paused"
          ? t("meeting.status.paused")
          : status === "done"
            ? t("meeting.status.done")
            : t("meeting.status.idle");
    statusEl.textContent = label;
    statusEl.dataset.status = status;
    el.dataset.status = status;

    const live = status === "recording" || status === "paused";
    btnRecord.disabled = live || summarizing;
    btnPause.disabled = status !== "recording" && status !== "paused";
    btnStop.disabled = !live;
    btnSummarize.disabled = summarizing || live;
    btnExport.disabled = summarizing;

    if (status === "paused") {
      btnPause.innerHTML = `${icons.play(14)}<span>${t("meeting.resume")}</span>`;
    } else {
      btnPause.innerHTML = `${icons.pause(14)}<span>${t("meeting.pause")}</span>`;
    }
  }

  function tickTimer(): void {
    let ms = accumulatedMs;
    if (status === "recording" && recordingStartedAt != null) {
      ms += Date.now() - recordingStartedAt;
    }
    durationMs = ms;
    timerEl.textContent = formatDuration(ms);
  }

  function startTimer(): void {
    stopTimer();
    timerId = window.setInterval(tickTimer, 250);
    tickTimer();
  }

  function stopTimer(): void {
    if (timerId != null) {
      window.clearInterval(timerId);
      timerId = undefined;
    }
  }

  async function persist(
    patch: {
      title?: string;
      durationMs?: number;
      status?: MeetingStatus;
      transcript?: string;
      notes?: string;
      summary?: string;
    },
    saveOpts?: { quiet?: boolean }
  ): Promise<void> {
    if (disposed) return;
    try {
      await opts.api.saveMeeting({ id: opts.meetingId, ...patch });
      if (!saveOpts?.quiet) flashSaved();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : String(err),
        "error"
      );
    }
  }

  function schedulePersistNotes(): void {
    if (saveTimer != null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      void persist({ notes, durationMs }, { quiet: true }).then(flashSaved);
    }, 500);
  }

  function stopMeter(): void {
    if (meterRaf) {
      cancelAnimationFrame(meterRaf);
      meterRaf = 0;
    }
    try {
      void audioCtx?.close();
    } catch {
      /* ignore */
    }
    audioCtx = null;
    analyser = null;
    meterFillEl.style.width = "0%";
    meterEl.classList.add("hidden");
    meterEl.classList.remove("is-hot", "is-live");
  }

  function startMeter(stream: MediaStream): void {
    stopMeter();
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      meterEl.classList.remove("hidden");
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!analyser) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i]! - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        // Boost quiet speech so the bar is readable without shouting.
        const level = Math.min(1, rms * 4.2);
        const pct = Math.round(level * 100);
        meterFillEl.style.width = `${pct}%`;
        meterEl.classList.toggle("is-live", pct >= 8);
        meterEl.classList.toggle("is-hot", pct >= 55);
        meterRaf = requestAnimationFrame(tick);
      };
      meterRaf = requestAnimationFrame(tick);
      void audioCtx.resume();
    } catch {
      stopMeter();
    }
  }

  function stopRecognition(): void {
    wantRecognition = false;
    if (recognitionRestartTimer != null) {
      window.clearTimeout(recognitionRestartTimer);
      recognitionRestartTimer = undefined;
    }
    if (!recognition) return;
    try {
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      recognition.stop();
    } catch {
      try {
        recognition.abort();
      } catch {
        /* ignore */
      }
    }
    recognition = null;
  }

  function startRecognition(): void {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      sttHintEl.textContent = t("meeting.sttUnsupported");
      return;
    }
    stopRecognition();
    wantRecognition = true;
    sttHintEl.textContent = t("meeting.sttLive");
    const rec = new Ctor();
    recognition = rec;
    rec.lang = speechLang();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          transcriptFinal = `${transcriptFinal}${transcriptFinal && !transcriptFinal.endsWith("\n") ? " " : ""}${text}`.trimStart();
          if (!transcriptFinal.endsWith("\n")) transcriptFinal += "\n";
          transcriptInterim = "";
          void persist(
            { transcript: transcriptFinal, durationMs },
            { quiet: true }
          );
        } else {
          interim += text;
        }
      }
      if (interim) transcriptInterim = interim;
      renderTranscript();
    };
    rec.onerror = (ev) => {
      const err = ev.error || "";
      if (err === "aborted" || err === "no-speech") return;
      if (err === "not-allowed" || err === "service-not-allowed") {
        wantRecognition = false;
        sttHintEl.textContent = t("meeting.sttDenied");
        return;
      }
      if (err === "network") {
        sttHintEl.textContent = t("meeting.sttNetwork");
      } else {
        sttHintEl.textContent = t("meeting.sttError");
      }
      // Windows Chromium often ends the session after errors — soft restart.
      if (wantRecognition && status === "recording") {
        if (recognitionRestartTimer != null) {
          window.clearTimeout(recognitionRestartTimer);
        }
        recognitionRestartTimer = window.setTimeout(() => {
          recognitionRestartTimer = undefined;
          if (wantRecognition && status === "recording") startRecognition();
        }, 600);
      }
    };
    rec.onend = () => {
      if (!wantRecognition || status !== "recording") return;
      // Avoid tight restart loops on Windows when the engine auto-stops.
      if (recognitionRestartTimer != null) {
        window.clearTimeout(recognitionRestartTimer);
      }
      recognitionRestartTimer = window.setTimeout(() => {
        recognitionRestartTimer = undefined;
        if (!wantRecognition || status !== "recording") return;
        try {
          rec.start();
          sttHintEl.textContent = t("meeting.sttLive");
        } catch {
          try {
            startRecognition();
          } catch {
            sttHintEl.textContent = t("meeting.sttError");
          }
        }
      }, 250);
    };
    try {
      rec.start();
    } catch {
      sttHintEl.textContent = t("meeting.sttError");
    }
  }

  async function startRecording(): Promise<void> {
    if (status === "recording" || status === "paused") return;
    try {
      // Prefer pickup of quiet speech: AGC on, light noise suppression.
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: false,
          ...({
            googAutoGainControl: true,
            googNoiseSuppression: false,
            googHighpassFilter: false,
          } as MediaTrackConstraints),
        },
        video: false,
      });
    } catch {
      showToast(t("meeting.micDenied"), "error");
      return;
    }
    chunks.length = 0;
    const mimeType = pickMimeType();
    try {
      mediaRecorder = mimeType
        ? new MediaRecorder(mediaStream, { mimeType })
        : new MediaRecorder(mediaStream);
    } catch {
      mediaStream.getTracks().forEach((tr) => tr.stop());
      mediaStream = null;
      showToast(t("meeting.recUnsupported"), "error");
      return;
    }
    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };
    mediaRecorder.start(1000);
    status = "recording";
    recordingStartedAt = Date.now();
    startTimer();
    startMeter(mediaStream);
    // Let the mic stream settle before starting STT (helps quiet speech).
    window.setTimeout(() => {
      if (status === "recording") startRecognition();
    }, 180);
    updateStatusUi();
    await persist({ status: "recording", durationMs });
  }

  async function pauseOrResume(): Promise<void> {
    if (!mediaRecorder) return;
    if (status === "recording") {
      try {
        mediaRecorder.pause();
      } catch {
        /* ignore */
      }
      if (recordingStartedAt != null) {
        accumulatedMs += Date.now() - recordingStartedAt;
        recordingStartedAt = null;
      }
      durationMs = accumulatedMs;
      status = "paused";
      wantRecognition = false;
      try {
        recognition?.stop();
      } catch {
        /* ignore */
      }
      updateStatusUi();
      tickTimer();
      await persist({ status: "paused", durationMs, transcript: transcriptFinal });
      return;
    }
    if (status === "paused") {
      try {
        mediaRecorder.resume();
      } catch {
        /* ignore */
      }
      status = "recording";
      recordingStartedAt = Date.now();
      startRecognition();
      updateStatusUi();
      await persist({ status: "recording", durationMs });
    }
  }

  async function stopRecording(): Promise<void> {
    if (!mediaRecorder) return;
    const recorder = mediaRecorder;
    wantRecognition = false;
    stopRecognition();
    if (recordingStartedAt != null) {
      accumulatedMs += Date.now() - recordingStartedAt;
      recordingStartedAt = null;
    }
    durationMs = accumulatedMs;
    stopTimer();
    tickTimer();

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        resolve(
          new Blob(chunks, {
            type: recorder.mimeType || "audio/webm",
          })
        );
      };
      try {
        if (recorder.state !== "inactive") recorder.stop();
        else resolve(new Blob(chunks, { type: "audio/webm" }));
      } catch {
        resolve(new Blob(chunks, { type: "audio/webm" }));
      }
    });

    stopMeter();
    mediaStream?.getTracks().forEach((tr) => tr.stop());
    mediaStream = null;
    mediaRecorder = null;
    status = "done";
    updateStatusUi();

    try {
      const buf = await blob.arrayBuffer();
      await opts.api.saveMeetingAudio(opts.meetingId, buf);
      await persist({
        status: "done",
        durationMs,
        transcript: transcriptFinal,
        notes,
      });
      showToast(t("meeting.recSaved"), "ok");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : String(err),
        "error"
      );
    }
  }

  async function runSummarize(): Promise<void> {
    if (summarizing) return;
    if (status === "recording" || status === "paused") {
      showToast(t("meeting.stopFirst"), "info");
      return;
    }
    await persist({
      transcript: transcriptFinal,
      notes,
      durationMs,
    });
    summarizing = true;
    updateStatusUi();
    btnSummarize.classList.add("is-busy");
    summaryEl.innerHTML = `<span class="meeting-placeholder">${escapeHtml(t("meeting.summarizing"))}</span>`;
    try {
      const res = await opts.api.summarizeMeeting(opts.meetingId);
      if ("error" in res) {
        if (isApiKeyError(res.error)) {
          showNeedApiKeyToast(opts.api, {
            openSettings: opts.onNeedApiKey,
          });
        } else {
          showToast(localizeMeetingError(res.error), "error");
        }
        renderSummary();
        return;
      }
      summary = res.summary;
      renderSummary();
      flashSaved();
      showToast(t("meeting.summaryReady"), "ok");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : String(err),
        "error"
      );
      renderSummary();
    } finally {
      summarizing = false;
      btnSummarize.classList.remove("is-busy");
      updateStatusUi();
    }
  }

  async function runExport(): Promise<void> {
    await persist({
      transcript: transcriptFinal,
      notes,
      summary,
      durationMs,
    });
    const res = await opts.api.exportMeeting(opts.meetingId);
    if (!res.ok) {
      if (!res.canceled) {
        showToast(res.error || t("meeting.exportFail"), "error");
      }
      return;
    }
    showToast(t("meeting.exportOk"), "ok");
  }

  btnRecord.onclick = () => void startRecording();
  btnPause.onclick = () => void pauseOrResume();
  btnStop.onclick = () => void stopRecording();
  btnSummarize.onclick = () => void runSummarize();
  btnExport.onclick = () => void runExport();

  titleInput.addEventListener("change", () => {
    const next = titleInput.value.trim() || title;
    title = next;
    titleInput.value = next;
    opts.onTitleChange?.(next);
    void persist({ title: next });
  });
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      titleInput.blur();
    }
  });

  notesEl.addEventListener("input", () => {
    notes = notesEl.value;
    schedulePersistNotes();
  });

  renderTranscript();
  renderSummary();
  updateStatusUi();
  tickTimer();

  if (!getSpeechRecognitionCtor()) {
    sttHintEl.textContent = t("meeting.sttUnsupported");
  }

  return {
    el,
    meetingId: opts.meetingId,
    get title() {
      return title;
    },
    setTitle(next: string) {
      title = next;
      titleInput.value = next;
    },
    dispose() {
      disposed = true;
      wantRecognition = false;
      stopRecognition();
      stopMeter();
      stopTimer();
      if (saveTimer != null) window.clearTimeout(saveTimer);
      try {
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
          mediaRecorder.stop();
        }
      } catch {
        /* ignore */
      }
      mediaStream?.getTracks().forEach((tr) => tr.stop());
      mediaStream = null;
      mediaRecorder = null;
      el.remove();
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function localizeMeetingError(codeOrMessage: string): string {
  switch (codeOrMessage) {
    case "no_api_key":
      return t("meeting.err.noApiKey");
    case "no_content":
      return t("meeting.err.noContent");
    case "not_found":
      return t("meeting.notFound");
    case "cancelled":
      return t("meeting.err.cancelled");
    case "empty":
      return t("meeting.err.empty");
    case "failed":
      return t("meeting.err.failed");
    default:
      if (/api key is not set/i.test(codeOrMessage)) {
        return t("meeting.err.noApiKey");
      }
      return codeOrMessage || t("meeting.err.failed");
  }
}
