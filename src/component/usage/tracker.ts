/**
 * Usage Tracker - Track which memories/turns get used
 *
 * Ported from Python: memory/usage/tracker.py
 *
 * Maintains statistics about which turns are actually used by the LLM:
 * - Track turn usage over time
 * - Maintain usage statistics
 * - Identify patterns (over-retrieval, under-utilization)
 * - Optimize retrieval based on usage patterns
 */

import { v } from "convex/values";
import { query, mutation } from "../_generated/server";

// ============================================================================
// Types
// ============================================================================

export interface UsageStats {
  itemId: string;
  itemType: string;
  usageCount: number;
  lastUsed: number;
  firstUsed: number;
  topics: string[];
}

export interface UsageAnalysis {
  totalItems: number;
  activeItems: number;
  unusedItems: number;
  overUtilized: string[];
  underUtilized: string[];
  avgUsageCount: number;
}

// ============================================================================
// Mutations
// ============================================================================

export const markUsed = mutation({
  args: {
    itemId: v.string(),
    itemType: v.string(),
    topics: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check if stats exist
    const existing = await ctx.db
      .query("usageStats")
      .withIndex("by_itemId", (q) => q.eq("itemId", args.itemId))
      .first();

    if (existing) {
      // Update existing stats
      const newTopics = args.topics || [];
      const mergedTopics = [...new Set([...existing.topics, ...newTopics])];

      await ctx.db.patch(existing._id, {
        usageCount: existing.usageCount + 1,
        lastUsed: now,
        topics: mergedTopics,
      });

      return existing._id;
    }

    // Create new stats
    return await ctx.db.insert("usageStats", {
      itemId: args.itemId,
      itemType: args.itemType,
      usageCount: 1,
      lastUsed: now,
      firstUsed: now,
      topics: args.topics || [],
    });
  },
});

export const markMultipleUsed = mutation({
  args: {
    items: v.array(
      v.object({
        itemId: v.string(),
        itemType: v.string(),
        topics: v.optional(v.array(v.string())),
      })
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const results: string[] = [];

    for (const item of args.items) {
      const existing = await ctx.db
        .query("usageStats")
        .withIndex("by_itemId", (q) => q.eq("itemId", item.itemId))
        .first();

      if (existing) {
        const newTopics = item.topics || [];
        const mergedTopics = [...new Set([...existing.topics, ...newTopics])];

        await ctx.db.patch(existing._id, {
          usageCount: existing.usageCount + 1,
          lastUsed: now,
          topics: mergedTopics,
        });

        results.push(existing._id as unknown as string);
      } else {
        const id = await ctx.db.insert("usageStats", {
          itemId: item.itemId,
          itemType: item.itemType,
          usageCount: 1,
          lastUsed: now,
          firstUsed: now,
          topics: item.topics || [],
        });

        results.push(id as unknown as string);
      }
    }

    return results;
  },
});

export const resetUsage = mutation({
  args: { itemId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("usageStats")
      .withIndex("by_itemId", (q) => q.eq("itemId", args.itemId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        usageCount: 0,
        topics: [],
      });
      return true;
    }

    return false;
  },
});

export const cleanupOldStats = mutation({
  args: {
    beforeTimestamp: v.number(),
    minUsageCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const minUsage = args.minUsageCount ?? 0;

    const oldStats = await ctx.db.query("usageStats").collect();

    const toDelete = oldStats.filter(
      (s) => s.lastUsed < args.beforeTimestamp && s.usageCount <= minUsage
    );

    for (const stat of toDelete) {
      await ctx.db.delete(stat._id);
    }

    return toDelete.length;
  },
});

// ============================================================================
// Queries
// ============================================================================

export const getUsage = query({
  args: { itemId: v.string() },
  handler: async (ctx, args): Promise<UsageStats | null> => {
    const stats = await ctx.db
      .query("usageStats")
      .withIndex("by_itemId", (q) => q.eq("itemId", args.itemId))
      .first();

    if (!stats) return null;

    return {
      itemId: stats.itemId,
      itemType: stats.itemType,
      usageCount: stats.usageCount,
      lastUsed: stats.lastUsed,
      firstUsed: stats.firstUsed,
      topics: stats.topics,
    };
  },
});

export const getMostUsed = query({
  args: {
    limit: v.optional(v.number()),
    itemType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    let allStats = await ctx.db
      .query("usageStats")
      .withIndex("by_usageCount")
      .order("desc")
      .collect();

    if (args.itemType) {
      allStats = allStats.filter((s) => s.itemType === args.itemType);
    }

    return allStats.slice(0, limit).map((s) => ({
      itemId: s.itemId,
      itemType: s.itemType,
      usageCount: s.usageCount,
      lastUsed: s.lastUsed,
    }));
  },
});

export const getLeastUsed = query({
  args: {
    limit: v.optional(v.number()),
    itemType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    let allStats = await ctx.db
      .query("usageStats")
      .withIndex("by_usageCount")
      .order("asc")
      .collect();

    if (args.itemType) {
      allStats = allStats.filter((s) => s.itemType === args.itemType);
    }

    return allStats.slice(0, limit).map((s) => ({
      itemId: s.itemId,
      itemType: s.itemType,
      usageCount: s.usageCount,
      lastUsed: s.lastUsed,
    }));
  },
});

export const getRecentlyUsed = query({
  args: {
    limit: v.optional(v.number()),
    sinceTimestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const since = args.sinceTimestamp ?? Date.now() - 24 * 60 * 60 * 1000; // Last 24 hours

    const allStats = await ctx.db.query("usageStats").collect();

    const recent = allStats
      .filter((s) => s.lastUsed >= since)
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, limit);

    return recent.map((s) => ({
      itemId: s.itemId,
      itemType: s.itemType,
      usageCount: s.usageCount,
      lastUsed: s.lastUsed,
    }));
  },
});

export const getUsageByTopic = query({
  args: { topic: v.string() },
  handler: async (ctx, args) => {
    const allStats = await ctx.db.query("usageStats").collect();

    const matching = allStats.filter((s) =>
      s.topics.some((t: string) => t.toLowerCase().includes(args.topic.toLowerCase()))
    );

    return matching.map((s) => ({
      itemId: s.itemId,
      itemType: s.itemType,
      usageCount: s.usageCount,
      topics: s.topics,
    }));
  },
});

export const analyzeUsage = query({
  args: {},
  handler: async (ctx): Promise<UsageAnalysis> => {
    const allStats = await ctx.db.query("usageStats").collect();

    if (allStats.length === 0) {
      return {
        totalItems: 0,
        activeItems: 0,
        unusedItems: 0,
        overUtilized: [],
        underUtilized: [],
        avgUsageCount: 0,
      };
    }

    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    // Calculate average usage
    const totalUsage = allStats.reduce((sum, s) => sum + s.usageCount, 0);
    const avgUsage = totalUsage / allStats.length;

    // Categorize items
    const activeItems = allStats.filter((s) => s.lastUsed >= oneWeekAgo);
    const unusedItems = allStats.filter((s) => s.usageCount === 0);

    // Over-utilized: > 2x average usage
    const overUtilized = allStats
      .filter((s) => s.usageCount > avgUsage * 2)
      .map((s) => s.itemId);

    // Under-utilized: < 0.5x average usage but was used recently
    const underUtilized = allStats
      .filter(
        (s) =>
          s.usageCount > 0 &&
          s.usageCount < avgUsage * 0.5 &&
          s.lastUsed >= oneWeekAgo
      )
      .map((s) => s.itemId);

    return {
      totalItems: allStats.length,
      activeItems: activeItems.length,
      unusedItems: unusedItems.length,
      overUtilized,
      underUtilized,
      avgUsageCount: Math.round(avgUsage * 100) / 100,
    };
  },
});

export const getUsageStats = query({
  args: {},
  handler: async (ctx) => {
    const allStats = await ctx.db.query("usageStats").collect();

    const byType: Record<string, number> = {};
    const byTopicCount: Record<string, number> = {};

    for (const stat of allStats) {
      byType[stat.itemType] = (byType[stat.itemType] || 0) + 1;

      for (const topic of stat.topics) {
        byTopicCount[topic] = (byTopicCount[topic] || 0) + 1;
      }
    }

    // Sort topics by count
    const topTopics = Object.entries(byTopicCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    return {
      totalTrackedItems: allStats.length,
      byType,
      topTopics: Object.fromEntries(topTopics),
      totalUsageEvents: allStats.reduce((sum, s) => sum + s.usageCount, 0),
    };
  },
});
