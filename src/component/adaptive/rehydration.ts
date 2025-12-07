/**
 * Rehydration Manager - Pull compressed turns back to verbatim
 *
 * Ported from Python: memory/adaptive/rehydration.py
 *
 * Implements context expansion when user references past conversation:
 * - Tier 2 → Tier 1 promotion (compressed → verbatim)
 * - Referenced context expansion
 * - Smart prefetch based on topic affinity
 */

import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "../_generated/server";

// ============================================================================
// Types
// ============================================================================

export interface RehydrationRequest {
  turnIds: string[];
  reason: "explicit_reference" | "topic_continuation" | "prefetch";
}

export interface RehydrationResult {
  rehydratedCount: number;
  turns: Array<{
    turnId: string;
    userMessage: string;
    aiResponse: string;
    blockId: string;
    topicLabel: string;
  }>;
  tokenEstimate: number;
}

// ============================================================================
// Constants
// Python: rehydration.py RehydrationManager constants
// ============================================================================

const MAX_REHYDRATION_TURNS = 10;
const PREFETCH_WINDOW = 3; // Turns before/after referenced turn

// ============================================================================
// Queries
// ============================================================================

/**
 * Get turns that can be rehydrated for a given topic
 */
export const getRehydrationCandidates = query({
  args: {
    topicKeywords: v.array(v.string()),
    excludeBlockId: v.optional(v.id("bridgeBlocks")),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.object({
    turnId: v.string(),
    blockId: v.string(),
    topicLabel: v.string(),
    keywordMatches: v.number(),
    timestamp: v.number(),
  })),
  handler: async (ctx, args) => {
    const limit = args.limit ?? MAX_REHYDRATION_TURNS;
    const keywordSet = new Set(args.topicKeywords.map((k) => k.toLowerCase()));

    // Get all blocks (excluding current if specified)
    let blocks = await ctx.db.query("bridgeBlocks").collect();
    if (args.excludeBlockId) {
      blocks = blocks.filter((b) => b._id !== args.excludeBlockId);
    }

    const candidates: Array<{
      turnId: string;
      blockId: string;
      topicLabel: string;
      keywordMatches: number;
      timestamp: number;
    }> = [];

    for (const block of blocks) {
      // Check keyword overlap with block
      const blockKeywords = new Set(block.keywords.map((k: string) => k.toLowerCase()));
      let blockMatches = 0;
      for (const kw of keywordSet) {
        if (blockKeywords.has(kw)) {
          blockMatches++;
        }
      }

      if (blockMatches > 0) {
        // Get turns from this block
        const turns = await ctx.db
          .query("turns")
          .withIndex("by_block", (q) => q.eq("blockId", block._id))
          .collect();

        for (const turn of turns) {
          // Calculate keyword matches for this turn
          const turnText = `${turn.userMessage} ${turn.aiResponse}`.toLowerCase();
          let turnMatches = 0;
          for (const kw of keywordSet) {
            if (turnText.includes(kw)) {
              turnMatches++;
            }
          }

          if (turnMatches > 0) {
            candidates.push({
              turnId: turn.turnId,
              blockId: block._id,
              topicLabel: block.topicLabel,
              keywordMatches: turnMatches + blockMatches,
              timestamp: turn.timestamp,
            });
          }
        }
      }
    }

    // Sort by keyword matches (descending) then recency
    candidates.sort((a, b) => {
      if (b.keywordMatches !== a.keywordMatches) {
        return b.keywordMatches - a.keywordMatches;
      }
      return b.timestamp - a.timestamp;
    });

    return candidates.slice(0, limit);
  },
});

/**
 * Get context window for a specific turn (prefetch surrounding turns)
 */
export const getTurnContext = query({
  args: {
    turnId: v.string(),
    windowSize: v.optional(v.number()),
  },
  returns: v.object({
    before: v.array(v.object({
      turnId: v.string(),
      userMessage: v.string(),
      aiResponse: v.string(),
      timestamp: v.number(),
    })),
    target: v.union(v.null(), v.object({
      turnId: v.string(),
      userMessage: v.string(),
      aiResponse: v.string(),
      timestamp: v.number(),
      blockId: v.string(),
    })),
    after: v.array(v.object({
      turnId: v.string(),
      userMessage: v.string(),
      aiResponse: v.string(),
      timestamp: v.number(),
    })),
  }),
  handler: async (ctx, args) => {
    const windowSize = args.windowSize ?? PREFETCH_WINDOW;

    // Find the target turn
    const targetTurn = await ctx.db
      .query("turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .first();

    if (!targetTurn) {
      return { before: [], target: null, after: [] };
    }

    // Get all turns from the same block
    const blockTurns = await ctx.db
      .query("turns")
      .withIndex("by_block", (q) => q.eq("blockId", targetTurn.blockId))
      .order("asc")
      .collect();

    // Find target index
    const targetIndex = blockTurns.findIndex((t) => t.turnId === args.turnId);
    if (targetIndex === -1) {
      return { before: [], target: null, after: [] };
    }

    // Get surrounding context
    const beforeStart = Math.max(0, targetIndex - windowSize);
    const afterEnd = Math.min(blockTurns.length, targetIndex + windowSize + 1);

    const before = blockTurns.slice(beforeStart, targetIndex).map((t) => ({
      turnId: t.turnId,
      userMessage: t.userMessage,
      aiResponse: t.aiResponse,
      timestamp: t.timestamp,
    }));

    const after = blockTurns.slice(targetIndex + 1, afterEnd).map((t) => ({
      turnId: t.turnId,
      userMessage: t.userMessage,
      aiResponse: t.aiResponse,
      timestamp: t.timestamp,
    }));

    return {
      before,
      target: {
        turnId: targetTurn.turnId,
        userMessage: targetTurn.userMessage,
        aiResponse: targetTurn.aiResponse,
        timestamp: targetTurn.timestamp,
        blockId: targetTurn.blockId,
      },
      after,
    };
  },
});

// ============================================================================
// Mutations
// ============================================================================

/**
 * Mark turns as rehydrated (for tracking)
 */
export const markRehydrated = mutation({
  args: {
    turnIds: v.array(v.string()),
    reason: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const now = Date.now();
    let count = 0;

    for (const turnId of args.turnIds) {
      // Update usage stats
      const existing = await ctx.db
        .query("usageStats")
        .withIndex("by_itemId", (q) => q.eq("itemId", turnId))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          usageCount: existing.usageCount + 1,
          lastUsed: now,
        });
      } else {
        await ctx.db.insert("usageStats", {
          itemId: turnId,
          itemType: "turn",
          usageCount: 1,
          lastUsed: now,
          firstUsed: now,
          topics: [],
        });
      }
      count++;
    }

    return count;
  },
});

// ============================================================================
// Combined Mutations (for simpler execution without action overhead)
// ============================================================================

/**
 * Rehydrate turns based on explicit reference
 * Python: rehydration.py RehydrationManager.rehydrate_referenced()
 */
export const rehydrateReferenced = mutation({
  args: {
    referenceKeywords: v.array(v.string()),
    currentBlockId: v.id("bridgeBlocks"),
    maxTurns: v.optional(v.number()),
  },
  returns: v.object({
    rehydratedCount: v.number(),
    turns: v.array(v.object({
      turnId: v.string(),
      userMessage: v.string(),
      aiResponse: v.string(),
      blockId: v.string(),
      topicLabel: v.string(),
    })),
    tokenEstimate: v.number(),
  }),
  handler: async (ctx, args) => {
    const maxTurns = args.maxTurns ?? MAX_REHYDRATION_TURNS;
    const keywordSet = new Set(args.referenceKeywords.map((k) => k.toLowerCase()));

    // Get all blocks except current
    let blocks = await ctx.db.query("bridgeBlocks").collect();
    blocks = blocks.filter((b) => b._id !== args.currentBlockId);

    // Find matching candidates
    const candidates: Array<{
      turnId: string;
      blockId: any;
      topicLabel: string;
      keywordMatches: number;
      timestamp: number;
    }> = [];

    for (const block of blocks) {
      const blockKeywords = new Set(block.keywords.map((k: string) => k.toLowerCase()));
      let blockMatches = 0;
      for (const kw of keywordSet) {
        if (blockKeywords.has(kw)) blockMatches++;
      }

      if (blockMatches > 0) {
        const turns = await ctx.db
          .query("turns")
          .withIndex("by_block", (q) => q.eq("blockId", block._id))
          .collect();

        for (const turn of turns) {
          const turnText = `${turn.userMessage} ${turn.aiResponse}`.toLowerCase();
          let turnMatches = 0;
          for (const kw of keywordSet) {
            if (turnText.includes(kw)) turnMatches++;
          }

          if (turnMatches > 0) {
            candidates.push({
              turnId: turn.turnId,
              blockId: block._id,
              topicLabel: block.topicLabel,
              keywordMatches: turnMatches + blockMatches,
              timestamp: turn.timestamp,
            });
          }
        }
      }
    }

    // Sort and limit
    candidates.sort((a, b) => {
      if (b.keywordMatches !== a.keywordMatches) return b.keywordMatches - a.keywordMatches;
      return b.timestamp - a.timestamp;
    });

    const selectedCandidates = candidates.slice(0, maxTurns);

    // Fetch full turn data
    const turns: Array<{
      turnId: string;
      userMessage: string;
      aiResponse: string;
      blockId: string;
      topicLabel: string;
    }> = [];

    let tokenEstimate = 0;
    const now = Date.now();

    for (const candidate of selectedCandidates) {
      const turn = await ctx.db
        .query("turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", candidate.turnId))
        .first();

      if (turn) {
        turns.push({
          turnId: turn.turnId,
          userMessage: turn.userMessage,
          aiResponse: turn.aiResponse,
          blockId: candidate.blockId,
          topicLabel: candidate.topicLabel,
        });

        tokenEstimate += Math.ceil((turn.userMessage.length + turn.aiResponse.length) / 4);

        // Update usage stats
        const existing = await ctx.db
          .query("usageStats")
          .withIndex("by_itemId", (q) => q.eq("itemId", turn.turnId))
          .first();

        if (existing) {
          await ctx.db.patch(existing._id, { usageCount: existing.usageCount + 1, lastUsed: now });
        } else {
          await ctx.db.insert("usageStats", {
            itemId: turn.turnId,
            itemType: "turn",
            usageCount: 1,
            lastUsed: now,
            firstUsed: now,
            topics: [],
          });
        }
      }
    }

    return { rehydratedCount: turns.length, turns, tokenEstimate };
  },
});

/**
 * Prefetch turns based on topic affinity
 * Python: rehydration.py RehydrationManager.prefetch_by_affinity()
 */
export const prefetchByAffinity = mutation({
  args: {
    currentTopic: v.string(),
    currentBlockId: v.id("bridgeBlocks"),
    maxTurns: v.optional(v.number()),
  },
  returns: v.object({
    prefetchedCount: v.number(),
    turnIds: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const maxTurns = args.maxTurns ?? 5;

    const topicKeywords = args.currentTopic
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);

    const keywordSet = new Set(topicKeywords);

    // Get all blocks except current
    let blocks = await ctx.db.query("bridgeBlocks").collect();
    blocks = blocks.filter((b) => b._id !== args.currentBlockId);

    const candidates: Array<{ turnId: string; score: number }> = [];

    for (const block of blocks) {
      const blockKeywords = new Set(block.keywords.map((k: string) => k.toLowerCase()));
      let blockMatches = 0;
      for (const kw of keywordSet) {
        if (blockKeywords.has(kw)) blockMatches++;
      }

      if (blockMatches > 0) {
        const turns = await ctx.db
          .query("turns")
          .withIndex("by_block", (q) => q.eq("blockId", block._id))
          .collect();

        for (const turn of turns) {
          candidates.push({ turnId: turn.turnId, score: blockMatches });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates.slice(0, maxTurns);

    if (selected.length === 0) {
      return { prefetchedCount: 0, turnIds: [] };
    }

    // Mark as prefetched
    const now = Date.now();
    for (const c of selected) {
      const existing = await ctx.db
        .query("usageStats")
        .withIndex("by_itemId", (q) => q.eq("itemId", c.turnId))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, { usageCount: existing.usageCount + 1, lastUsed: now });
      } else {
        await ctx.db.insert("usageStats", {
          itemId: c.turnId,
          itemType: "turn",
          usageCount: 1,
          lastUsed: now,
          firstUsed: now,
          topics: [],
        });
      }
    }

    return {
      prefetchedCount: selected.length,
      turnIds: selected.map((c) => c.turnId),
    };
  },
});
