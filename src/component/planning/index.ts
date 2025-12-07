/**
 * Planning Interview System
 *
 * Provides multi-turn planning interviews:
 * - LLM decides what questions to ask based on plan type
 * - Multi-turn conversation tracking
 * - Plan verification and approval
 * - Calendar-ready JSON output
 */

import { v } from "convex/values";
import { query, mutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

// ============================================================================
// Types
// ============================================================================

export type PlanningPhase = "gathering" | "verifying" | "approved" | "cancelled";

export interface ConversationExchange {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

// ============================================================================
// Queries
// ============================================================================

export const getSession = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("planningSessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .first();

    if (!session) return null;

    return {
      sessionId: session.sessionId,
      userQuery: session.userQuery,
      conversationHistory: JSON.parse(session.conversationHistory),
      phase: session.phase,
      draftPlan: session.draftPlan,
      finalJsonPlan: session.finalJsonPlan,
    };
  },
});

export const getActiveSessions = query({
  args: {},
  handler: async (ctx) => {
    const gathering = await ctx.db
      .query("planningSessions")
      .withIndex("by_phase", (q) => q.eq("phase", "gathering"))
      .collect();

    const verifying = await ctx.db
      .query("planningSessions")
      .withIndex("by_phase", (q) => q.eq("phase", "verifying"))
      .collect();

    return [...gathering, ...verifying].map((s) => ({
      sessionId: s.sessionId,
      userQuery: s.userQuery,
      phase: s.phase,
      createdAt: s.createdAt,
    }));
  },
});

export const getPlans = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let plans;
    if (args.status) {
      plans = await ctx.db
        .query("plans")
        .withIndex("by_status", (q) =>
          q.eq("status", args.status as "active" | "completed" | "paused")
        )
        .collect();
    } else {
      plans = await ctx.db.query("plans").collect();
    }

    return plans.map((p) => ({
      id: p._id,
      planId: p.planId,
      title: p.title,
      topic: p.topic,
      startDate: p.startDate,
      endDate: p.endDate,
      status: p.status,
      progressPercentage: p.progressPercentage,
    }));
  },
});

export const getPlanWithItems = query({
  args: { planId: v.id("plans") },
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan) return null;

    const items = await ctx.db
      .query("planItems")
      .withIndex("by_plan", (q) => q.eq("planId", args.planId))
      .collect();

    return {
      ...plan,
      items: items.map((i) => ({
        id: i._id,
        date: i.date,
        task: i.task,
        durationMinutes: i.durationMinutes,
        completed: i.completed,
        completedAt: i.completedAt,
      })),
    };
  },
});

// ============================================================================
// Mutations
// ============================================================================

function generateSessionId(): string {
  return `plan_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function generatePlanId(): string {
  return `p_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export const createSession = mutation({
  args: { userQuery: v.string() },
  handler: async (ctx, args) => {
    const sessionId = generateSessionId();
    const history: ConversationExchange[] = [
      { role: "user", content: args.userQuery, timestamp: Date.now() },
    ];

    await ctx.db.insert("planningSessions", {
      sessionId,
      userQuery: args.userQuery,
      conversationHistory: JSON.stringify(history),
      phase: "gathering",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return sessionId;
  },
});

export const updateSession = mutation({
  args: {
    sessionId: v.string(),
    conversationHistory: v.string(),
    phase: v.optional(
      v.union(
        v.literal("gathering"),
        v.literal("verifying"),
        v.literal("approved"),
        v.literal("cancelled")
      )
    ),
    draftPlan: v.optional(v.string()),
    finalJsonPlan: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("planningSessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .first();

    if (!session) return null;

    const updates: Record<string, unknown> = {
      conversationHistory: args.conversationHistory,
      updatedAt: Date.now(),
    };

    if (args.phase) updates.phase = args.phase;
    if (args.draftPlan !== undefined) updates.draftPlan = args.draftPlan;
    if (args.finalJsonPlan !== undefined) updates.finalJsonPlan = args.finalJsonPlan;

    await ctx.db.patch(session._id, updates);
    return session._id;
  },
});

export const createPlan = mutation({
  args: {
    title: v.string(),
    topic: v.string(),
    startDate: v.string(),
    endDate: v.string(),
    items: v.array(
      v.object({
        date: v.string(),
        task: v.string(),
        durationMinutes: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const planId = generatePlanId();

    const planDocId = await ctx.db.insert("plans", {
      planId,
      title: args.title,
      topic: args.topic,
      startDate: args.startDate,
      endDate: args.endDate,
      status: "active",
      progressPercentage: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    for (const item of args.items) {
      await ctx.db.insert("planItems", {
        planId: planDocId,
        date: item.date,
        task: item.task,
        durationMinutes: item.durationMinutes,
        completed: false,
      });
    }

    return planDocId;
  },
});

export const completePlanItem = mutation({
  args: { itemId: v.id("planItems") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) return null;

    await ctx.db.patch(args.itemId, {
      completed: true,
      completedAt: Date.now(),
    });

    // Update plan progress
    const allItems = await ctx.db
      .query("planItems")
      .withIndex("by_plan", (q) => q.eq("planId", item.planId))
      .collect();

    const completedCount = allItems.filter(
      (i) => i.completed || i._id === args.itemId
    ).length;
    const progress = Math.round((completedCount / allItems.length) * 100);

    await ctx.db.patch(item.planId, {
      progressPercentage: progress,
      status: progress === 100 ? "completed" : "active",
      updatedAt: Date.now(),
    });

    return args.itemId;
  },
});

export const updatePlanStatus = mutation({
  args: {
    planId: v.id("plans"),
    status: v.union(
      v.literal("active"),
      v.literal("completed"),
      v.literal("paused")
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.planId, {
      status: args.status,
      updatedAt: Date.now(),
    });
    return args.planId;
  },
});

// ============================================================================
// LLM-Based Planning Interview
// Python: core/planning_interview.py
// ============================================================================

const MAX_PLAN_DAYS = 60;

/**
 * Start a planning interview with LLM
 * Python: planning_interview.py start_interview()
 */
export const startInterviewWithLLM = internalAction({
  args: {
    sessionId: v.string(),
    userQuery: v.string(),
    openaiApiKey: v.string(),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const model = args.model ?? "gpt-4o-mini";

    const prompt = `You are a planning assistant helping a user create a structured, actionable plan. The user has requested:

"${args.userQuery}"

CONTEXT: Your goal is to gather the necessary information to create a day-by-day plan that will be loaded into a calendar interface the user can follow. The plan will show specific tasks/activities for each date.

YOUR TASK:
1. Analyze what type of plan the user wants (fitness, learning, project, habit-building, etc.)
2. Determine what information you need to create an effective plan:
   - Timeline/duration
   - Frequency (daily, weekly, specific days)
   - Intensity/difficulty level
   - Any constraints (schedule, resources, experience level)
   - Specific goals or milestones
3. Ask the user clear, focused questions to gather this information

IMPORTANT CONSTRAINTS:
- Plans should be reasonable in scope (ideally within ${MAX_PLAN_DAYS} days)
- Be conversational and friendly, not robotic
- Ask 2-4 questions at a time, don't overwhelm the user
- If the user's request is clear enough, you can suggest starting with sensible defaults

CRITICAL: You must include a delimiter in your response:
- If you have ENOUGH information from the initial request to create the plan, include: [PLAN_READY:TRUE]
- If you need MORE information, include: [PLAN_READY:FALSE]

The delimiter will be removed before showing your response to the user.`;

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are a helpful planning assistant." },
            { role: "user", content: prompt },
          ],
          max_tokens: 500,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        return { success: false, error: `API error: ${response.status}` };
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content ?? "";

      // Check if plan is ready
      const planReady = content.toUpperCase().includes("[PLAN_READY:TRUE]");

      // Strip delimiters
      const cleanedContent = content
        .replace(/\[PLAN_READY:(TRUE|FALSE)\]/gi, "")
        .replace(/\n\s*\n\s*\n/g, "\n\n")
        .trim();

      return {
        success: true,
        response: cleanedContent,
        planReady,
        phase: planReady ? "verifying" : "gathering",
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

/**
 * Process user response during planning interview
 * Python: planning_interview.py process_user_response()
 */
export const processInterviewResponse = internalAction({
  args: {
    sessionId: v.string(),
    userResponse: v.string(),
    conversationHistory: v.string(), // JSON stringified
    currentPhase: v.string(),
    openaiApiKey: v.string(),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const model = args.model ?? "gpt-4o-mini";
    const history = JSON.parse(args.conversationHistory);

    // Check for approval/cancellation in verification phase
    if (args.currentPhase === "verifying") {
      const responseLower = args.userResponse.toLowerCase().trim();

      const approvalKeywords = ["looks good", "approve", "approved", "yes", "perfect", "great", "sounds good"];
      const cancelKeywords = ["nevermind", "cancel", "cancelled", "start over", "forget it", "drop"];

      if (approvalKeywords.some((k) => responseLower.includes(k))) {
        return {
          success: true,
          phase: "approved",
          response: "Perfect! I'll format this plan for your calendar.",
          shouldGenerateJson: true,
        };
      }

      if (cancelKeywords.some((k) => responseLower.includes(k))) {
        return {
          success: true,
          phase: "cancelled",
          response: "No problem! I've cancelled this plan. Let me know if you want to create a different plan.",
          shouldGenerateJson: false,
        };
      }
    }

    // Build conversation for LLM
    const messages = [
      {
        role: "system" as const,
        content: `You are a planning assistant helping create a structured plan. 
Current phase: ${args.currentPhase}

If gathering info: Ask clarifying questions. Include [PLAN_READY:TRUE] when you have enough info, or [PLAN_READY:FALSE] if you need more.
If verifying: User is reviewing a draft plan. Help them refine it.`,
      },
      ...history.map((h: any) => ({ role: h.role as "user" | "assistant", content: h.content })),
      { role: "user" as const, content: args.userResponse },
    ];

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 1000,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        return { success: false, error: `API error: ${response.status}` };
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content ?? "";

      const planReady = content.toUpperCase().includes("[PLAN_READY:TRUE]");
      const cleanedContent = content
        .replace(/\[PLAN_READY:(TRUE|FALSE)\]/gi, "")
        .replace(/\n\s*\n\s*\n/g, "\n\n")
        .trim();

      let newPhase = args.currentPhase;
      if (planReady && args.currentPhase === "gathering") {
        newPhase = "verifying";
      }

      return {
        success: true,
        response: cleanedContent,
        phase: newPhase,
        planReady,
        shouldGenerateJson: false,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

/**
 * Generate JSON plan for calendar integration
 * Python: planning_interview.py _finalize_plan()
 */
export const generatePlanJson = internalAction({
  args: {
    sessionId: v.string(),
    conversationHistory: v.string(),
    openaiApiKey: v.string(),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const model = args.model ?? "gpt-4o-mini";
    const history = JSON.parse(args.conversationHistory);

    const prompt = `Based on the planning conversation below, create a structured JSON plan.

Conversation:
${history.map((h: any) => `${h.role}: ${h.content}`).join("\n\n")}

Create a JSON object with this structure:
{
  "title": "Plan title",
  "topic": "Category (fitness, learning, project, etc.)",
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "days": [
    {
      "date": "YYYY-MM-DD",
      "tasks": [
        {"task": "Task description", "duration_minutes": 30}
      ]
    }
  ]
}

Return ONLY valid JSON, no other text.`;

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are a JSON plan generator. Return only valid JSON." },
            { role: "user", content: prompt },
          ],
          max_tokens: 4000,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        return { success: false, error: `API error: ${response.status}` };
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content ?? "{}";

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { success: false, error: "No JSON in response" };
      }

      const plan = JSON.parse(jsonMatch[0]);

      return {
        success: true,
        plan: {
          title: plan.title,
          topic: plan.topic,
          startDate: plan.start_date,
          endDate: plan.end_date,
          items: plan.days?.flatMap((d: any) =>
            d.tasks?.map((t: any) => ({
              date: d.date,
              task: t.task,
              durationMinutes: t.duration_minutes || 30,
            })) ?? []
          ) ?? [],
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});
