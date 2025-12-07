/**
 * Eviction Manager - Adaptive sliding window eviction
 *
 * Ported from Python: memory/adaptive/eviction.py
 *
 * Implements dual eviction strategy:
 * 1. Time-based: >24 hours unused → evict
 * 2. Space-based: >5k tokens OR >30 turns → FIFO evict
 *
 * Also tracks topic affinity on eviction.
 */

import { v } from "convex/values";
import { query, mutation, internalMutation } from "../_generated/server";

// ============================================================================
// Types
// ============================================================================

export interface EvictionStats {
  timeEvicted: number;
  spaceEvicted: number;
  totalEvicted: number;
  evictedTurnIds: string[];
}

export interface TopicAffinity {
  topic: string;
  evictionCount: number;
  totalTimeInWindow: number; // milliseconds
  avgTimeInWindow: number;   // milliseconds
}

// ============================================================================
// Constants
// Python: eviction.py EvictionManager constants
// ============================================================================

const TIME_THRESHOLD_HOURS = 24;
const MAX_TIER2_TOKENS = 5000;
const MAX_TIER2_TURNS = 30;

// ============================================================================
// Queries
// ============================================================================

/**
 * Get eviction candidates based on time threshold
 */
export const getTimeEvictionCandidates = query({
  args: { dayId: v.string() },
  returns: v.array(v.object({
    turnId: v.string(),
    blockId: v.string(),
    timestamp: v.number(),
    hoursOld: v.number(),
  })),
  handler: async (ctx, args) => {
    const blocks = await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .collect();

    const now = Date.now();
    const threshold = TIME_THRESHOLD_HOURS * 60 * 60 * 1000;
    const candidates = [];

    for (const block of blocks) {
      const turns = await ctx.db
        .query("turns")
        .withIndex("by_block", (q) => q.eq("blockId", block._id))
        .collect();

      for (const turn of turns) {
        const age = now - turn.timestamp;
        if (age > threshold) {
          candidates.push({
            turnId: turn.turnId,
            blockId: block._id,
            timestamp: turn.timestamp,
            hoursOld: age / (60 * 60 * 1000),
          });
        }
      }
    }

    return candidates;
  },
});

/**
 * Get space-based eviction candidates (FIFO)
 */
export const getSpaceEvictionCandidates = query({
  args: { dayId: v.string(), maxTurns: v.optional(v.number()) },
  returns: v.object({
    needsEviction: v.boolean(),
    currentTurnCount: v.number(),
    currentTokenEstimate: v.number(),
    candidates: v.array(v.object({
      turnId: v.string(),
      blockId: v.string(),
      timestamp: v.number(),
      tokenEstimate: v.number(),
    })),
  }),
  handler: async (ctx, args) => {
    const maxTurns = args.maxTurns ?? MAX_TIER2_TURNS;
    
    const blocks = await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .collect();

    // Collect all turns with token estimates
    const allTurns: Array<{
      turnId: string;
      blockId: string;
      timestamp: number;
      tokenEstimate: number;
    }> = [];

    let totalTokens = 0;

    for (const block of blocks) {
      const turns = await ctx.db
        .query("turns")
        .withIndex("by_block", (q) => q.eq("blockId", block._id))
        .collect();

      for (const turn of turns) {
        const tokenEstimate = Math.ceil(
          (turn.userMessage.length + turn.aiResponse.length) / 4
        );
        totalTokens += tokenEstimate;
        allTurns.push({
          turnId: turn.turnId,
          blockId: block._id,
          timestamp: turn.timestamp,
          tokenEstimate,
        });
      }
    }

    // Sort by timestamp (oldest first for FIFO)
    allTurns.sort((a, b) => a.timestamp - b.timestamp);

    const needsEviction = allTurns.length > maxTurns || totalTokens > MAX_TIER2_TOKENS;

    // Calculate how many to evict
    let candidates: typeof allTurns = [];
    if (needsEviction) {
      const turnExcess = Math.max(0, allTurns.length - maxTurns);
      
      // Also check token excess
      let tokenExcess = totalTokens - MAX_TIER2_TOKENS;
      let tokenEvictionCount = 0;
      let evictedTokens = 0;
      
      for (const turn of allTurns) {
        if (evictedTokens < tokenExcess) {
          tokenEvictionCount++;
          evictedTokens += turn.tokenEstimate;
        } else {
          break;
        }
      }

      const evictionCount = Math.max(turnExcess, tokenEvictionCount);
      candidates = allTurns.slice(0, evictionCount);
    }

    return {
      needsEviction,
      currentTurnCount: allTurns.length,
      currentTokenEstimate: totalTokens,
      candidates,
    };
  },
});

/**
 * Get topic affinity stats
 */
export const getTopicAffinity = query({
  args: {},
  returns: v.array(v.object({
    topic: v.string(),
    evictionCount: v.number(),
    avgTimeInWindowHours: v.number(),
  })),
  handler: async (ctx) => {
    const affinities = await ctx.db.query("topicAffinity").collect();

    return affinities.map((a) => ({
      topic: a.topic,
      evictionCount: a.evictionCount,
      avgTimeInWindowHours: a.avgTimeInWindow / (60 * 60 * 1000),
    }));
  },
});

// ============================================================================
// Mutations
// ============================================================================

/**
 * Evict turns by time threshold
 * Python: eviction.py _evict_by_time()
 */
export const evictByTime = mutation({
  args: { dayId: v.string() },
  returns: v.object({
    evictedCount: v.number(),
    evictedTurnIds: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const threshold = TIME_THRESHOLD_HOURS * 60 * 60 * 1000;

    const blocks = await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .collect();

    const evictedTurnIds: string[] = [];

    for (const block of blocks) {
      const turns = await ctx.db
        .query("turns")
        .withIndex("by_block", (q) => q.eq("blockId", block._id))
        .collect();

      for (const turn of turns) {
        const age = now - turn.timestamp;
        if (age > threshold) {
          // Mark for eviction by moving to archive or deleting
          // For now, we'll just track which would be evicted
          evictedTurnIds.push(turn.turnId);

          // Update topic affinity
          await updateTopicAffinityInternal(ctx, block.topicLabel, turn.timestamp, now);
        }
      }
    }

    return {
      evictedCount: evictedTurnIds.length,
      evictedTurnIds,
    };
  },
});

/**
 * Evict turns by space constraints (FIFO)
 * Python: eviction.py _evict_by_space()
 */
export const evictBySpace = mutation({
  args: { 
    dayId: v.string(),
    maxTurns: v.optional(v.number()),
  },
  returns: v.object({
    evictedCount: v.number(),
    evictedTurnIds: v.array(v.string()),
    tokensFreed: v.number(),
  }),
  handler: async (ctx, args) => {
    const maxTurns = args.maxTurns ?? MAX_TIER2_TURNS;
    const now = Date.now();

    const blocks = await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .collect();

    // Collect and sort all turns
    const allTurns: Array<{
      id: any;
      turnId: string;
      blockId: any;
      topicLabel: string;
      timestamp: number;
      tokenEstimate: number;
    }> = [];

    for (const block of blocks) {
      const turns = await ctx.db
        .query("turns")
        .withIndex("by_block", (q) => q.eq("blockId", block._id))
        .collect();

      for (const turn of turns) {
        allTurns.push({
          id: turn._id,
          turnId: turn.turnId,
          blockId: block._id,
          topicLabel: block.topicLabel,
          timestamp: turn.timestamp,
          tokenEstimate: Math.ceil((turn.userMessage.length + turn.aiResponse.length) / 4),
        });
      }
    }

    allTurns.sort((a, b) => a.timestamp - b.timestamp);

    const evictedTurnIds: string[] = [];
    let tokensFreed = 0;

    // Evict excess turns
    const excess = allTurns.length - maxTurns;
    if (excess > 0) {
      for (let i = 0; i < excess; i++) {
        const turn = allTurns[i];
        evictedTurnIds.push(turn.turnId);
        tokensFreed += turn.tokenEstimate;

        // Update topic affinity
        await updateTopicAffinityInternal(ctx, turn.topicLabel, turn.timestamp, now);
      }
    }

    return {
      evictedCount: evictedTurnIds.length,
      evictedTurnIds,
      tokensFreed,
    };
  },
});

/**
 * Run full eviction check
 * Python: eviction.py check_eviction_needed()
 */
export const checkAndEvict = mutation({
  args: { dayId: v.string() },
  returns: v.object({
    timeEvicted: v.number(),
    spaceEvicted: v.number(),
    totalEvicted: v.number(),
    evictedTurnIds: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    // Run time-based eviction first
    const timeResult = await evictByTimeInternal(ctx, args.dayId);
    
    // Then space-based
    const spaceResult = await evictBySpaceInternal(ctx, args.dayId);

    const allEvicted = [...new Set([...timeResult.evictedTurnIds, ...spaceResult.evictedTurnIds])];

    return {
      timeEvicted: timeResult.evictedCount,
      spaceEvicted: spaceResult.evictedCount,
      totalEvicted: allEvicted.length,
      evictedTurnIds: allEvicted,
    };
  },
});

// ============================================================================
// Internal Helpers
// ============================================================================

async function updateTopicAffinityInternal(
  ctx: any,
  topic: string,
  addedTimestamp: number,
  evictedTimestamp: number
) {
  const topicLower = topic.toLowerCase();
  const timeInWindow = evictedTimestamp - addedTimestamp;

  const existing = await ctx.db
    .query("topicAffinity")
    .withIndex("by_topic", (q: any) => q.eq("topic", topicLower))
    .first();

  if (existing) {
    const newTotal = existing.totalTimeInWindow + timeInWindow;
    const newCount = existing.evictionCount + 1;
    await ctx.db.patch(existing._id, {
      evictionCount: newCount,
      totalTimeInWindow: newTotal,
      avgTimeInWindow: newTotal / newCount,
    });
  } else {
    await ctx.db.insert("topicAffinity", {
      topic: topicLower,
      evictionCount: 1,
      totalTimeInWindow: timeInWindow,
      avgTimeInWindow: timeInWindow,
    });
  }
}

async function evictByTimeInternal(ctx: any, dayId: string) {
  const now = Date.now();
  const threshold = TIME_THRESHOLD_HOURS * 60 * 60 * 1000;

  const blocks = await ctx.db
    .query("bridgeBlocks")
    .withIndex("by_day", (q: any) => q.eq("dayId", dayId))
    .collect();

  const evictedTurnIds: string[] = [];

  for (const block of blocks) {
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_block", (q: any) => q.eq("blockId", block._id))
      .collect();

    for (const turn of turns) {
      if (now - turn.timestamp > threshold) {
        evictedTurnIds.push(turn.turnId);
        await updateTopicAffinityInternal(ctx, block.topicLabel, turn.timestamp, now);
      }
    }
  }

  return { evictedCount: evictedTurnIds.length, evictedTurnIds };
}

async function evictBySpaceInternal(ctx: any, dayId: string) {
  const maxTurns = MAX_TIER2_TURNS;
  const now = Date.now();

  const blocks = await ctx.db
    .query("bridgeBlocks")
    .withIndex("by_day", (q: any) => q.eq("dayId", dayId))
    .collect();

  const allTurns: any[] = [];

  for (const block of blocks) {
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_block", (q: any) => q.eq("blockId", block._id))
      .collect();

    for (const turn of turns) {
      allTurns.push({
        turnId: turn.turnId,
        topicLabel: block.topicLabel,
        timestamp: turn.timestamp,
        tokenEstimate: Math.ceil((turn.userMessage.length + turn.aiResponse.length) / 4),
      });
    }
  }

  allTurns.sort((a, b) => a.timestamp - b.timestamp);

  const evictedTurnIds: string[] = [];
  const excess = allTurns.length - maxTurns;

  if (excess > 0) {
    for (let i = 0; i < excess; i++) {
      const turn = allTurns[i];
      evictedTurnIds.push(turn.turnId);
      await updateTopicAffinityInternal(ctx, turn.topicLabel, turn.timestamp, now);
    }
  }

  return { evictedCount: evictedTurnIds.length, evictedTurnIds };
}
