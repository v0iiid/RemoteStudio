"use client";

import axios from "axios";
import { clientConfig, clientConfigReady } from "@/lib/config";
import { saveHostToken } from "@/lib/host-access";
import { useRouter } from "next/navigation";
import { useState } from "react";

const capabilityCards = [
  {
    title: "Live studio rooms",
    description:
      "Create a studio, share a code, and bring hosts or guests into the same remote session.",
  },
  {
    title: "Local HD masters",
    description:
      "Each device can keep its own local recording so the final file stays cleaner than the live call layer.",
  },
  {
    title: "Host collection",
    description:
      "At the end of the session, the host can collect uploaded individual recordings from the room.",
  },
];

export default function Home() {
  const [roomId, setRoomId] = useState("");
  const [joinId, setJoinId] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const router = useRouter();

  const createRoom = async () => {
    if (!clientConfigReady) {
      setErrorMessage(
        "Frontend env is missing. Set NEXT_PUBLIC_API_BASE_URL and NEXT_PUBLIC_WS_URL first."
      );
      return;
    }

    try {
      setIsCreating(true);
      setErrorMessage("");
      setInfoMessage("");
      setCopied(false);

      const res = await axios.post(`${clientConfig.apiBaseUrl}/api/createRoom`);
      const data = res.data;
      setRoomId(data.roomId);
      setJoinId(data.roomId);
      saveHostToken(data.roomId, data.hostToken);
      setInfoMessage("Room created. Share the code or enter the studio directly.");
    } catch (err) {
      console.error("error creating room", err);
      setErrorMessage(
        "Could not create a room right now. Check your env values and whether the backend is running."
      );
    } finally {
      setIsCreating(false);
    }
  };

  const joinRoom = () => {
    const targetRoom = joinId.trim() || roomId.trim();

    if (!targetRoom) {
      setErrorMessage("Enter a room ID or create a room first.");
      return;
    }

    setErrorMessage("");
    router.push(`/room/${targetRoom}`);
  };

  const copyRoomId = async () => {
    if (!roomId) {
      return;
    }

    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      setInfoMessage("Room ID copied. You can send it to your teammates now.");
      window.setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      console.error("copy failed", err);
      setErrorMessage("Copy failed on this browser. You can still share the room ID manually.");
    }
  };

  return (
    <main className="min-h-screen px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-4 rounded-[28px] border border-white/8 bg-white/4 px-5 py-4 backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.32em] text-sky-200/80">
              RemoteStudio
            </p>
            <p className="mt-1 text-sm text-slate-300">
              Remote podcast studio for hosts, guests, and recording-first sessions
            </p>
          </div>
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-200">
            <span className="h-2 w-2 rounded-full bg-emerald-300" />
            Live studio connection available now
          </div>
        </header>

        <section className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_0.95fr]">
          <div className="panel-surface rounded-[32px] p-7 sm:p-10">
            <div className="badge-soft inline-flex rounded-full px-3 py-1 text-xs font-medium uppercase tracking-[0.28em]">
              Current focus: live sessions with local masters
            </div>

            <h1 className="mt-6 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              A cleaner control room for remote podcast sessions.
            </h1>

            <p className="mt-5 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg">
              RemoteStudio handles the live room and now keeps the recording flow pointed
              toward per-device masters, so the host can collect separate uploads after the
              session instead of relying only on live-call quality.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <div className="status-pill rounded-full px-4 py-2 text-sm text-slate-200">
                Remote studio sessions
              </div>
              <div className="status-pill rounded-full px-4 py-2 text-sm text-slate-200">
                Join by studio code
              </div>
              <div className="status-pill rounded-full px-4 py-2 text-sm text-slate-200">
                Host download flow
              </div>
            </div>

            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {capabilityCards.map((card) => (
                <article key={card.title} className="panel-muted rounded-[24px] p-5">
                  <p className="text-sm font-semibold text-white">{card.title}</p>
                  <p className="mt-3 text-sm leading-6 text-slate-300">
                    {card.description}
                  </p>
                </article>
              ))}
            </div>
          </div>

          <aside className="panel-surface rounded-[32px] p-7 sm:p-8">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.28em] text-sky-200/80">
                Studio Lobby
              </p>
              <h2 className="mt-3 text-2xl font-semibold text-white">
                Start or join a studio session
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                Create a remote studio, share the ID, and bring everyone into the same
                live room with local recording support.
              </p>
            </div>

            <button
              type="button"
              onClick={createRoom}
              disabled={isCreating}
              className="mt-8 inline-flex w-full items-center justify-center rounded-2xl bg-sky-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-sky-400/60"
            >
              {isCreating ? "Creating studio..." : "Create studio session"}
            </button>

            <div className="panel-muted mt-5 rounded-[24px] p-5">
              <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
                Active studio code
              </p>
              <p className="code-text mt-4 break-all text-xl font-semibold tracking-[0.2em] text-white">
                {roomId || "Create a studio to generate a shareable code"}
              </p>

              <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={copyRoomId}
                  disabled={!roomId}
                  className="field-shell rounded-2xl px-4 py-3 text-sm font-medium text-slate-100 transition hover:border-sky-300/30 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {copied ? "Copied" : "Copy studio ID"}
                </button>
                <button
                  type="button"
                  onClick={joinRoom}
                  disabled={!roomId && !joinId.trim()}
                  className="rounded-2xl bg-emerald-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-emerald-400/60"
                >
                  Enter session
                </button>
              </div>
            </div>

            <div className="mt-5">
              <label
                htmlFor="join-room-id"
                className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400"
              >
                Join with studio ID
              </label>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <input
                  id="join-room-id"
                  className="field-shell w-full rounded-2xl px-4 py-3 text-sm text-white outline-none transition focus:border-sky-300/35"
                  onChange={(e) => setJoinId(e.target.value)}
                  value={joinId}
                  placeholder="Paste a studio code"
                  type="text"
                />
                <button
                  type="button"
                  onClick={joinRoom}
                  className="rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-sm font-medium text-white transition hover:bg-white/10"
                >
                  Join studio
                </button>
              </div>
            </div>

            {(infoMessage || errorMessage) && (
              <div
                className={`mt-5 rounded-2xl px-4 py-3 text-sm ${
                  errorMessage
                    ? "border border-rose-300/20 bg-rose-400/10 text-rose-100"
                    : "border border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
                }`}
              >
                {errorMessage || infoMessage}
              </div>
            )}
          </aside>
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-[1fr_1fr_1.1fr]">
          <article className="panel-muted rounded-[28px] p-6">
            <p className="text-sm font-semibold text-white">What already feels solid</p>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              The app now has the right core story: room creation, live connection, local
              device capture, and host-side collection of uploaded masters.
            </p>
          </article>

          <article className="panel-muted rounded-[28px] p-6">
            <p className="text-sm font-semibold text-white">What this UI pass improves</p>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              Clearer hierarchy, stronger call-to-actions, and a recording-first studio
              story without disrupting the existing live-room architecture.
            </p>
          </article>

          <article className="rounded-[28px] border border-sky-300/14 bg-sky-400/10 p-6">
            <p className="text-sm font-semibold text-sky-100">Roadmap framing</p>
            <p className="mt-3 text-sm leading-6 text-slate-200">
              The next step from here is reliability rather than foundation:
              <span className="mt-2 block text-slate-300">
                retry upload, recording progress syncing, and richer production controls.
              </span>
            </p>
          </article>
        </section>
      </div>
    </main>
  );
}
