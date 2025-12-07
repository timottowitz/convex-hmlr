import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

/**
 * User Profile - Synthesized user preferences and patterns
 *
 * The User Profile stores learned information about the user:
 * - Communication preferences
 * - Timezone
 * - Interests and expertise areas
 * - Behavioral patterns
 *
 * Updated by the Scribe agent in the background.
 */

// ============================================================================
// Queries
// ============================================================================

/**
 * Get a user profile value by key
 */
export const get = query({
  args: { key: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("userProfile"),
      key: v.string(),
      value: v.string(),
      confidence: v.number(),
      lastUpdated: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("userProfile")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
  },
});

/**
 * Get all user profile entries
 */
export const getAll = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("userProfile"),
      key: v.string(),
      value: v.string(),
      confidence: v.number(),
      lastUpdated: v.number(),
    })
  ),
  handler: async (ctx) => {
    return await ctx.db.query("userProfile").collect();
  },
});

/**
 * Get profile entries above a confidence threshold
 */
export const getHighConfidence = query({
  args: { minConfidence: v.number() },
  returns: v.array(
    v.object({
      _id: v.id("userProfile"),
      key: v.string(),
      value: v.string(),
      confidence: v.number(),
      lastUpdated: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const all = await ctx.db.query("userProfile").collect();
    return all.filter((p) => p.confidence >= args.minConfidence);
  },
});

/**
 * Format user profile as context string (for LLM prompts)
 */
export const getAsContext = query({
  args: { maxTokens: v.optional(v.number()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const maxTokens = args.maxTokens ?? 500;
    const entries = await ctx.db.query("userProfile").collect();

    // Sort by confidence (highest first)
    entries.sort((a, b) => b.confidence - a.confidence);

    // Build context string
    const lines: string[] = [];
    let estimatedTokens = 0;

    for (const entry of entries) {
      const line = `- ${entry.key}: ${entry.value}`;
      const lineTokens = Math.ceil(line.length / 4); // Rough token estimate

      if (estimatedTokens + lineTokens > maxTokens) break;

      lines.push(line);
      estimatedTokens += lineTokens;
    }

    if (lines.length === 0) {
      return "";
    }

    return `[User Profile]\n${lines.join("\n")}`;
  },
});

// ============================================================================
// Mutations
// ============================================================================

/**
 * Set a user profile value
 */
export const set = mutation({
  args: {
    key: v.string(),
    value: v.string(),
    confidence: v.number(),
  },
  returns: v.id("userProfile"),
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check if key exists
    const existing = await ctx.db
      .query("userProfile")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (existing) {
      // Update existing entry
      await ctx.db.patch(existing._id, {
        value: args.value,
        confidence: args.confidence,
        lastUpdated: now,
      });
      return existing._id;
    }

    // Create new entry
    return await ctx.db.insert("userProfile", {
      key: args.key,
      value: args.value,
      confidence: args.confidence,
      lastUpdated: now,
    });
  },
});

/**
 * Update confidence for an existing profile entry
 */
export const updateConfidence = mutation({
  args: {
    key: v.string(),
    confidenceDelta: v.number(),
  },
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userProfile")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (!existing) return null;

    const newConfidence = Math.max(0, Math.min(1, existing.confidence + args.confidenceDelta));

    await ctx.db.patch(existing._id, {
      confidence: newConfidence,
      lastUpdated: Date.now(),
    });

    return newConfidence;
  },
});

/**
 * Remove a user profile entry
 */
export const remove = mutation({
  args: { key: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userProfile")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (!existing) return false;

    await ctx.db.delete(existing._id);
    return true;
  },
});

/**
 * Clear all user profile entries
 */
export const clear = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const entries = await ctx.db.query("userProfile").collect();

    for (const entry of entries) {
      await ctx.db.delete(entry._id);
    }

    return entries.length;
  },
});

/**
 * Batch update profile entries (from Scribe agent)
 */
export const batchUpdate = mutation({
  args: {
    entries: v.array(
      v.object({
        key: v.string(),
        value: v.string(),
        confidence: v.number(),
      })
    ),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const now = Date.now();
    let updated = 0;

    for (const entry of args.entries) {
      const existing = await ctx.db
        .query("userProfile")
        .withIndex("by_key", (q) => q.eq("key", entry.key))
        .first();

      if (existing) {
        // Only update if new confidence is higher
        if (entry.confidence > existing.confidence) {
          await ctx.db.patch(existing._id, {
            value: entry.value,
            confidence: entry.confidence,
            lastUpdated: now,
          });
          updated++;
        }
      } else {
        await ctx.db.insert("userProfile", {
          key: entry.key,
          value: entry.value,
          confidence: entry.confidence,
          lastUpdated: now,
        });
        updated++;
      }
    }

    return updated;
  },
});

// ============================================================================
// Scribe Agent Mutations
// Python: memory/synthesis/scribe.py - Scribe.run_scribe_agent()
// ============================================================================

/**
 * Upsert a user project
 */
export const upsertProject = mutation({
  args: {
    key: v.string(),
    domain: v.optional(v.string()),
    description: v.optional(v.string()),
    techStack: v.optional(v.string()),
    status: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const now = Date.now();

    const existing = await ctx.db
      .query("userProjects")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (existing) {
      // Update existing project
      const updates: Record<string, any> = { lastUpdated: now };
      if (args.domain) updates.domain = args.domain;
      if (args.description) updates.description = args.description;
      if (args.techStack) updates.techStack = args.techStack.split(",").map((s) => s.trim());
      if (args.status) updates.status = args.status;

      await ctx.db.patch(existing._id, updates);
      return existing._id;
    }

    // Create new project
    const id = await ctx.db.insert("userProjects", {
      key: args.key,
      domain: args.domain ?? "General",
      description: args.description ?? "",
      techStack: args.techStack ? args.techStack.split(",").map((s) => s.trim()) : [],
      status: args.status ?? "Active",
      lastUpdated: now,
    });

    return id;
  },
});

/**
 * Upsert a user entity
 */
export const upsertEntity = mutation({
  args: {
    key: v.string(),
    entityType: v.optional(v.string()),
    description: v.optional(v.string()),
    relationship: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const now = Date.now();

    const existing = await ctx.db
      .query("userEntities")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (existing) {
      const updates: Record<string, any> = { lastUpdated: now };
      if (args.entityType) updates.entityType = args.entityType;
      if (args.description) updates.description = args.description;
      if (args.relationship) updates.attributes = JSON.stringify({ relationship: args.relationship });

      await ctx.db.patch(existing._id, updates);
      return existing._id;
    }

    const id = await ctx.db.insert("userEntities", {
      key: args.key,
      entityType: args.entityType ?? "General",
      description: args.description ?? "",
      attributes: args.relationship ? JSON.stringify({ relationship: args.relationship }) : undefined,
      lastUpdated: now,
    });

    return id;
  },
});

/**
 * Upsert a user constraint
 */
export const upsertConstraint = mutation({
  args: {
    key: v.string(),
    constraintType: v.optional(v.string()),
    description: v.optional(v.string()),
    severity: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const now = Date.now();

    const existing = await ctx.db
      .query("userConstraints")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (existing) {
      const updates: Record<string, any> = { lastUpdated: now };
      if (args.constraintType) updates.constraintType = args.constraintType;
      if (args.description) updates.description = args.description;
      if (args.severity) updates.severity = args.severity;

      await ctx.db.patch(existing._id, updates);
      return existing._id;
    }

    const id = await ctx.db.insert("userConstraints", {
      key: args.key,
      constraintType: args.constraintType ?? "preference",
      description: args.description ?? "",
      severity: args.severity ?? "preference",
      lastUpdated: now,
    });

    return id;
  },
});

/**
 * Get all user projects
 */
export const getProjects = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("userProjects").collect();
  },
});

/**
 * Get all user entities
 */
export const getEntities = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("userEntities").collect();
  },
});

/**
 * Get all user constraints
 */
export const getConstraints = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("userConstraints").collect();
  },
});
