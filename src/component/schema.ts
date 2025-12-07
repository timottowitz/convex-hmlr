import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * HMLR Schema - Hierarchical Memory Lookup & Routing
 *
 * This schema defines the core data structures for the HMLR memory system:
 * - Bridge Blocks: Topic-based conversation containers
 * - Turns: Individual conversation exchanges within blocks
 * - Facts: Key-value pairs extracted from conversations
 * - Memories: Vector embeddings for semantic search
 * - User Profile: Synthesized user preferences and patterns
 */

// Validator for Bridge Block status
const blockStatus = v.union(
  v.literal("ACTIVE"),
  v.literal("PAUSED"),
  v.literal("CLOSED")
);

// Validator for fact categories
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

export default defineSchema({
  /**
   * Bridge Blocks - Topic-based conversation containers
   *
   * Each block represents a cohesive topic of discussion.
   * The Governor routes new messages to existing blocks or creates new ones.
   */
  bridgeBlocks: defineTable({
    // Temporal organization
    dayId: v.string(), // "2025-01-15" format

    // Topic metadata
    topicLabel: v.string(), // Human-readable topic name
    summary: v.optional(v.string()), // AI-generated summary
    keywords: v.array(v.string()), // Topic keywords for matching

    // State management
    status: blockStatus,
    prevBlockId: v.optional(v.id("bridgeBlocks")), // Linked list for navigation

    // Conversation tracking
    openLoops: v.array(v.string()), // Unresolved questions
    decisionsMade: v.array(v.string()), // Key decisions
    turnCount: v.number(),

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_day", ["dayId"])
    .index("by_status", ["status"])
    .index("by_day_status", ["dayId", "status"])
    .index("by_updated", ["updatedAt"]),

  /**
   * Turns - Individual conversation exchanges
   *
   * Each turn represents one user message + AI response pair.
   * Stored separately from Bridge Blocks for efficient querying.
   */
  turns: defineTable({
    blockId: v.id("bridgeBlocks"),
    turnId: v.string(), // "turn_20250115_143022" format

    // Content
    userMessage: v.string(),
    aiResponse: v.string(),

    // Metadata extracted by LLM
    keywords: v.optional(v.array(v.string())),
    affect: v.optional(v.string()), // Detected emotional tone

    // Timestamps
    timestamp: v.number(),
  })
    .index("by_block", ["blockId"])
    .index("by_timestamp", ["timestamp"])
    .index("by_turnId", ["turnId"]),

  /**
   * Facts - Key-value pairs extracted from conversations
   *
   * Facts are extracted by the FactScrubber during conversation.
   * They enable precise retrieval without semantic search.
   * 
   * Python: fact_scrubber.py Fact dataclass
   * - Links to sentence-level chunks for precise provenance
   * - Supports paragraph and block-level linking
   */
  facts: defineTable({
    // Fact content
    key: v.string(), // "API_KEY", "client_email", "preferred_timezone"
    value: v.string(),
    category: factCategory,

    // Provenance - Block/Turn level
    blockId: v.id("bridgeBlocks"),
    turnId: v.optional(v.string()),
    evidenceSnippet: v.optional(v.string()), // Source text

    // Chunk-level provenance (for precise linking)
    // Python: fact_scrubber.py Fact.source_chunk_id, source_paragraph_id
    sourceChunkId: v.optional(v.string()),     // Sentence chunk ID (highest precision)
    sourceParagraphId: v.optional(v.string()), // Paragraph chunk ID (broader context)

    // Extraction metadata
    confidence: v.optional(v.number()),        // Extraction confidence 0-1
    extractionMethod: v.optional(v.string()),  // "llm" or "heuristic"

    // Temporal ordering (for conflicting facts)
    supersededBy: v.optional(v.id("facts")),

    // Timestamps
    createdAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_block", ["blockId"])
    .index("by_category", ["category"])
    .index("by_created", ["createdAt"])
    .index("by_chunk", ["sourceChunkId"]),

  /**
   * Memories - Vector embeddings for semantic search
   *
   * Each memory is a chunk of conversation with its embedding.
   * Used by the Governor for 2-key filtering (vector + LLM).
   */
  memories: defineTable({
    // Reference
    turnId: v.string(),
    blockId: v.id("bridgeBlocks"),

    // Content
    content: v.string(), // Text that was embedded
    chunkIndex: v.number(), // For multi-chunk turns

    // Vector embedding (from ZeroEntropy)
    embedding: v.array(v.float64()),

    // Timestamps
    createdAt: v.number(),
  })
    .index("by_turn", ["turnId"])
    .index("by_block", ["blockId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1024, // ZeroEntropy zembed-1 dimension
      filterFields: ["blockId"],
    }),

  /**
   * User Profile - Synthesized user preferences and patterns
   *
   * Updated by the Scribe agent in the background.
   * Provides persistent user context across conversations.
   */
  userProfile: defineTable({
    key: v.string(), // "communication_style", "timezone", "preferences"
    value: v.string(),
    confidence: v.number(), // 0.0 - 1.0
    lastUpdated: v.number(),
  }).index("by_key", ["key"]),

  /**
   * Globals - Component-wide configuration
   *
   * Single document storing HMLR configuration.
   */
  globals: defineTable({
    key: v.literal("config"),
    // Embedding configuration
    embeddingDimensions: v.number(),
    embeddingModel: v.string(),
    // LLM configuration
    defaultModel: v.string(),
    governorModel: v.string(),
    // Feature flags
    enableFactExtraction: v.boolean(),
    enableUserProfiling: v.boolean(),
  }).index("by_key", ["key"]),

  // ============================================================================
  // SYNTHESIS SYSTEM - Daily/weekly pattern aggregation
  // ============================================================================

  /**
   * Day Synthesis - Daily summaries of conversation patterns
   *
   * Generated by the Synthesis Engine at end of day.
   */
  daySynthesis: defineTable({
    dayId: v.string(), // "2025-01-15" format
    emotionalArc: v.string(), // "Started curious, became focused, ended satisfied"
    keyPatterns: v.array(v.string()), // ["Highly active", "Technical focus"]
    topicAffectMapping: v.string(), // JSON: {"Python": "curious", "debugging": "frustrated"}
    behavioralNotes: v.string(),
    turnCount: v.number(),
    blockCount: v.number(),
    createdAt: v.number(),
  }).index("by_day", ["dayId"]),

  /**
   * Week Synthesis - Weekly aggregations
   */
  weekSynthesis: defineTable({
    weekId: v.string(), // "2025-W03" format
    emotionalPatterns: v.string(), // JSON: day -> emotion
    topicEvolution: v.string(), // JSON: topic -> progression
    productivityPatterns: v.string(), // JSON: day -> level
    keyInsights: v.array(v.string()),
    createdAt: v.number(),
  }).index("by_week", ["weekId"]),

  // ============================================================================
  // SCRIBE SYSTEM - User profile extraction
  // ============================================================================

  /**
   * User Projects - Named endeavors the user is working on
   */
  userProjects: defineTable({
    key: v.string(), // "HMLR", "Blue Sky"
    domain: v.string(), // "AI / Software"
    description: v.string(),
    techStack: v.optional(v.array(v.string())),
    status: v.string(), // "Active", "Completed", "Paused"
    lastUpdated: v.number(),
  }).index("by_key", ["key"]),

  /**
   * User Entities - Permanent facts about user's world
   */
  userEntities: defineTable({
    key: v.string(), // "son_mike", "company_acme"
    entityType: v.string(), // "Person", "Business", "Asset"
    description: v.string(),
    attributes: v.optional(v.string()), // JSON for additional details
    lastUpdated: v.number(),
  }).index("by_key", ["key"]),

  /**
   * User Constraints - Permanent preferences/restrictions
   */
  userConstraints: defineTable({
    key: v.string(), // "allergy_latex", "no_weekends"
    constraintType: v.string(), // "Allergy", "Dietary", "Work", "Communication"
    description: v.string(),
    severity: v.optional(v.string()), // "severe", "mild", "preference"
    lastUpdated: v.number(),
  }).index("by_key", ["key"]),

  // ============================================================================
  // PLANNING SYSTEM - Multi-turn planning interviews
  // ============================================================================

  /**
   * Planning Sessions - Active planning interviews
   */
  planningSessions: defineTable({
    sessionId: v.string(),
    userQuery: v.string(),
    conversationHistory: v.string(), // JSON array of exchanges
    phase: v.union(
      v.literal("gathering"),
      v.literal("verifying"),
      v.literal("approved"),
      v.literal("cancelled")
    ),
    draftPlan: v.optional(v.string()),
    finalJsonPlan: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_phase", ["phase"]),

  /**
   * Plans - Approved plans ready for execution
   */
  plans: defineTable({
    planId: v.string(),
    title: v.string(),
    topic: v.string(), // "fitness", "meal", "learning", "work"
    startDate: v.string(),
    endDate: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("completed"),
      v.literal("paused")
    ),
    progressPercentage: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_planId", ["planId"])
    .index("by_status", ["status"]),

  /**
   * Plan Items - Individual tasks within a plan
   */
  planItems: defineTable({
    planId: v.id("plans"),
    date: v.string(),
    task: v.string(),
    durationMinutes: v.number(),
    completed: v.boolean(),
    completedAt: v.optional(v.number()),
  })
    .index("by_plan", ["planId"])
    .index("by_date", ["date"]),

  // ============================================================================
  // CHUNKING SYSTEM - Hierarchical text chunks
  // ============================================================================

  /**
   * Chunks - Immutable text chunks for fine-grained retrieval
   */
  chunks: defineTable({
    chunkId: v.string(), // "sent_20251202_143005_abc123"
    chunkType: v.union(v.literal("sentence"), v.literal("paragraph")),
    textVerbatim: v.string(),
    lexicalFilters: v.array(v.string()), // Keywords for hybrid search
    parentChunkId: v.optional(v.string()),
    turnId: v.string(),
    blockId: v.id("bridgeBlocks"),
    embedding: v.optional(v.array(v.float64())),
    tokenCount: v.number(),
    createdAt: v.number(),
  })
    .index("by_turn", ["turnId"])
    .index("by_block", ["blockId"])
    .index("by_chunkId", ["chunkId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1024,
      filterFields: ["blockId"],
    }),

  // ============================================================================
  // DEBUG SYSTEM - Turn-by-turn logging
  // ============================================================================

  /**
   * Debug Logs - Detailed logs for each turn
   */
  debugLogs: defineTable({
    turnId: v.string(),
    category: v.string(), // "query", "context", "prompt", "response", "governor"
    content: v.string(),
    metadata: v.optional(v.string()), // JSON for structured data
    timestamp: v.number(),
  })
    .index("by_turn", ["turnId"])
    .index("by_category", ["category"])
    .index("by_timestamp", ["timestamp"]),

  // ============================================================================
  // LINEAGE SYSTEM - Provenance tracking
  // ============================================================================

  /**
   * Lineage - Track derivation chains
   */
  lineage: defineTable({
    itemId: v.string(), // Any ID (turn, fact, memory, etc.)
    itemType: v.union(
      v.literal("turn"),
      v.literal("fact"),
      v.literal("memory"),
      v.literal("block"),
      v.literal("summary"),
      v.literal("chunk")
    ),
    derivedFrom: v.array(v.string()), // Source IDs
    derivedBy: v.string(), // "fact_scrubber_v1", "governor_v1"
    createdAt: v.number(),
  })
    .index("by_itemId", ["itemId"])
    .index("by_itemType", ["itemType"]),

  // ============================================================================
  // USAGE TRACKING - Which memories get used
  // ============================================================================

  /**
   * Usage Stats - Track memory utilization
   */
  usageStats: defineTable({
    itemId: v.string(), // Turn or memory ID
    itemType: v.string(), // "turn", "memory", "fact"
    usageCount: v.number(),
    lastUsed: v.number(),
    firstUsed: v.number(),
    topics: v.array(v.string()),
  })
    .index("by_itemId", ["itemId"])
    .index("by_usageCount", ["usageCount"]),

  // ============================================================================
  // ADAPTIVE EVICTION - Topic affinity tracking
  // Python: eviction.py EvictionManager.update_topic_affinity()
  // ============================================================================

  /**
   * Topic Affinity - Track which topics get evicted frequently
   * Helps identify low-affinity vs high-affinity topics
   */
  topicAffinity: defineTable({
    topic: v.string(),
    evictionCount: v.number(),
    totalTimeInWindow: v.number(), // Total milliseconds across all evictions
    avgTimeInWindow: v.number(),   // Average milliseconds before eviction
  })
    .index("by_topic", ["topic"])
    .index("by_evictionCount", ["evictionCount"]),
});
