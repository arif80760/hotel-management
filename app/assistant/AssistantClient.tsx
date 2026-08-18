"use client";

// app/assistant/AssistantClient.tsx
//
// ─── AI ASSISTANT — CHAT PANEL (step 3) ─────────────────────────────────────
//
// Minimal chat UI over POST /api/assistant (step-1 staff-safe tools only:
// room availability + day sheet). Available to ANY signed-in user — the
// route enforces auth server-side; this page just forwards the session's
// Bearer token like the employee admin routes do.
//
// Sentence-plus-receipt pattern (design §6): the model's prose renders
// above a collapsible "Figures" panel showing each tool called, the exact
// parameters it was called with, and the raw result — so a wrong period or
// category is VISIBLE, and a doubted number can be checked, not trusted.
//
// Answer bubbles are tinted by evidence: white = backed by tool figures,
// amber = no tool ran (refusal / admin-only / clarifying question),
// rose = transport or server error (missing API key, network, 5xx).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type ToolResult = { tool: string; input: unknown; result: unknown };

type Exchange = {
  id: string;
  question: string;
  status: "loading" | "done" | "error";
  answer?: string;
  toolResults?: ToolResult[];
  error?: string;
};

const STARTERS: string[] = [
  "Which rooms are free tonight?",
  "আজকের চেক-ইন আর চেক-আউট কয়টা?",
  "Who is in-house right now?",
  "Any overdue checkouts?",
  "কাল থেকে ২ রাতের জন্য কোন কোন রুম খালি আছে?",
  "Outstanding dues of in-house guests?",
];

const TOOL_LABELS: Record<string, string> = {
  check_room_availability: "Room availability",
  get_day_sheet: "Day sheet",
};

function formatParams(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ");
}

export default function AssistantClient() {
  const [items, setItems] = useState<Exchange[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items]);

  async function ask(raw: string) {
    const question = raw.trim();
    if (!question || sending) return;

    const id = crypto.randomUUID();
    setItems((prev) => [...prev, { id, question, status: "loading" }]);
    setInput("");
    setSending(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in — please refresh and log in again.");

      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ question }),
      });

      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? `Request failed (${res.status}).`);
      }

      setItems((prev) => prev.map((it) => it.id === id
        ? { ...it, status: "done", answer: body.answer ?? "", toolResults: body.tool_results ?? [] }
        : it));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setItems((prev) => prev.map((it) => it.id === id
        ? { ...it, status: "error", error: message }
        : it));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-8rem)] max-w-3xl flex-col px-1 md:px-0">
      {/* Header */}
      <div className="mb-3">
        <h1 className="text-lg font-bold text-slate-800">Assistant</h1>
        <p className="text-[12.5px] text-slate-500">
          Ask about room availability, today&apos;s check-ins/check-outs, in-house guests,
          occupancy, and dues — answers come from the hotel&apos;s live data only.
          Bengali or English, either works.
        </p>
      </div>

      {/* Conversation */}
      <div className="flex-1 space-y-4 overflow-y-auto pb-3 pr-1">
        {items.length === 0 && (
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="mb-3 text-[13px] font-semibold text-slate-600">Try asking:</p>
            <div className="flex flex-wrap gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => ask(s)}
                  className="min-h-[44px] rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-left text-[13px] text-slate-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {items.map((it) => (
          <div key={it.id} className="space-y-2">
            {/* User bubble */}
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-slate-800 px-4 py-2.5 text-[13.5px] text-white">
                {it.question}
              </div>
            </div>

            {/* Assistant bubble */}
            {it.status === "loading" && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3">
                  <span className="flex items-center gap-1.5 text-[13px] text-slate-500">
                    Checking the data
                    <span className="inline-flex gap-1">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]" />
                    </span>
                  </span>
                </div>
              </div>
            )}

            {it.status === "error" && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-rose-200 bg-rose-50 px-4 py-2.5">
                  <p className="text-[12px] font-semibold uppercase tracking-wide text-rose-500">
                    Something went wrong
                  </p>
                  <p className="mt-0.5 text-[13px] text-rose-700">{it.error}</p>
                </div>
              </div>
            )}

            {it.status === "done" && (
              <div className="flex justify-start">
                <div
                  className={`max-w-[92%] rounded-2xl rounded-bl-md border px-4 py-3 ${
                    (it.toolResults?.length ?? 0) > 0
                      ? "border-slate-200 bg-white"
                      : "border-amber-200 bg-amber-50"
                  }`}
                >
                  <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-slate-800">
                    {it.answer}
                  </p>
                  {(it.toolResults?.length ?? 0) === 0 && (
                    <p className="mt-1.5 text-[11px] text-amber-600">
                      No data was used for this reply.
                    </p>
                  )}
                  {(it.toolResults?.length ?? 0) > 0 && (
                    <FiguresPanel toolResults={it.toolResults!} />
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={(e) => { e.preventDefault(); ask(input); }}
        className="mt-1 flex items-center gap-2 border-t border-slate-200 pt-3"
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question… / প্রশ্ন লিখুন…"
          disabled={sending}
          maxLength={1000}
          className="min-h-[44px] w-full flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[13.5px] text-slate-800 placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-50"
        />
        <button
          type="submit"
          disabled={sending || input.trim() === ""}
          className="min-h-[44px] shrink-0 rounded-xl bg-emerald-600 px-5 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {sending ? "…" : "Ask"}
        </button>
      </form>
    </div>
  );
}

// ─── Figures panel — the receipt under the sentence ─────────────────────────

function FiguresPanel({ toolResults }: { toolResults: ToolResult[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2.5 border-t border-slate-100 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[32px] items-center gap-1.5 text-[12px] font-semibold text-slate-500 transition-colors hover:text-emerald-700"
      >
        <svg
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        Figures · {toolResults.length} {toolResults.length === 1 ? "lookup" : "lookups"}
      </button>

      {open && (
        <div className="mt-2 space-y-3">
          {toolResults.map((tr, i) => (
            <div key={i} className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
              <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                  {TOOL_LABELS[tr.tool] ?? tr.tool}
                </span>
                <span className="text-[11.5px] text-slate-500">{formatParams(tr.input)}</span>
              </div>
              <pre className="max-h-64 overflow-auto rounded-md bg-white p-2 text-[11px] leading-snug text-slate-700 tabular-nums">
{JSON.stringify(tr.result, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
