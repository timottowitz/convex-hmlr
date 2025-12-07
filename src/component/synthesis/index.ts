/**
 * Synthesis System - Daily/weekly pattern aggregation
 * 
 * Provides:
 * - Daily synthesis from conversation metadata
 * - Weekly aggregation and pattern analysis
 * - User profile extraction (Scribe)
 */

import { v } from "convex/values";
import { query, mutation, internalMutation } from "../_generated/server";

// ============================================================================
// Types
// ============================================================================

export interface DaySynthesisData {
  dayId: string;
  emotionalArc: string;
  keyPatterns: string[];
  topicAffectMapping: Record<string, string>;
  behavioralNotes: string;
  turnCount: number;
  blockCount: number;
}

// ============================================================================
// Day Synthesis Queries/Mutations
// ============================================================================

export const getDaySynthesis = query({
  args: { dayId: v.string() },
  handler: async (ctx, args) => {
    const synthesis = await ctx.db
      .query("daySynthesis")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .first();
    
    if (!synthesis) return null;
    
    return {
      dayId: synthesis.dayId,
      emotionalArc: synthesis.emotionalArc,
      keyPatterns: synthesis.keyPatterns,
      topicAffectMapping: JSON.parse(synthesis.topicAffectMapping),
      behavioralNotes: synthesis.behavioralNotes,
      turnCount: synthesis.turnCount,
      blockCount: synthesis.blockCount,
    };
  },
});

export const getRecentSyntheses = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 7;
    return await ctx.db.query("daySynthesis").order("desc").take(limit);
  },
});

export const saveDaySynthesis = mutation({
  args: {
    dayId: v.string(),
    emotionalArc: v.string(),
    keyPatterns: v.array(v.string()),
    topicAffectMapping: v.string(),
    behavioralNotes: v.string(),
    turnCount: v.number(),
    blockCount: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("daySynthesis")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { ...args, createdAt: Date.now() });
      return existing._id;
    }

    return await ctx.db.insert("daySynthesis", { ...args, createdAt: Date.now() });
  },
});

// ============================================================================
// Week Synthesis Queries/Mutations
// ============================================================================

export const getWeekSynthesis = query({
  args: { weekId: v.string() },
  handler: async (ctx, args) => {
    const synthesis = await ctx.db
      .query("weekSynthesis")
      .withIndex("by_week", (q) => q.eq("weekId", args.weekId))
      .first();
    
    if (!synthesis) return null;
    
    return {
      weekId: synthesis.weekId,
      emotionalPatterns: JSON.parse(synthesis.emotionalPatterns),
      topicEvolution: JSON.parse(synthesis.topicEvolution),
      productivityPatterns: JSON.parse(synthesis.productivityPatterns),
      keyInsights: synthesis.keyInsights,
    };
  },
});

export const saveWeekSynthesis = mutation({
  args: {
    weekId: v.string(),
    emotionalPatterns: v.string(),
    topicEvolution: v.string(),
    productivityPatterns: v.string(),
    keyInsights: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("weekSynthesis")
      .withIndex("by_week", (q) => q.eq("weekId", args.weekId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { ...args, createdAt: Date.now() });
      return existing._id;
    }

    return await ctx.db.insert("weekSynthesis", { ...args, createdAt: Date.now() });
  },
});

// ============================================================================
// Synthesis Context for LLM Prompts
// ============================================================================

export const getSynthesisContext = query({
  args: { maxTokens: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const maxTokens = args.maxTokens ?? 300;
    const sections: string[] = [];

    const recentSyntheses = await ctx.db
      .query("daySynthesis")
      .order("desc")
      .take(3);

    if (recentSyntheses.length > 0) {
      const latest = recentSyntheses[0];
      sections.push(`Recent: ${latest.emotionalArc}`);
      if (latest.keyPatterns.length > 0) {
        sections.push(`Patterns: ${latest.keyPatterns.slice(0, 2).join(", ")}`);
      }
    }

    const result = sections.join(" ");
    return result.length > maxTokens * 4 ? result.slice(0, maxTokens * 4) + "..." : result;
  },
});

// ============================================================================
// Scribe - User Profile Extraction
// ============================================================================

export const getUserProjects = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("userProjects").collect();
  },
});

export const getUserEntities = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("userEntities").collect();
  },
});

export const getUserConstraints = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("userConstraints").collect();
  },
});

export const upsertProject = mutation({
  args: {
    key: v.string(),
    domain: v.string(),
    description: v.string(),
    techStack: v.optional(v.array(v.string())),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userProjects")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { ...args, lastUpdated: Date.now() });
      return existing._id;
    }

    return await ctx.db.insert("userProjects", { ...args, lastUpdated: Date.now() });
  },
});

export const upsertEntity = mutation({
  args: {
    key: v.string(),
    entityType: v.string(),
    description: v.string(),
    attributes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userEntities")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { ...args, lastUpdated: Date.now() });
      return existing._id;
    }

    return await ctx.db.insert("userEntities", { ...args, lastUpdated: Date.now() });
  },
});

export const upsertConstraint = mutation({
  args: {
    key: v.string(),
    constraintType: v.string(),
    description: v.string(),
    severity: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userConstraints")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { ...args, lastUpdated: Date.now() });
      return existing._id;
    }

    return await ctx.db.insert("userConstraints", { ...args, lastUpdated: Date.now() });
  },
});

export const getProfileContext = query({
  args: { maxTokens: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const maxTokens = args.maxTokens ?? 200;
    const sections: string[] = [];

    const projects = await ctx.db.query("userProjects").take(5);
    if (projects.length > 0) {
      sections.push(`Projects: ${projects.map((p) => p.key).join(", ")}`);
    }

    const entities = await ctx.db.query("userEntities").take(5);
    const people = entities.filter((e) => e.entityType === "Person");
    if (people.length > 0) {
      sections.push(`People: ${people.map((p) => p.key).join(", ")}`);
    }

    const constraints = await ctx.db.query("userConstraints").take(5);
    const severe = constraints.filter((c) => c.severity === "severe");
    if (severe.length > 0) {
      sections.push(`Constraints: ${severe.map((c) => c.description).join("; ")}`);
    }

    const result = sections.join(". ");
    return result.length > maxTokens * 4 ? result.slice(0, maxTokens * 4) + "..." : result;
  },
});

// ============================================================================
// Day Synthesis Generation
// Python: DaySynthesizer.synthesize_day()
// ============================================================================

/**
 * Generate synthesis for a day from turns and metadata
 */
export const generateDaySynthesis = mutation({
  args: { dayId: v.string() },
  handler: async (ctx, args) => {
    // Get all blocks and turns for the day
    const blocks = await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_day", (q) => q.eq("dayId", args.dayId))
      .collect();

    if (blocks.length === 0) {
      return null;
    }

    // Get all turns for these blocks
    let allTurns: any[] = [];
    for (const block of blocks) {
      const turns = await ctx.db
        .query("turns")
        .withIndex("by_block", (q) => q.eq("blockId", block._id))
        .collect();
      allTurns = [...allTurns, ...turns];
    }

    // Analyze emotional arc from affects
    const affectCounts: Record<string, number> = {};
    for (const turn of allTurns) {
      const affect = turn.affect ?? "neutral";
      affectCounts[affect] = (affectCounts[affect] || 0) + 1;
    }
    const sortedAffects = Object.entries(affectCounts)
      .sort((a, b) => b[1] - a[1]);
    const dominantAffect = sortedAffects[0]?.[0] ?? "neutral";

    // Build emotional arc description
    const emotionalArc = allTurns.length > 5
      ? `Predominantly ${dominantAffect} mood across ${allTurns.length} exchanges.`
      : `Brief session with ${dominantAffect} tone.`;

    // Identify key patterns
    const patterns: string[] = [];
    if (allTurns.length > 10) patterns.push("Highly active conversation day");
    if (blocks.length > 3) patterns.push("Explored multiple topics");
    if (dominantAffect === "curious") patterns.push("Inquisitive and exploratory");

    // Map topics to affects
    const topicAffectMapping: Record<string, string> = {};
    for (const block of blocks) {
      const blockTurns = allTurns.filter((t) => t.blockId === block._id);
      const blockAffects = blockTurns.map((t) => t.affect ?? "neutral");
      const mostCommon = blockAffects.sort((a, b) =>
        blockAffects.filter((v) => v === a).length -
        blockAffects.filter((v) => v === b).length
      ).pop() ?? "neutral";
      topicAffectMapping[block.topicLabel] = mostCommon;
    }

    // Generate behavioral notes
    const avgMessageLength = allTurns.reduce((sum, t) => sum + t.userMessage.length, 0) / allTurns.length;
    const behavioralNotes = avgMessageLength > 200
      ? "Detailed, thoughtful responses"
      : avgMessageLength < 50
        ? "Concise, direct communication"
        : "Standard conversational patterns";

    // Save synthesis
    const synthesisId = await ctx.db.insert("daySynthesis", {
      dayId: args.dayId,
      emotionalArc,
      keyPatterns: patterns,
      topicAffectMapping: JSON.stringify(topicAffectMapping),
      behavioralNotes,
      turnCount: allTurns.length,
      blockCount: blocks.length,
      createdAt: Date.now(),
    });

    return synthesisId;
  },
});

// ============================================================================
// Cron Job Triggers
// ============================================================================

/**
 * Trigger daily synthesis for yesterday
 * Called by cron job at end of day
 */
export const triggerDaySynthesis = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get yesterday's date
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dayId = yesterday.toISOString().split("T")[0];

    // Check if synthesis already exists
    const existing = await ctx.db
      .query("daySynthesis")
      .withIndex("by_day", (q) => q.eq("dayId", dayId))
      .first();

    if (existing) {
      return { status: "already_exists", dayId };
    }

    // Get all blocks for yesterday
    const blocks = await ctx.db
      .query("bridgeBlocks")
      .withIndex("by_day", (q) => q.eq("dayId", dayId))
      .collect();

    if (blocks.length === 0) {
      return { status: "no_data", dayId };
    }

    // Get all turns for these blocks
    let allTurns: any[] = [];
    for (const block of blocks) {
      const turns = await ctx.db
        .query("turns")
        .withIndex("by_block", (q) => q.eq("blockId", block._id))
        .collect();
      allTurns = [...allTurns, ...turns];
    }

    // Analyze emotional arc with time-of-day grouping
    // Python: synthesis_engine.py _analyze_emotional_arc() lines 170-210
    const morningEmotions: string[] = [];
    const afternoonEmotions: string[] = [];
    const eveningEmotions: string[] = [];

    for (const turn of allTurns) {
      const affect = turn.affect ?? "neutral";
      const hour = new Date(turn.timestamp).getHours();
      
      if (hour < 12) {
        morningEmotions.push(affect);
      } else if (hour < 18) {
        afternoonEmotions.push(affect);
      } else {
        eveningEmotions.push(affect);
      }
    }

    // Get most common emotion for each period
    const getMostCommon = (arr: string[]): string | null => {
      if (arr.length === 0) return null;
      const counts: Record<string, number> = {};
      for (const item of arr) {
        counts[item] = (counts[item] || 0) + 1;
      }
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    };

    const arcParts: string[] = [];
    const morningMood = getMostCommon(morningEmotions);
    const afternoonMood = getMostCommon(afternoonEmotions);
    const eveningMood = getMostCommon(eveningEmotions);

    if (morningMood) arcParts.push(`Started ${morningMood} in the morning`);
    if (afternoonMood) arcParts.push(`felt ${afternoonMood} in the afternoon`);
    if (eveningMood) arcParts.push(`ended ${eveningMood} in the evening`);

    const emotionalArc = arcParts.length > 0 
      ? arcParts.join(", ") + "."
      : `Neutral emotional tone across ${allTurns.length} exchanges.`;

    const dominantAffect = getMostCommon([...morningEmotions, ...afternoonEmotions, ...eveningEmotions]) ?? "neutral";

    // Key patterns
    const patterns: string[] = [];
    if (allTurns.length > 10) patterns.push("Highly active conversation day");
    if (blocks.length > 3) patterns.push("Explored multiple topics");
    if (dominantAffect === "curious") patterns.push("Inquisitive and exploratory");

    // Topic-affect mapping
    const topicAffectMapping: Record<string, string> = {};
    for (const block of blocks) {
      topicAffectMapping[block.topicLabel] = dominantAffect;
    }

    // Behavioral notes
    const avgMessageLength = allTurns.reduce((sum, t) => sum + t.userMessage.length, 0) / allTurns.length;
    const behavioralNotes = avgMessageLength > 200
      ? "Detailed, thoughtful responses"
      : avgMessageLength < 50
        ? "Concise, direct communication"
        : "Standard conversational patterns";

    // Save synthesis
    await ctx.db.insert("daySynthesis", {
      dayId,
      emotionalArc,
      keyPatterns: patterns,
      topicAffectMapping: JSON.stringify(topicAffectMapping),
      behavioralNotes,
      turnCount: allTurns.length,
      blockCount: blocks.length,
      createdAt: Date.now(),
    });

    return { status: "created", dayId, turnCount: allTurns.length, blockCount: blocks.length };
  },
});

/**
 * Trigger weekly synthesis
 * Called by cron job on Sundays
 */
export const triggerWeekSynthesis = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get current week ID
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
    const weekId = `${now.getFullYear()}-W${weekNum.toString().padStart(2, "0")}`;

    // Check if synthesis already exists
    const existing = await ctx.db
      .query("weekSynthesis")
      .withIndex("by_week", (q) => q.eq("weekId", weekId))
      .first();

    if (existing) {
      return { status: "already_exists", weekId };
    }

    // Get last 7 days of synthesis
    const daySyntheses = await ctx.db.query("daySynthesis").order("desc").take(7);

    if (daySyntheses.length === 0) {
      return { status: "no_data", weekId };
    }

    // Aggregate emotional patterns
    const emotionalPatterns: Record<string, string> = {};
    const topicEvolution: Record<string, string[]> = {};
    const productivityPatterns: Record<string, string> = {};

    for (const day of daySyntheses) {
      emotionalPatterns[day.dayId] = day.emotionalArc;
      productivityPatterns[day.dayId] = day.turnCount > 10 ? "high" : day.turnCount > 5 ? "medium" : "low";

      const topicMapping = JSON.parse(day.topicAffectMapping);
      for (const topic of Object.keys(topicMapping)) {
        if (!topicEvolution[topic]) {
          topicEvolution[topic] = [];
        }
        topicEvolution[topic].push(day.dayId);
      }
    }

    // Key insights
    const keyInsights: string[] = [];
    const avgTurns = daySyntheses.reduce((sum, d) => sum + d.turnCount, 0) / daySyntheses.length;
    if (avgTurns > 10) {
      keyInsights.push("Highly active week with many conversations");
    }
    if (Object.keys(topicEvolution).length > 5) {
      keyInsights.push("Diverse range of topics explored");
    }

    // Save week synthesis
    await ctx.db.insert("weekSynthesis", {
      weekId,
      emotionalPatterns: JSON.stringify(emotionalPatterns),
      topicEvolution: JSON.stringify(topicEvolution),
      productivityPatterns: JSON.stringify(productivityPatterns),
      keyInsights,
      createdAt: Date.now(),
    });

    return { status: "created", weekId, daysAnalyzed: daySyntheses.length };
  },
});
