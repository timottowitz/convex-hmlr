/**
 * Lineage Tracker - Provenance tracking for all HMLR data
 *
 * Ported from Python: memory/lineage_tracker.py
 *
 * Tracks derivation chains:
 * - Which turn produced which facts
 * - Which facts came from which memories
 * - Which blocks contain which chunks
 * - Full provenance for debugging and auditing
 */

import { v } from "convex/values";
import { query, mutation } from "../_generated/server";

// ============================================================================
// Types
// ============================================================================

export type ItemType = "turn" | "fact" | "memory" | "block" | "summary" | "chunk";

export interface LineageNode {
  itemId: string;
  itemType: ItemType;
  derivedFrom: string[];
  derivedBy: string;
  createdAt: number;
}

export interface LineageTree {
  root: LineageNode;
  ancestors: LineageNode[];
  descendants: LineageNode[];
}

// ============================================================================
// Mutations
// ============================================================================

export const recordLineage = mutation({
  args: {
    itemId: v.string(),
    itemType: v.union(
      v.literal("turn"),
      v.literal("fact"),
      v.literal("memory"),
      v.literal("block"),
      v.literal("summary"),
      v.literal("chunk")
    ),
    derivedFrom: v.array(v.string()),
    derivedBy: v.string(),
  },
  handler: async (ctx, args) => {
    // Check if lineage already exists
    const existing = await ctx.db
      .query("lineage")
      .withIndex("by_itemId", (q) => q.eq("itemId", args.itemId))
      .first();

    if (existing) {
      // Update existing lineage
      await ctx.db.patch(existing._id, {
        derivedFrom: args.derivedFrom,
        derivedBy: args.derivedBy,
        createdAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("lineage", {
      itemId: args.itemId,
      itemType: args.itemType,
      derivedFrom: args.derivedFrom,
      derivedBy: args.derivedBy,
      createdAt: Date.now(),
    });
  },
});

export const recordFactLineage = mutation({
  args: {
    factKey: v.string(),
    turnId: v.string(),
    blockId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("lineage", {
      itemId: `fact:${args.factKey}`,
      itemType: "fact",
      derivedFrom: [args.turnId, args.blockId],
      derivedBy: "fact_scrubber_v1",
      createdAt: Date.now(),
    });
  },
});

export const recordMemoryLineage = mutation({
  args: {
    memoryId: v.string(),
    turnId: v.string(),
    chunkId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const derivedFrom = [args.turnId];
    if (args.chunkId) {
      derivedFrom.push(args.chunkId);
    }

    return await ctx.db.insert("lineage", {
      itemId: args.memoryId,
      itemType: "memory",
      derivedFrom,
      derivedBy: "embedding_engine_v1",
      createdAt: Date.now(),
    });
  },
});

export const recordChunkLineage = mutation({
  args: {
    chunkId: v.string(),
    turnId: v.string(),
    blockId: v.string(),
    parentChunkId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const derivedFrom = [args.turnId, args.blockId];
    if (args.parentChunkId) {
      derivedFrom.push(args.parentChunkId);
    }

    return await ctx.db.insert("lineage", {
      itemId: args.chunkId,
      itemType: "chunk",
      derivedFrom,
      derivedBy: "chunk_engine_v1",
      createdAt: Date.now(),
    });
  },
});

// ============================================================================
// Queries
// ============================================================================

export const getLineage = query({
  args: { itemId: v.string() },
  handler: async (ctx, args): Promise<LineageNode | null> => {
    const lineage = await ctx.db
      .query("lineage")
      .withIndex("by_itemId", (q) => q.eq("itemId", args.itemId))
      .first();

    if (!lineage) return null;

    return {
      itemId: lineage.itemId,
      itemType: lineage.itemType as ItemType,
      derivedFrom: lineage.derivedFrom,
      derivedBy: lineage.derivedBy,
      createdAt: lineage.createdAt,
    };
  },
});

export const getAncestors = query({
  args: {
    itemId: v.string(),
    maxDepth: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<LineageNode[]> => {
    const maxDepth = args.maxDepth ?? 10;
    const ancestors: LineageNode[] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [
      { id: args.itemId, depth: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.depth >= maxDepth || visited.has(current.id)) {
        continue;
      }
      visited.add(current.id);

      const lineage = await ctx.db
        .query("lineage")
        .withIndex("by_itemId", (q) => q.eq("itemId", current.id))
        .first();

      if (lineage && current.depth > 0) {
        ancestors.push({
          itemId: lineage.itemId,
          itemType: lineage.itemType as ItemType,
          derivedFrom: lineage.derivedFrom,
          derivedBy: lineage.derivedBy,
          createdAt: lineage.createdAt,
        });
      }

      // Add parents to queue
      if (lineage) {
        for (const parentId of lineage.derivedFrom) {
          if (!visited.has(parentId)) {
            queue.push({ id: parentId, depth: current.depth + 1 });
          }
        }
      }
    }

    return ancestors;
  },
});

export const getDescendants = query({
  args: {
    itemId: v.string(),
    maxDepth: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<LineageNode[]> => {
    const maxDepth = args.maxDepth ?? 10;
    const descendants: LineageNode[] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [
      { id: args.itemId, depth: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.depth >= maxDepth || visited.has(current.id)) {
        continue;
      }
      visited.add(current.id);

      // Find items that derive from this one
      const children = await ctx.db.query("lineage").collect();
      const childNodes = children.filter((l) =>
        l.derivedFrom.includes(current.id)
      );

      for (const child of childNodes) {
        if (!visited.has(child.itemId)) {
          descendants.push({
            itemId: child.itemId,
            itemType: child.itemType as ItemType,
            derivedFrom: child.derivedFrom,
            derivedBy: child.derivedBy,
            createdAt: child.createdAt,
          });
          queue.push({ id: child.itemId, depth: current.depth + 1 });
        }
      }
    }

    return descendants;
  },
});

export const getLineageTree = query({
  args: { itemId: v.string() },
  handler: async (ctx, args): Promise<LineageTree | null> => {
    const root = await ctx.db
      .query("lineage")
      .withIndex("by_itemId", (q) => q.eq("itemId", args.itemId))
      .first();

    if (!root) return null;

    // Get ancestors (simplified - single level)
    const ancestors: LineageNode[] = [];
    for (const parentId of root.derivedFrom) {
      const parent = await ctx.db
        .query("lineage")
        .withIndex("by_itemId", (q) => q.eq("itemId", parentId))
        .first();

      if (parent) {
        ancestors.push({
          itemId: parent.itemId,
          itemType: parent.itemType as ItemType,
          derivedFrom: parent.derivedFrom,
          derivedBy: parent.derivedBy,
          createdAt: parent.createdAt,
        });
      }
    }

    // Get descendants (simplified - single level)
    const allLineage = await ctx.db.query("lineage").collect();
    const descendants: LineageNode[] = allLineage
      .filter((l) => l.derivedFrom.includes(args.itemId))
      .map((l) => ({
        itemId: l.itemId,
        itemType: l.itemType as ItemType,
        derivedFrom: l.derivedFrom,
        derivedBy: l.derivedBy,
        createdAt: l.createdAt,
      }));

    return {
      root: {
        itemId: root.itemId,
        itemType: root.itemType as ItemType,
        derivedFrom: root.derivedFrom,
        derivedBy: root.derivedBy,
        createdAt: root.createdAt,
      },
      ancestors,
      descendants,
    };
  },
});

export const getLineageByType = query({
  args: {
    itemType: v.union(
      v.literal("turn"),
      v.literal("fact"),
      v.literal("memory"),
      v.literal("block"),
      v.literal("summary"),
      v.literal("chunk")
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    const items = await ctx.db
      .query("lineage")
      .withIndex("by_itemType", (q) => q.eq("itemType", args.itemType))
      .take(limit);

    return items.map((l) => ({
      itemId: l.itemId,
      itemType: l.itemType,
      derivedFrom: l.derivedFrom,
      derivedBy: l.derivedBy,
      createdAt: l.createdAt,
    }));
  },
});

export const validateIntegrity = query({
  args: {},
  handler: async (ctx): Promise<{
    valid: boolean;
    orphanedItems: string[];
    brokenReferences: Array<{ itemId: string; missingRef: string }>;
  }> => {
    const allLineage = await ctx.db.query("lineage").collect();
    const allItemIds = new Set(allLineage.map((l) => l.itemId));

    const orphanedItems: string[] = [];
    const brokenReferences: Array<{ itemId: string; missingRef: string }> = [];

    for (const lineage of allLineage) {
      // Check for broken references
      for (const ref of lineage.derivedFrom) {
        if (!allItemIds.has(ref)) {
          // Reference doesn't exist in lineage table
          // This might be OK if it's a turn/block ID from another table
          // For now, just track it
          brokenReferences.push({
            itemId: lineage.itemId,
            missingRef: ref,
          });
        }
      }

      // Check for orphaned items (no references and no children)
      if (lineage.derivedFrom.length === 0) {
        const hasChildren = allLineage.some((l) =>
          l.derivedFrom.includes(lineage.itemId)
        );
        if (!hasChildren) {
          orphanedItems.push(lineage.itemId);
        }
      }
    }

    return {
      valid: brokenReferences.length === 0,
      orphanedItems,
      brokenReferences,
    };
  },
});

export const getLineageStats = query({
  args: {},
  handler: async (ctx) => {
    const allLineage = await ctx.db.query("lineage").collect();

    const byType: Record<string, number> = {};
    const byDeriver: Record<string, number> = {};

    for (const l of allLineage) {
      byType[l.itemType] = (byType[l.itemType] || 0) + 1;
      byDeriver[l.derivedBy] = (byDeriver[l.derivedBy] || 0) + 1;
    }

    return {
      totalItems: allLineage.length,
      byType,
      byDeriver,
    };
  },
});

// ============================================================================
// Visualization Queries
// Python: lineage_tracker.py LineageTracker.visualize()
// ============================================================================

/**
 * Generate Mermaid diagram for lineage visualization
 */
export const getMermaidDiagram = query({
  args: {
    itemId: v.string(),
    maxDepth: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const maxDepth = args.maxDepth ?? 3;
    const visited = new Set<string>();
    const edges: Array<{ from: string; to: string; label: string }> = [];

    // BFS to collect edges
    const queue: Array<{ id: string; depth: number }> = [{ id: args.itemId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth || visited.has(current.id)) continue;
      visited.add(current.id);

      const lineage = await ctx.db
        .query("lineage")
        .withIndex("by_itemId", (q) => q.eq("itemId", current.id))
        .first();

      if (lineage) {
        for (const parentId of lineage.derivedFrom) {
          edges.push({
            from: sanitizeNodeId(parentId),
            to: sanitizeNodeId(current.id),
            label: lineage.derivedBy,
          });
          if (!visited.has(parentId)) {
            queue.push({ id: parentId, depth: current.depth + 1 });
          }
        }
      }

      // Find children
      const allLineage = await ctx.db.query("lineage").collect();
      for (const child of allLineage) {
        if (child.derivedFrom.includes(current.id) && !visited.has(child.itemId)) {
          edges.push({
            from: sanitizeNodeId(current.id),
            to: sanitizeNodeId(child.itemId),
            label: child.derivedBy,
          });
          queue.push({ id: child.itemId, depth: current.depth + 1 });
        }
      }
    }

    // Generate Mermaid syntax
    let diagram = "graph TD\n";
    for (const edge of edges) {
      diagram += `  ${edge.from} -->|${edge.label}| ${edge.to}\n`;
    }

    return diagram;
  },
});

/**
 * Get lineage path between two items
 */
export const getLineagePath = query({
  args: {
    fromId: v.string(),
    toId: v.string(),
    maxDepth: v.optional(v.number()),
  },
  returns: v.union(
    v.null(),
    v.array(v.object({
      itemId: v.string(),
      itemType: v.string(),
      derivedBy: v.string(),
    }))
  ),
  handler: async (ctx, args) => {
    const maxDepth = args.maxDepth ?? 10;
    const visited = new Set<string>();
    const parentMap = new Map<string, { parentId: string; derivedBy: string }>();

    // BFS from source
    const queue: Array<{ id: string; depth: number }> = [{ id: args.fromId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth || visited.has(current.id)) continue;
      visited.add(current.id);

      if (current.id === args.toId) {
        // Reconstruct path
        const path: Array<{ itemId: string; itemType: string; derivedBy: string }> = [];
        let nodeId = args.toId;

        while (nodeId !== args.fromId) {
          const lineage = await ctx.db
            .query("lineage")
            .withIndex("by_itemId", (q) => q.eq("itemId", nodeId))
            .first();

          const parent = parentMap.get(nodeId);
          if (!parent) break;

          path.unshift({
            itemId: nodeId,
            itemType: lineage?.itemType ?? "unknown",
            derivedBy: parent.derivedBy,
          });
          nodeId = parent.parentId;
        }

        // Add source
        const sourceLineage = await ctx.db
          .query("lineage")
          .withIndex("by_itemId", (q) => q.eq("itemId", args.fromId))
          .first();

        path.unshift({
          itemId: args.fromId,
          itemType: sourceLineage?.itemType ?? "unknown",
          derivedBy: "source",
        });

        return path;
      }

      // Explore children
      const allLineage = await ctx.db.query("lineage").collect();
      for (const child of allLineage) {
        if (child.derivedFrom.includes(current.id) && !visited.has(child.itemId)) {
          parentMap.set(child.itemId, { parentId: current.id, derivedBy: child.derivedBy });
          queue.push({ id: child.itemId, depth: current.depth + 1 });
        }
      }
    }

    return null; // No path found
  },
});

/**
 * Get provenance summary for a response (what memories/facts contributed)
 */
export const getResponseProvenance = query({
  args: { turnId: v.string() },
  returns: v.object({
    turnId: v.string(),
    facts: v.array(v.object({
      key: v.string(),
      value: v.string(),
      derivedBy: v.string(),
    })),
    memories: v.array(v.object({
      memoryId: v.string(),
      contentPreview: v.string(),
    })),
    blocks: v.array(v.object({
      blockId: v.string(),
      topicLabel: v.string(),
    })),
  }),
  handler: async (ctx, args) => {
    // Get lineage items derived from this turn
    const allLineage = await ctx.db.query("lineage").collect();
    const derived = allLineage.filter((l) => l.derivedFrom.includes(args.turnId));

    const facts: Array<{ key: string; value: string; derivedBy: string }> = [];
    const memories: Array<{ memoryId: string; contentPreview: string }> = [];
    const blocks: Array<{ blockId: string; topicLabel: string }> = [];

    for (const item of derived) {
      if (item.itemType === "fact") {
        // Extract fact key from itemId (format: "fact:KEY")
        const key = item.itemId.replace("fact:", "");
        const fact = await ctx.db
          .query("facts")
          .withIndex("by_key", (q) => q.eq("key", key))
          .first();

        if (fact) {
          facts.push({
            key: fact.key,
            value: fact.value,
            derivedBy: item.derivedBy,
          });
        }
      } else if (item.itemType === "memory") {
        memories.push({
          memoryId: item.itemId,
          contentPreview: item.itemId.substring(0, 50) + "...",
        });
      } else if (item.itemType === "block") {
        const block = await ctx.db.get(item.itemId as any);
        if (block) {
          blocks.push({
            blockId: item.itemId,
            topicLabel: (block as any).topicLabel ?? "unknown",
          });
        }
      }
    }

    return { turnId: args.turnId, facts, memories, blocks };
  },
});

// Helper to sanitize node IDs for Mermaid
function sanitizeNodeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 30);
}
