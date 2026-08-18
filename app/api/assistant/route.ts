// app/api/assistant/route.ts
//
// ─── AI ASSISTANT (SERVER-ONLY) ──────────────────────────────────────────────
//
// POST { question: string } → { answer, tool_results, model }
//
// Staff ask natural-language questions; the model answers ONLY by calling the
// fixed query tools in ./tools.ts (it never writes SQL, never reads a table).
// Design approved by Arif 2026-08-17. Step 1: the two staff-safe tools.
//
// AUTH — enforced SERVER-SIDE (the browser only holds the anon key):
//   Bearer token → auth.getUser → profiles row required. Any authenticated
//   staff member may use the step-1 tools. When financial tools land, they
//   are added to the tool list ONLY for profiles.role === 'admin' — the model
//   never even sees their schemas for staff, so it cannot call them.
//
// NO-GUESSING BACKSTOP (design §5): if the model produced money-like figures
// without ANY successful tool call this exchange, the route discards its text
// and returns a canned refusal — numbers can only come from tool results.
// Clarifying questions (which may contain years/dates) pass through.
//
// Model: ASSISTANT_MODEL env override, default claude-opus-4-8.
// Requires ANTHROPIC_API_KEY in the server environment (.env.local + Vercel).
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

export const maxDuration = 60; // Vercel: allow the tool-use loop room to finish

const MAX_TOOL_ITERATIONS = 5;

const CANT_ANSWER =
  "I can't answer that from the hotel's data I have access to. " +
  "I can currently answer questions about room availability, and the daily " +
  "sheet (check-ins, check-outs, in-house guests, occupancy, dues of in-house guests).";

function systemPrompt(role: string): string {
  return [
    "You are the in-app assistant for Hotel Albatross's management system. Staff ask you questions about hotel operations.",
    "",
    "HARD RULES:",
    "1. Every figure, count, name, or date you state MUST come from a tool result in THIS conversation. You have no other knowledge of this hotel's data. Never estimate, never fill gaps from general knowledge.",
    `2. If no tool can answer the question, reply that you cannot answer it from the available data and say what you CAN answer. Do not guess.`,
    "3. If the question is ambiguous (which date? which category?), ask ONE short clarifying question instead of assuming — except 'today', which always means today's Dhaka date.",
    "4. Amounts are in Bangladeshi Taka; write them like ৳2,500. Dates are hotel-local (Asia/Dhaka).",
    "5. Answer concisely and lead with the number or fact asked for. Mention the exact period/date the figures cover. The raw tool figures are shown to the user alongside your answer, so do not repeat long lists — summarise and point out what matters (e.g. overdue checkouts, large dues).",
    "6. Questions about revenue, expenses, remuneration, profit, or any money totals beyond an individual booking's balance are OUT OF SCOPE for the current tools — say so plainly" +
      (role === "admin" ? " (financial tools are planned but not yet available)." : " (that information is admin-only)."),
    "7. Staff may ask in Bengali, English, or a mix of both. ALWAYS reply in the language of the question — a Bengali question gets a Bengali answer. Keep booking references (BK-XXXX), room numbers, and dates in their standard Latin/ISO form inside a Bengali sentence.",
    "",
    `Today's date (Asia/Dhaka): ${dhakaTodayISO()}`,
    `The user's role: ${role}.`,
  ].join("\n");
}

/** True when text contains money-like figures: a ৳ amount, a thousands-
 *  separated number, or a 3+ digit run that is not a year or an ISO date part.
 *  Used only when NO tool ran — clarifying questions with years pass. */
function containsMoneyLikeFigures(text: string): boolean {
  const scrubbed = text
    .replace(/\b(19|20)\d{2}(-\d{2}){0,2}\b/g, "") // years + ISO dates
    .replace(/\bBK-\d+\b/gi, "");                  // booking refs
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

    // ── Tool menu by role. Step 1: both tools are staff-safe. Financial tools
    //    will be appended here ONLY when role === 'admin'. ──
    const tools = TOOL_SCHEMAS;

    const anthropic = new Anthropic();
    const model = process.env.ASSISTANT_MODEL ?? "claude-opus-4-8";

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
    const toolResults: { tool: string; input: unknown; result: unknown }[] = [];

    let response = await anthropic.messages.create({
      model,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      system: systemPrompt(role),
      tools,
      messages,
    });

    for (let i = 0; i < MAX_TOOL_ITERATIONS && response.stop_reason === "tool_use"; i++) {
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      messages.push({ role: "assistant", content: response.content });

      const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
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

      messages.push({ role: "user", content: resultBlocks });
      response = await anthropic.messages.create({
        model,
        max_tokens: 2000,
        thinking: { type: "adaptive" },
        system: systemPrompt(role),
        tools,
        messages,
      });
    }

    const answer = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    // ── No-guessing backstop: figures without any successful tool call → refuse ──
    const anyToolRan = toolResults.length > 0;
    if (!anyToolRan && containsMoneyLikeFigures(answer)) {
      console.warn("[assistant] discarded figure-bearing answer with no tool call; question:", question);
      return NextResponse.json({ answer: CANT_ANSWER, tool_results: [], model });
    }

    return NextResponse.json({
      answer: answer || CANT_ANSWER,
      tool_results: toolResults,
      model,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[assistant] route error:", message);
    return NextResponse.json({ error: `Assistant failed: ${message}` }, { status: 500 });
  }
}
