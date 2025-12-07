/**
 * Debug Logger - Turn-by-turn logging for HMLR
 *
 * Ported from Python: memory/debug_logger.py
 *
 * Saves detailed snapshots of:
 * 1. User query and intent analysis
 * 2. Retrieved context (what was hydrated)
 * 3. Sliding window contents
 * 4. Full prompt sent to LLM
 * 5. LLM response
 * 6. Governor decision
 * 7. Facts extracted
 */

import { v } from "convex/values";
import { query, mutation } from "../_generated/server";

// ============================================================================
// Types
// ============================================================================

export type DebugCategory =
  | "query"
  | "intent"
  | "context"
  | "sliding_window"
  | "prompt"
  | "response"
  | "governor"
  | "facts"
  | "error"
  | "timing";

export interface DebugLogEntry {
  turnId: string;
  category: DebugCategory;
  content: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

export interface TurnDebugSummary {
  turnId: string;
  timestamp: number;
  userQuery?: string;
  intent?: Record<string, any>;
  contextRetrieved?: string[];
  slidingWindowSize?: number;
  promptTokens?: number;
  responseTokens?: number;
  governorDecision?: Record<string, any>;
  factsExtracted?: string[];
  totalDurationMs?: number;
  errors?: string[];
}

// ============================================================================
// Mutations
// ============================================================================

export const logDebug = mutation({
  args: {
    turnId: v.string(),
    category: v.string(),
    content: v.string(),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("debugLogs", {
      turnId: args.turnId,
      category: args.category,
      content: args.content,
      metadata: args.metadata,
      timestamp: Date.now(),
    });
  },
});

export const logQuery = mutation({
  args: {
    turnId: v.string(),
    userQuery: v.string(),
    keywords: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("debugLogs", {
      turnId: args.turnId,
      category: "query",
      content: args.userQuery,
      metadata: args.keywords ? JSON.stringify({ keywords: args.keywords }) : undefined,
      timestamp: Date.now(),
    });
  },
});

export const logIntent = mutation({
  args: {
    turnId: v.string(),
    intent: v.object({
      queryType: v.string(),
      keywords: v.array(v.string()),
      confidence: v.number(),
      topics: v.optional(v.array(v.string())),
    }),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("debugLogs", {
      turnId: args.turnId,
      category: "intent",
      content: `Type: ${args.intent.queryType}, Confidence: ${args.intent.confidence}`,
      metadata: JSON.stringify(args.intent),
      timestamp: Date.now(),
    });
  },
});

export const logContext = mutation({
  args: {
    turnId: v.string(),
    retrievedItems: v.array(v.string()),
    totalTokens: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("debugLogs", {
      turnId: args.turnId,
      category: "context",
      content: `Retrieved ${args.retrievedItems.length} items`,
      metadata: JSON.stringify({
        items: args.retrievedItems,
        totalTokens: args.totalTokens,
      }),
      timestamp: Date.now(),
    });
  },
});

export const logSlidingWindow = mutation({
  args: {
    turnId: v.string(),
    windowSize: v.number(),
    oldestTimestamp: v.optional(v.number()),
    newestTimestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("debugLogs", {
      turnId: args.turnId,
      category: "sliding_window",
      content: `Window size: ${args.windowSize} turns`,
      metadata: JSON.stringify({
        size: args.windowSize,
        oldest: args.oldestTimestamp,
        newest: args.newestTimestamp,
      }),
      timestamp: Date.now(),
    });
  },
});

export const logPrompt = mutation({
  args: {
    turnId: v.string(),
    prompt: v.string(),
    estimatedTokens: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Truncate very long prompts
    const content = args.prompt.length > 10000 
      ? args.prompt.slice(0, 10000) + "... [truncated]" 
      : args.prompt;

    return await ctx.db.insert("debugLogs", {
      turnId: args.turnId,
      category: "prompt",
      content,
      metadata: JSON.stringify({ estimatedTokens: args.estimatedTokens }),
      timestamp: Date.now(),
    });
  },
});

export const logResponse = mutation({
  args: {
    turnId: v.string(),
    response: v.string(),
    tokensUsed: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("debugLogs", {
      turnId: args.turnId,
      category: "response",
      content: args.response,
      metadata: JSON.stringify({
        tokensUsed: args.tokensUsed,
        latencyMs: args.latencyMs,
      }),
      timestamp: Date.now(),
    });
  },
});

export const logGovernor = mutation({
  args: {
    turnId: v.string(),
    decision: v.object({
      selectedBlock: v.optional(v.string()),
      createNewBlock: v.boolean(),
      confidence: v.number(),
      reasoning: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("debugLogs", {
      turnId: args.turnId,
      category: "governor",
      content: args.decision.createNewBlock
        ? "Creating new block"
        : `Routed to block: ${args.decision.selectedBlock}`,
      metadata: JSON.stringify(args.decision),
      timestamp: Date.now(),
    });
  },
});

export const logFacts = mutation({
  args: {
    turnId: v.string(),
    facts: v.array(
      v.object({
        key: v.string(),
        value: v.string(),
        category: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("debugLogs", {
      turnId: args.turnId,
      category: "facts",
      content: `Extracted ${args.facts.length} facts: ${args.facts.map((f) => f.key).join(", ")}`,
      metadata: JSON.stringify(args.facts),
      timestamp: Date.now(),
    });
  },
});

export const logError = mutation({
  args: {
    turnId: v.string(),
    error: v.string(),
    stack: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("debugLogs", {
      turnId: args.turnId,
      category: "error",
      content: args.error,
      metadata: args.stack ? JSON.stringify({ stack: args.stack }) : undefined,
      timestamp: Date.now(),
    });
  },
});

export const logTiming = mutation({
  args: {
    turnId: v.string(),
    operation: v.string(),
    durationMs: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("debugLogs", {
      turnId: args.turnId,
      category: "timing",
      content: `${args.operation}: ${args.durationMs}ms`,
      metadata: JSON.stringify({
        operation: args.operation,
        durationMs: args.durationMs,
      }),
      timestamp: Date.now(),
    });
  },
});

export const clearDebugLogs = mutation({
  args: {
    turnId: v.optional(v.string()),
    beforeTimestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let logs;

    if (args.turnId) {
      logs = await ctx.db
        .query("debugLogs")
        .withIndex("by_turn", (q) => q.eq("turnId", args.turnId))
        .collect();
    } else if (args.beforeTimestamp) {
      logs = await ctx.db
        .query("debugLogs")
        .withIndex("by_timestamp")
        .filter((q) => q.lt(q.field("timestamp"), args.beforeTimestamp!))
        .collect();
    } else {
      // Clear all (dangerous - limit to 1000)
      logs = await ctx.db.query("debugLogs").take(1000);
    }

    for (const log of logs) {
      await ctx.db.delete(log._id);
    }

    return logs.length;
  },
});

// ============================================================================
// Queries
// ============================================================================

export const getDebugLogs = query({
  args: {
    turnId: v.string(),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<DebugLogEntry[]> => {
    let query = ctx.db
      .query("debugLogs")
      .withIndex("by_turn", (q) => q.eq("turnId", args.turnId));

    const logs = await query.collect();

    const filtered = args.category
      ? logs.filter((l) => l.category === args.category)
      : logs;

    return filtered.map((l) => ({
      turnId: l.turnId,
      category: l.category as DebugCategory,
      content: l.content,
      metadata: l.metadata ? JSON.parse(l.metadata) : undefined,
      timestamp: l.timestamp,
    }));
  },
});

export const getTurnSummary = query({
  args: { turnId: v.string() },
  handler: async (ctx, args): Promise<TurnDebugSummary | null> => {
    const logs = await ctx.db
      .query("debugLogs")
      .withIndex("by_turn", (q) => q.eq("turnId", args.turnId))
      .collect();

    if (logs.length === 0) return null;

    const summary: TurnDebugSummary = {
      turnId: args.turnId,
      timestamp: logs[0].timestamp,
    };

    for (const log of logs) {
      const meta = log.metadata ? JSON.parse(log.metadata) : {};

      switch (log.category) {
        case "query":
          summary.userQuery = log.content;
          break;
        case "intent":
          summary.intent = meta;
          break;
        case "context":
          summary.contextRetrieved = meta.items;
          break;
        case "sliding_window":
          summary.slidingWindowSize = meta.size;
          break;
        case "prompt":
          summary.promptTokens = meta.estimatedTokens;
          break;
        case "response":
          summary.responseTokens = meta.tokensUsed;
          break;
        case "governor":
          summary.governorDecision = meta;
          break;
        case "facts":
          summary.factsExtracted = meta.map?.((f: any) => f.key) || [];
          break;
        case "timing":
          if (meta.operation === "total") {
            summary.totalDurationMs = meta.durationMs;
          }
          break;
        case "error":
          if (!summary.errors) summary.errors = [];
          summary.errors.push(log.content);
          break;
      }
    }

    return summary;
  },
});

export const getRecentLogs = query({
  args: {
    limit: v.optional(v.number()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    let query = ctx.db.query("debugLogs").withIndex("by_timestamp").order("desc");

    const logs = await query.take(limit * 2); // Get extra in case we filter

    const filtered = args.category
      ? logs.filter((l) => l.category === args.category).slice(0, limit)
      : logs.slice(0, limit);

    return filtered.map((l) => ({
      turnId: l.turnId,
      category: l.category,
      content: l.content.length > 200 ? l.content.slice(0, 200) + "..." : l.content,
      timestamp: l.timestamp,
    }));
  },
});

export const getLogStats = query({
  args: {},
  handler: async (ctx) => {
    const allLogs = await ctx.db.query("debugLogs").collect();

    const categoryCount: Record<string, number> = {};
    const turnSet = new Set<string>();
    let oldestTimestamp = Infinity;
    let newestTimestamp = 0;

    for (const log of allLogs) {
      categoryCount[log.category] = (categoryCount[log.category] || 0) + 1;
      turnSet.add(log.turnId);
      if (log.timestamp < oldestTimestamp) oldestTimestamp = log.timestamp;
      if (log.timestamp > newestTimestamp) newestTimestamp = log.timestamp;
    }

    return {
      totalLogs: allLogs.length,
      uniqueTurns: turnSet.size,
      categoryBreakdown: categoryCount,
      oldestLog: oldestTimestamp === Infinity ? null : oldestTimestamp,
      newestLog: newestTimestamp === 0 ? null : newestTimestamp,
    };
  },
});
