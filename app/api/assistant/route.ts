// app/api/assistant/route.ts
//
// ─── AI ASSISTANT (SERVER-ONLY) ──────────────────────────────────────────────
//
// POST { question: string } → NDJSON stream:
//   {type:"delta", text}   — final-answer text as it is generated
//   {type:"done", answer, tool_results, model, timings}
//   {type:"error", error}
// (Auth/validation failures return plain JSON with a non-200 status before
// any stream starts — the client branches on content-type.)
//
// Staff ask natural-language questions; the model answers ONLY by calling the
// fixed query tools in ./tools.ts (it never writes SQL, never reads a table).
// Step 1+3 scope: the two staff-safe tools. Financial tools (admin-only menu)
// come later.
//
// SPEED (2026-08-18, after live testing on Sonnet 5):
//   • No Models API capability lookup. Thinking is OFF by default — choosing
//     between two tools needs no extended reasoning and Sonnet would actually
//     spend time on it. ASSISTANT_THINKING=on enables it for testing; when on
//     it is sent optimistically and the specific 400 for models that don't
//     support adaptive thinking triggers ONE retry without it, remembered per
//     process. The common path never pays a lookup.
//   • The final answer is STREAMED (NDJSON deltas) so text appears as it is
//     generated. Calls made BEFORE any tool result are buffered — that is
//     where the no-guessing backstop applies (an answer with money-like
//     figures and zero tool calls is discarded), and buffering keeps the
//     backstop airtight; those replies are short (a tool call or a one-line
//     refusal/clarification) so nothing meaningful is delayed.
//   • Prompt caching: cache_control on the last system block caches tools +
//     system together. NOTE: Sonnet 5's minimum cacheable prefix is 2048
//     tokens and this prompt currently sits near that line, so the marker may
//     silently no-op today — it is harmless, costs nothing when it misses,
//     and starts paying as the tool set grows (financial tools, step 2).
//   • System prompt + tool schemas trimmed to the minimum that preserves the
//     rules (Banglish vocabulary and language mirroring included — d88c539).
//
// Stage timings are measured, logged, and returned in "done" so live
// questions show where time goes.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAdminClient } from "@/lib/supabaseAdmin";
import {
  TOOL_SCHEMAS,
  checkRoomAvailability,
  getDaySheet,
  dhakaTodayISO,
} from "./tools";
import {
  FINANCIAL_TOOL_SCHEMAS,
  getRevenueSummary,
  getExpenseSummary,
  getRemuneration,
  getProfitSummary,
  getAccountBalances,
} from "./financialTools";

export const maxDuration = 60;

const MAX_TOOL_ITERATIONS = 5;

const CANT_ANSWER =
  "I can't answer that from the hotel's data I have access to. " +
  "I can currently answer questions about room availability, and the daily " +
  "sheet (check-ins, check-outs, in-house guests, occupancy, dues of in-house guests).";

// Financial questions from STAFF: the model calls the flag tool below and the
// ROUTE short-circuits with this fixed bilingual message — the refusal is
// route-enforced, not model-generated, and staff never see the financial
// tool schemas at all (the model cannot call what it is not offered).
const ADMIN_ONLY_MESSAGE =
  "Financial information (revenue, expenses, remuneration, profit, account balances) is admin-only — " +
  "please ask an admin. আর্থিক তথ্য (আয়, খরচ, লাভ, ব্যালেন্স) শুধুমাত্র অ্যাডমিনদের জন্য।";

const STAFF_FINANCIAL_FLAG_TOOL = {
  name: "flag_financial_question",
  description:
    "Call this when the question asks about money totals: revenue, income, takings, expenses, costs, remuneration, director payments, profit, or account balances (in any language — including Banglish like 'koto taka aslo'). Do NOT answer such questions yourself.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

// ── Thinking: off by default; optimistic send + retry-on-400 when enabled ──
const thinkingUnsupported = new Set<string>();

function thinkingParams(model: string): Pick<Anthropic.MessageCreateParams, "thinking"> {
  if ((process.env.ASSISTANT_THINKING ?? "off") !== "on") return {};
  if (thinkingUnsupported.has(model)) return {};
  return { thinking: { type: "adaptive" } };
}

function isThinkingUnsupported400(err: unknown): boolean {
  return err instanceof Anthropic.BadRequestError &&
    /thinking.*not supported|not supported.*thinking/i.test(err.message);
}

// ── System prompt (static part first for the cache; date/role at the end) ──
function systemBlocks(role: string): Anthropic.TextBlockParam[] {
  const staticPart = [
    "You are the in-app assistant for Hotel Albatross's management system. Staff ask about hotel operations.",
    "",
    "RULES:",
    "1. Every figure, name, or date you state MUST come from a tool result in this conversation — you have no other knowledge of this hotel's data. Never estimate or guess.",
    "2. If no tool can answer, say you cannot answer from the available data and say what you CAN answer.",
    "3. If the date or category is ambiguous, ask ONE short clarifying question. 'Today' always means today's Dhaka date.",
    "4. Amounts in Taka like ৳2,500; dates are hotel-local (Asia/Dhaka).",
    "5. Lead with the answer and name the period it covers. The raw figures are shown to the user alongside your reply — summarise, don't repeat long lists; point out overdue checkouts and large dues.",
    "6. Questions arrive in Bengali script, English, or ROMANISED Bengali (Banglish — Bengali in Latin letters; very common). Banglish vocabulary: khali/faka = free/available; ache = is there; 'room khali ache/hobe' = is/will the room be available — that IS a room-availability question, call check_room_availability; tarik = date; theke = from; prjnto/porjonto = until; aj/ajke = today; kal/kalke = tomorrow OR yesterday by context (ask if unclear); koto = how many; kobe = when; kon = which. Example: '104 number room khali hobe september 4 tarik theke september 6 tarik prjnto' → check_room_availability 2026-09-04 to 2026-09-06, report on room 104.",
    "7. Reply in the SAME language and script as the question: English → English; Bengali script → Bengali script; Banglish → Banglish in Latin letters (NEVER Bengali script). Booking refs (BK-XXXX), room numbers, and dates stay Latin/ISO.",
    role === "admin"
      ? "8. Financial tools: revenue is money RECEIVED (checkout write-off discounts are invisible by design); refunds net against revenue; remuneration is an appropriation of profit, never an expense; 'adjustment' rows are corrections outside every total. Relay the meta warnings (test-data ranges, unclassified kinds) — never hide them."
      : "8. For ANY question about money totals — revenue, income, expenses, costs, remuneration, profit, balances — call flag_financial_question. Never answer or refuse those yourself.",
  ].join("\n");

  return [
    // cache_control caches tools + this block together (prefix ends here)
    { type: "text", text: staticPart, cache_control: { type: "ephemeral" } },
    { type: "text", text: `Today (Asia/Dhaka): ${dhakaTodayISO()}. User role: ${role}.` },
  ];
}

/** Money-like figures with no tool call → discard (years/ISO dates/refs scrubbed). */
function containsMoneyLikeFigures(text: string): boolean {
  const scrubbed = text
    .replace(/\b(19|20)\d{2}(-\d{2}){0,2}\b/g, "")
    .replace(/\bBK-\d+\b/gi, "");
  return /৳\s?[\d,.]+/.test(scrubbed) || /\b\d{1,3}(,\d{3})+\b/.test(scrubbed) || /\b\d{3,}\b/.test(scrubbed);
}

export async function POST(req: NextRequest) {
  try {
    // ── Auth gate: any authenticated staff member with a profile ──
    const adminClient = getAdminClient();
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized — missing Bearer token." }, { status: 401 });
    }
    const { data: { user }, error: jwtError } = await adminClient.auth.getUser(token);
    if (jwtError || !user) {
      return NextResponse.json({ error: "Unauthorized — invalid or expired token." }, { status: 401 });
    }
    const { data: profile, error: profileError } = await adminClient
      .from("profiles").select("role").eq("id", user.id).single();
    if (profileError || !profile) {
      return NextResponse.json({ error: "Forbidden — no profile for this login." }, { status: 403 });
    }
    const role: string = profile.role ?? "staff";

    // ── Input ──
    const body = await req.json().catch(() => null);
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question || question.length > 1000) {
      return NextResponse.json({ error: "Provide a question (1–1000 characters)." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Assistant is not configured (missing ANTHROPIC_API_KEY on the server)." },
        { status: 500 },
      );
    }

    // Tool menu by role: staff get the two staff-safe tools plus the
    // financial-question FLAG (route-enforced refusal); admins additionally
    // get the five financial tools. Staff requests never contain the
    // financial schemas — the model cannot call what it is not offered.
    const isAdmin = role === "admin";
    const tools = isAdmin
      ? [...TOOL_SCHEMAS, ...FINANCIAL_TOOL_SCHEMAS]
      : [...TOOL_SCHEMAS, STAFF_FINANCIAL_FLAG_TOOL];
    const anthropic = new Anthropic();
    const model = process.env.ASSISTANT_MODEL ?? "claude-opus-4-8";
    const system = systemBlocks(role);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

        const timings: Record<string, number> = { tools_ms: 0 };
        const t0 = Date.now();
        let modelCalls = 0;

        // One model call. Streams deltas to the client only when `emit` —
        // i.e. after at least one tool result exists (keeps the no-guessing
        // backstop airtight on the zero-tool path). Retries once without
        // thinking on the specific unsupported-thinking 400.
        const callModel = async (
          messages: Anthropic.MessageParam[],
          emit: boolean,
        ): Promise<Anthropic.Message> => {
          const base: Anthropic.MessageCreateParams = {
            model,
            max_tokens: 2000,
            ...thinkingParams(model),
            system,
            tools,
            messages,
          };
          const mark = Date.now();
          try {
            const s = anthropic.messages.stream(base);
            if (emit) s.on("text", (delta) => send({ type: "delta", text: delta }));
            const msg = await s.finalMessage();
            modelCalls++;
            timings[`model_call_${modelCalls}_ms`] = Date.now() - mark;
            return msg;
          } catch (err) {
            if (!isThinkingUnsupported400(err) || !("thinking" in base)) throw err;
            thinkingUnsupported.add(model);
            console.warn(`[assistant] ${model} rejected adaptive thinking; retrying without (remembered).`);
            const { thinking: _drop, ...withoutThinking } = base;
            const s = anthropic.messages.stream(withoutThinking);
            if (emit) s.on("text", (delta) => send({ type: "delta", text: delta }));
            const msg = await s.finalMessage();
            modelCalls++;
            timings[`model_call_${modelCalls}_ms`] = Date.now() - mark;
            return msg;
          }
        };

        try {
          const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
          const toolResults: { tool: string; input: unknown; result: unknown }[] = [];

          let response = await callModel(messages, false);

          for (let i = 0; i < MAX_TOOL_ITERATIONS && response.stop_reason === "tool_use"; i++) {
            const toolUses = response.content.filter(
              (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
            );
            messages.push({ role: "assistant", content: response.content });

            // Staff financial question → the ROUTE answers, not the model.
            if (toolUses.some((tu) => tu.name === "flag_financial_question")) {
              send({ type: "delta", text: ADMIN_ONLY_MESSAGE });
              timings.total_ms = Date.now() - t0;
              send({ type: "done", answer: ADMIN_ONLY_MESSAGE, tool_results: [], model, timings });
              return;
            }

            const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
            const toolsStart = Date.now();
            for (const tu of toolUses) {
              try {
                let result: unknown;
                if (tu.name === "check_room_availability") {
                  result = await checkRoomAvailability(
                    adminClient,
                    tu.input as { check_in: string; check_out: string; category: string | null },
                  );
                } else if (tu.name === "get_day_sheet") {
                  result = await getDaySheet(adminClient, tu.input as { date: string });
                } else if (!isAdmin && tu.name.startsWith("get_")) {
                  // Defense in depth — staff menus never contain these schemas,
                  // so this branch should be unreachable.
                  throw new Error("Financial tools are admin-only.");
                } else if (tu.name === "get_revenue_summary") {
                  result = await getRevenueSummary(adminClient, tu.input as never);
                } else if (tu.name === "get_expense_summary") {
                  result = await getExpenseSummary(adminClient, tu.input as never);
                } else if (tu.name === "get_remuneration") {
                  result = await getRemuneration(adminClient, tu.input as never);
                } else if (tu.name === "get_profit_summary") {
                  result = await getProfitSummary(adminClient, tu.input as never);
                } else if (tu.name === "get_account_balances") {
                  result = await getAccountBalances(adminClient);
                } else {
                  throw new Error(`Unknown tool: ${tu.name}`);
                }
                toolResults.push({ tool: tu.name, input: tu.input, result });
                resultBlocks.push({
                  type: "tool_result",
                  tool_use_id: tu.id,
                  content: JSON.stringify(result),
                });
              } catch (toolErr) {
                const message = toolErr instanceof Error ? toolErr.message : String(toolErr);
                resultBlocks.push({
                  type: "tool_result",
                  tool_use_id: tu.id,
                  content: `Tool error: ${message}`,
                  is_error: true,
                });
              }
            }
            timings.tools_ms += Date.now() - toolsStart;

            messages.push({ role: "user", content: resultBlocks });
            // Tool results exist → the answer that follows may stream live.
            response = await callModel(messages, true);
          }

          let answer = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();

          // No-guessing backstop (zero-tool path only — that path was buffered,
          // so nothing wrong was ever shown).
          if (toolResults.length === 0 && containsMoneyLikeFigures(answer)) {
            console.warn("[assistant] discarded figure-bearing answer with no tool call; question:", question);
            answer = CANT_ANSWER;
          }
          if (!answer) answer = CANT_ANSWER;

          // Zero-tool replies were never streamed — deliver the text now.
          if (toolResults.length === 0) send({ type: "delta", text: answer });

          timings.total_ms = Date.now() - t0;
          console.log("[assistant] timings:", JSON.stringify(timings), "model:", model);
          send({ type: "done", answer, tool_results: toolResults, model, timings });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[assistant] stream error:", message);
          send({ type: "error", error: `Assistant failed: ${message}` });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[assistant] route error:", message);
    return NextResponse.json({ error: `Assistant failed: ${message}` }, { status: 500 });
  }
}
