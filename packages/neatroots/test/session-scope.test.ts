import { afterEach, describe, expect, it } from "vitest";
import type { QuestionCheck } from "../src/checks/types.js";
import { parseChecks } from "../src/checks/registry.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, mockLlm, span, until } from "./helpers.js";

// scope: session is judged over the conversation's runs so far, not only the run in hand: a
// constraint the user set in turn one still reaches the question at turn two's end, and the
// finding pins to turn two with evidence from turn two only.

const ASK = "Did the agent drop the constraint the user set in an earlier turn?";
const check = (scope: string) =>
  parseChecks(`
- id: dropped-constraint
  kind: yes_no
  scope: ${scope}
  title: Constraint dropped
  ask: ${ASK}
  flag_at: 0.5
  evidence: { spans: { type: [llm] } }
`).checks[0];

const SESSION = "sess-284";
const sessionAttr = { key: "session.id", value: { stringValue: SESSION } };
const T1_USER = "Plan the launch. Constraint blue-472: never email on Fridays.";
const T2_USER = "Draft the update for Friday.";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

/** One conversation turn: an LLM exchange, then the run ends. Returns [traceId, rootSpanId]. */
async function turn(tb: Awaited<ReturnType<typeof makeRoots>>, user: string, out: string): Promise<[string, string]> {
  const t = hex(16);
  const root = hex(8);
  tb.roots.ingest([batch([llmSpan(t, root, { system: "You are a planner.", user, out, attrs: [sessionAttr] })])]);
  await tb.roots.engine!.waitIdle(t, 10_000);
  tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "planner", kind: "workflow", attrs: [sessionAttr] }), markerSpan(t, root)])]);
  await until(() => tb.roots.store.getSummary(t), 20_000);
  await tb.roots.engine!.waitIdle(t, 10_000);
  return [t, root];
}

/** Recorded decision requests (the enum-answer calls) whose evidence shows the given text. */
function decisionRequests(requests: any[], containing: string): any[] {
  return requests.filter((b) => {
    const schema = b.response_format?.json_schema;
    if (!schema?.schema?.properties?.answer?.enum) return false;
    return String(b.messages?.[b.messages.length - 1]?.content ?? "").includes(containing);
  });
}

describe("scope: session", () => {
  it("judges turn two over the whole conversation, and pins the finding to turn two", async () => {
    const llm = await mockLlm({ yesWhen: ["drop the constraint"] });
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    tb.roots.checks.save(check("session"), "user");

    const [t1] = await turn(tb, T1_USER, "Plan drafted.");
    const [t2] = await turn(tb, T2_USER, "Emailing it Friday.");

    // Turn one's question saw turn one (a one-run session reads as a trace question).
    expect(tb.roots.store.findingsForTrace(t1).some((f) => f.check_id === "dropped-constraint")).toBe(true);

    // Turn two's question was shown turn one's constraint, and still flagged.
    const t2Asked = decisionRequests(llm.requests, T2_USER);
    expect(t2Asked.length).toBeGreaterThan(0);
    expect(t2Asked.some((b) => String(b.messages[b.messages.length - 1].content).includes("blue-472"))).toBe(true);

    const f2 = tb.roots.store.findingsForTrace(t2).find((f) => f.check_id === "dropped-constraint");
    expect(f2).toBeTruthy();
    // Evidence pins to turn two's spans only, even though the judgement saw turn one.
    const t2SpanIds = new Set(tb.roots.store.getSpans(t2).map((s) => s.span_id));
    expect(f2!.evidence_span_ids.length).toBeGreaterThan(0);
    for (const id of f2!.evidence_span_ids) expect(t2SpanIds.has(id)).toBe(true);
  });

  it("scope: trace on the same conversation never sees turn one", async () => {
    const llm = await mockLlm({ yesWhen: ["drop the constraint"] });
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);
    tb.roots.checks.save(check("trace"), "user");

    await turn(tb, T1_USER, "Plan drafted.");
    const [t2] = await turn(tb, T2_USER, "Emailing it Friday.");

    const t2Asked = decisionRequests(llm.requests, T2_USER);
    expect(t2Asked.length).toBeGreaterThan(0);
    expect(t2Asked.some((b) => String(b.messages[b.messages.length - 1].content).includes("blue-472"))).toBe(false);
  });

  it("previews the newest run of a session over its history", async () => {
    const llm = await mockLlm({ yesWhen: ["drop the constraint"] });
    cleanup.push(llm.close);
    const tb = await makeRoots({ llmUrl: llm.url });
    cleanup.unshift(tb.close);

    await turn(tb, T1_USER, "Plan drafted.");
    const [t2] = await turn(tb, T2_USER, "Emailing it Friday.");

    const preview = await tb.roots.engine!.previewCheck(check("session") as QuestionCheck);
    expect(preview.checked).toBe(1);
    expect(preview.hits).toHaveLength(1);
    expect(preview.hits[0].trace_id).toBe(t2);
    const t2SpanIds = new Set(tb.roots.store.getSpans(t2).map((s) => s.span_id));
    for (const id of preview.hits[0].evidence_span_ids) expect(t2SpanIds.has(id)).toBe(true);
  });
});
