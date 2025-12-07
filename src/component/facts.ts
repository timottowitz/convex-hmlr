import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

/**
 * Facts - Key-value store for extracted information
 *
 * Facts are extracted from conversations by the FactScrubber.
 * They provide precise retrieval for specific information like:
 * - Credentials (API keys, passwords)
 * - Preferences (timezone, communication style)
 * - Decisions (approved vendors, chosen options)
 * - Contacts (emails, phone numbers)
 */

// Fact category validator
const factCategory = v.optional(
  v.union(
    v.literal("credential"),
    v.literal("preference"),
    v.literal("policy"),
    v.literal("decision"),
    v.literal("contact"),
    v.literal("date"),
    v.literal("general")
  )
);

// ============================================================================
// Queries
// ============================================================================

/**
 * Get a fact by exact key match
 * Returns the most recent non-superseded fact
 */
export const get = query({
  args: { key: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("facts"),
      key: v.string(),
      value: v.string(),
      category: factCategory,
      blockId: v.id("bridgeBlocks"),
      turnId: v.optional(v.string()),
      evidenceSnippet: v.optional(v.string()),
      supersededBy: v.optional(v.id("facts")),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    // Get all facts with this key, ordered by creation time (newest first)
    const facts = await ctx.db
      .query("facts")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .order("desc")
      .collect();

    // Return the most recent non-superseded fact
    for (const fact of facts) {
      if (!fact.supersededBy) {
        return fact;
      }
    }

    return null;
  },
});

/**
 * Get all facts for a Bridge Block
 */
export const getByBlock = query({
  args: { blockId: v.id("bridgeBlocks") },
  returns: v.array(
    v.object({
      _id: v.id("facts"),
      key: v.string(),
      value: v.string(),
      category: factCategory,
      blockId: v.id("bridgeBlocks"),
      turnId: v.optional(v.string()),
      evidenceSnippet: v.optional(v.string()),
      supersededBy: v.optional(v.id("facts")),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("facts")
      .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
      .collect();
  },
});

/**
 * Get all facts by category
 */
export const getByCategory = query({
  args: {
    category: v.union(
      v.literal("credential"),
      v.literal("preference"),
      v.literal("policy"),
      v.literal("decision"),
      v.literal("contact"),
      v.literal("date"),
      v.literal("general")
    ),
  },
  returns: v.array(
    v.object({
      _id: v.id("facts"),
      key: v.string(),
      value: v.string(),
      category: factCategory,
      blockId: v.id("bridgeBlocks"),
      turnId: v.optional(v.string()),
      evidenceSnippet: v.optional(v.string()),
      supersededBy: v.optional(v.id("facts")),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const facts = await ctx.db
      .query("facts")
      .withIndex("by_category", (q) => q.eq("category", args.category))
      .collect();

    // Filter out superseded facts
    return facts.filter((fact) => !fact.supersededBy);
  },
});

/**
 * Search facts by key prefix (for autocomplete/fuzzy matching)
 */
export const searchByKeyPrefix = query({
  args: { prefix: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("facts"),
      key: v.string(),
      value: v.string(),
      category: factCategory,
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    // Get all facts and filter by prefix
    // Note: For production, consider a more efficient index strategy
    const allFacts = await ctx.db.query("facts").collect();

    const prefix = args.prefix.toLowerCase();
    return allFacts
      .filter(
        (fact) =>
          fact.key.toLowerCase().startsWith(prefix) && !fact.supersededBy
      )
      .map((fact) => ({
        _id: fact._id,
        key: fact.key,
        value: fact.value,
        category: fact.category,
        createdAt: fact.createdAt,
      }));
  },
});

// ============================================================================
// Mutations
// ============================================================================

/**
 * Store a new fact
 * If a fact with the same key exists, it will be superseded
 */
export const store = mutation({
  args: {
    key: v.string(),
    value: v.string(),
    category: factCategory,
    blockId: v.id("bridgeBlocks"),
    turnId: v.optional(v.string()),
    evidenceSnippet: v.optional(v.string()),
  },
  returns: v.id("facts"),
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check if a fact with this key already exists
    const existingFacts = await ctx.db
      .query("facts")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .collect();

    // Insert the new fact
    const newFactId = await ctx.db.insert("facts", {
      key: args.key,
      value: args.value,
      category: args.category,
      blockId: args.blockId,
      turnId: args.turnId,
      evidenceSnippet: args.evidenceSnippet,
      createdAt: now,
    });

    // Mark existing non-superseded facts as superseded
    for (const existingFact of existingFacts) {
      if (!existingFact.supersededBy) {
        await ctx.db.patch(existingFact._id, {
          supersededBy: newFactId,
        });
      }
    }

    return newFactId;
  },
});

/**
 * Store multiple facts at once (batch operation)
 */
export const storeBatch = mutation({
  args: {
    facts: v.array(
      v.object({
        key: v.string(),
        value: v.string(),
        category: factCategory,
        blockId: v.id("bridgeBlocks"),
        turnId: v.optional(v.string()),
        evidenceSnippet: v.optional(v.string()),
      })
    ),
  },
  returns: v.array(v.id("facts")),
  handler: async (ctx, args) => {
    const now = Date.now();
    const newFactIds: Array<typeof args.facts[0] extends { key: string } ? string : never> = [];

    for (const factData of args.facts) {
      // Check if a fact with this key already exists
      const existingFacts = await ctx.db
        .query("facts")
        .withIndex("by_key", (q) => q.eq("key", factData.key))
        .collect();

      // Insert the new fact
      const newFactId = await ctx.db.insert("facts", {
        key: factData.key,
        value: factData.value,
        category: factData.category,
        blockId: factData.blockId,
        turnId: factData.turnId,
        evidenceSnippet: factData.evidenceSnippet,
        createdAt: now,
      });

      // Mark existing non-superseded facts as superseded
      for (const existingFact of existingFacts) {
        if (!existingFact.supersededBy) {
          await ctx.db.patch(existingFact._id, {
            supersededBy: newFactId,
          });
        }
      }

      newFactIds.push(newFactId as any);
    }

    return newFactIds as any;
  },
});

/**
 * Delete a fact (soft delete by marking as superseded with null value)
 */
export const remove = mutation({
  args: { factId: v.id("facts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const fact = await ctx.db.get(args.factId);
    if (!fact) return null;

    // Create a "deleted" fact that supersedes the existing one
    const deletedFactId = await ctx.db.insert("facts", {
      key: fact.key,
      value: "[DELETED]",
      category: fact.category,
      blockId: fact.blockId,
      evidenceSnippet: "Fact was explicitly deleted",
      createdAt: Date.now(),
    });

    await ctx.db.patch(args.factId, {
      supersededBy: deletedFactId,
    });

    return null;
  },
});

/**
 * Link facts to a block after Governor assigns block ID
 * (Used when facts are extracted before block routing is complete)
 */
export const updateBlockId = mutation({
  args: {
    turnId: v.string(),
    blockId: v.id("bridgeBlocks"),
  },
  returns: v.number(), // Returns count of updated facts
  handler: async (ctx, args) => {
    // Find all facts with this turnId that don't have a blockId
    const facts = await ctx.db.query("facts").collect();

    let updateCount = 0;
    for (const fact of facts) {
      if (fact.turnId === args.turnId) {
        await ctx.db.patch(fact._id, { blockId: args.blockId });
        updateCount++;
      }
    }

    return updateCount;
  },
});
