/**
 * HMLR Client - Ergonomic TypeScript API for the HMLR Convex Component
 *
 * This client provides a clean, type-safe interface for interacting with
 * the HMLR memory system from your Convex app.
 *
 * Usage:
 * ```typescript
 * import { HMLR } from "@timottowitz/convex-hmlr";
 * import { components } from "./_generated/api";
 *
 * const hmlr = new HMLR(components.hmlr, {
 *   OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
 * });
 *
 * // In your action:
 * const result = await hmlr.chat(ctx, {
 *   message: "Hello!",
 *   context: { clientName: "John" },
 * });
 * ```
 */

import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";

// ============================================================================
// Types
// ============================================================================

/**
 * Component API type - imported from generated code
 * This represents the shape of `components.hmlr` in the consuming app
 */
export interface HMLRComponentApi {
  chat: {
    sendMessage: any;
    getHistory: any;
    searchConversations: any;
  };
  bridgeBlocks: {
    get: any;
    getByDay: any;
    getActive: any;
    getMetadataByDay: any;
    getTurns: any;
    create: any;
    updateStatus: any;
    updateMetadata: any;
    appendTurn: any;
    generateSummary: any;
  };
  facts: {
    get: any;
    getByBlock: any;
    getByCategory: any;
    searchByKeyPrefix: any;
    store: any;
    storeBatch: any;
    remove: any;
    updateBlockId: any;
  };
  memories: {
    getByTurn: any;
    getByBlock: any;
    store: any;
    storeBatch: any;
    deleteByTurn: any;
    search: any;
    searchWithContext: any;
  };
  governor: {
    govern: any;
    route: any;
    filterMemories: any;
  };
  // New modules
  synthesis: {
    getDaySynthesis: any;
    getRecentSyntheses: any;
    saveDaySynthesis: any;
    getWeekSynthesis: any;
    saveWeekSynthesis: any;
    getSynthesisContext: any;
    getUserProjects: any;
    getUserEntities: any;
    getUserConstraints: any;
    upsertProject: any;
    upsertEntity: any;
    upsertConstraint: any;
    getProfileContext: any;
  };
  tabulaRasa: {
    getActiveBlock: any;
    getBlockHistory: any;
    closeBlock: any;
    createNewBlock: any;
  };
  chunking: {
    getChunksByTurn: any;
    getChunksByBlock: any;
    searchChunksByKeyword: any;
    saveChunks: any;
    updateChunkEmbedding: any;
  };
  planning: {
    getSession: any;
    getActiveSessions: any;
    getPlans: any;
    getPlanWithItems: any;
    createSession: any;
    updateSession: any;
    createPlan: any;
    completePlanItem: any;
    updatePlanStatus: any;
  };
  debug: {
    logDebug: any;
    getDebugLogs: any;
    getTurnSummary: any;
    getRecentLogs: any;
    getLogStats: any;
    clearDebugLogs: any;
  };
  lineage: {
    recordLineage: any;
    getLineage: any;
    getAncestors: any;
    getDescendants: any;
    getLineageTree: any;
    validateIntegrity: any;
    getLineageStats: any;
  };
  usage: {
    markUsed: any;
    getUsage: any;
    getMostUsed: any;
    getLeastUsed: any;
    analyzeUsage: any;
    getUsageStats: any;
  };
  adaptive: {
    getCompressionStats: any;
  };
  retrieval: {
    hydrateContext: any;
    getTokenStats: any;
    searchMemories: any;
    searchChunks: any;
    searchFacts: any;
  };
}

/**
 * HMLR configuration options
 */
export interface HMLRConfig {
  /** OpenAI API key for LLM and embeddings */
  OPENAI_API_KEY: string;
  /** Optional: ZeroEntropy API key for embeddings (falls back to OpenAI) */
  ZEROENTROPY_API_KEY?: string;
  /** Optional: Default model for chat responses */
  defaultModel?: string;
  /** Optional: Model for Governor routing (faster, cheaper) */
  governorModel?: string;
  /** Optional: Embedding dimensions (default: 1024) */
  embeddingDimensions?: number;
}

/**
 * Chat message options
 */
export interface ChatOptions {
  /** The user's message */
  message: string;
  /** Optional: User identifier for personalization */
  userId?: string;
  /** Optional: App-specific context */
  context?: {
    caseId?: string;
    clientName?: string;
    additionalContext?: string;
  };
}

/**
 * Chat response
 */
export interface ChatResponse {
  /** The AI's response */
  response: string;
  /** The Bridge Block ID for this conversation */
  blockId: string;
  /** The turn ID for this exchange */
  turnId: string;
  /** Whether this started a new topic */
  isNewTopic: boolean;
  /** The topic label */
  topicLabel: string;
  /** Number of memories used for context */
  memoriesUsed: number;
  /** Number of facts used for context */
  factsUsed: number;
}

/**
 * Memory search result
 */
export interface MemorySearchResult {
  content: string;
  score: number;
  topicLabel: string;
  dayId: string;
}

/**
 * Fact
 */
export interface Fact {
  key: string;
  value: string;
  category?: string;
  blockId: string;
  createdAt: number;
}

/**
 * Turn (conversation exchange)
 */
export interface Turn {
  turnId: string;
  userMessage: string;
  aiResponse: string;
  timestamp: number;
}

/**
 * Bridge Block (topic container)
 */
export interface BridgeBlock {
  blockId: string;
  dayId: string;
  topicLabel: string;
  summary?: string;
  keywords: string[];
  status: "ACTIVE" | "PAUSED" | "CLOSED";
  turnCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Day Synthesis - daily conversation pattern summary
 */
export interface DaySynthesis {
  dayId: string;
  emotionalArc: string;
  keyPatterns: string[];
  topicAffectMapping: Record<string, string>;
  behavioralNotes: string;
  turnCount: number;
  blockCount: number;
}

/**
 * User Project - named endeavor tracked by Scribe
 */
export interface UserProject {
  key: string;
  domain: string;
  description: string;
  techStack?: string[];
  status: string;
}

/**
 * User Constraint - permanent preference/restriction
 */
export interface UserConstraint {
  key: string;
  constraintType: string;
  description: string;
  severity?: string;
}

/**
 * Planning Session
 */
export interface PlanningSession {
  sessionId: string;
  userQuery: string;
  phase: "gathering" | "verifying" | "approved" | "cancelled";
  draftPlan?: string;
}

/**
 * Plan with items
 */
export interface Plan {
  planId: string;
  title: string;
  topic: string;
  startDate: string;
  endDate: string;
  status: "active" | "completed" | "paused";
  progressPercentage: number;
  items?: PlanItem[];
}

/**
 * Plan item
 */
export interface PlanItem {
  date: string;
  task: string;
  durationMinutes: number;
  completed: boolean;
}

/**
 * Debug log entry
 */
export interface DebugLogEntry {
  turnId: string;
  category: string;
  content: string;
  timestamp: number;
}

/**
 * Lineage node - provenance tracking
 */
export interface LineageNode {
  itemId: string;
  itemType: "turn" | "fact" | "memory" | "block" | "summary" | "chunk";
  derivedFrom: string[];
  derivedBy: string;
}

/**
 * Usage stats
 */
export interface UsageStats {
  itemId: string;
  usageCount: number;
  lastUsed: number;
}

/**
 * Topic shift result
 */
export interface TopicShiftResult {
  isShift: boolean;
  reason: string;
  newTopicLabel?: string;
  confidence: number;
}

/**
 * Compression decision
 */
export interface CompressionDecision {
  level: "NO_COMPRESSION" | "COMPRESS_PARTIAL" | "COMPRESS_ALL";
  reason: string;
  keepVerbatimCount: number;
}

// Context type helpers
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runAction" | "runQuery" | "runMutation"
>;
type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;

// ============================================================================
// HMLR Client Class
// ============================================================================

/**
 * HMLR - Hierarchical Memory Lookup & Routing Client
 *
 * Provides an ergonomic interface for the HMLR memory system.
 */
export class HMLR {
  private component: HMLRComponentApi;
  private config: Required<HMLRConfig>;

  constructor(component: HMLRComponentApi, config: HMLRConfig) {
    this.component = component;
    this.config = {
      OPENAI_API_KEY: config.OPENAI_API_KEY,
      ZEROENTROPY_API_KEY: config.ZEROENTROPY_API_KEY ?? config.OPENAI_API_KEY,
      defaultModel: config.defaultModel ?? "gpt-4o",
      governorModel: config.governorModel ?? "gpt-4o-mini",
      embeddingDimensions: config.embeddingDimensions ?? 1024,
    };
  }

  // ==========================================================================
  // Chat
  // ==========================================================================

  /**
   * Send a message and get an AI response with full memory context
   *
   * This is the main entry point for conversations. It handles:
   * - Topic routing (new vs existing conversation)
   * - Memory retrieval (semantic search)
   * - Fact lookup (exact key matching)
   * - Response generation
   * - Turn persistence
   * - Fact extraction
   */
  async chat(ctx: ActionCtx, options: ChatOptions): Promise<ChatResponse> {
    return await ctx.runAction(this.component.chat.sendMessage, {
      message: options.message,
      userId: options.userId,
      context: options.context,
      openaiApiKey: this.config.OPENAI_API_KEY,
      zeroEntropyApiKey: this.config.ZEROENTROPY_API_KEY,
      model: this.config.defaultModel,
      governorModel: this.config.governorModel,
      embeddingDimensions: this.config.embeddingDimensions,
    });
  }

  /**
   * Search across all conversations semantically
   */
  async search(
    ctx: ActionCtx,
    query: string,
    limit?: number
  ): Promise<MemorySearchResult[]> {
    return await ctx.runAction(this.component.chat.searchConversations, {
      query,
      openaiApiKey: this.config.OPENAI_API_KEY,
      limit,
    });
  }

  /**
   * Get conversation history for a topic
   */
  async getHistory(
    ctx: ActionCtx,
    blockId: string,
    limit?: number
  ): Promise<Turn[]> {
    return await ctx.runAction(this.component.chat.getHistory, {
      blockId,
      limit,
    });
  }

  // ==========================================================================
  // Facts
  // ==========================================================================

  /**
   * Store a fact explicitly
   */
  async storeFact(
    ctx: MutationCtx,
    args: {
      key: string;
      value: string;
      category?: "credential" | "preference" | "policy" | "decision" | "contact" | "date" | "general";
      blockId: string;
    }
  ): Promise<string> {
    return await ctx.runMutation(this.component.facts.store, args);
  }

  /**
   * Get a fact by key
   */
  async getFact(ctx: QueryCtx, key: string): Promise<Fact | null> {
    return await ctx.runQuery(this.component.facts.get, { key });
  }

  /**
   * Get all facts for a Bridge Block
   */
  async getFactsByBlock(ctx: QueryCtx, blockId: string): Promise<Fact[]> {
    return await ctx.runQuery(this.component.facts.getByBlock, { blockId });
  }

  /**
   * Get facts by category
   */
  async getFactsByCategory(
    ctx: QueryCtx,
    category: "credential" | "preference" | "policy" | "decision" | "contact" | "date" | "general"
  ): Promise<Fact[]> {
    return await ctx.runQuery(this.component.facts.getByCategory, { category });
  }

  /**
   * Search facts by key prefix
   */
  async searchFacts(ctx: QueryCtx, prefix: string): Promise<Fact[]> {
    return await ctx.runQuery(this.component.facts.searchByKeyPrefix, { prefix });
  }

  /**
   * Remove a fact (soft delete)
   */
  async removeFact(ctx: MutationCtx, factId: string): Promise<void> {
    await ctx.runMutation(this.component.facts.remove, { factId });
  }

  // ==========================================================================
  // Bridge Blocks
  // ==========================================================================

  /**
   * Get the currently active Bridge Block
   */
  async getActiveBlock(ctx: QueryCtx): Promise<BridgeBlock | null> {
    const block = await ctx.runQuery(this.component.bridgeBlocks.getActive, {});
    if (!block) return null;

    return {
      blockId: block._id,
      dayId: block.dayId,
      topicLabel: block.topicLabel,
      summary: block.summary,
      keywords: block.keywords,
      status: block.status,
      turnCount: block.turnCount,
      createdAt: block.createdAt,
      updatedAt: block.updatedAt,
    };
  }

  /**
   * Get all Bridge Blocks for a specific day
   */
  async getBlocksByDay(ctx: QueryCtx, dayId: string): Promise<BridgeBlock[]> {
    const blocks = await ctx.runQuery(this.component.bridgeBlocks.getByDay, { dayId });

    return blocks.map((b: any) => ({
      blockId: b._id,
      dayId: b.dayId,
      topicLabel: b.topicLabel,
      summary: b.summary,
      keywords: b.keywords,
      status: b.status,
      turnCount: b.turnCount,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }));
  }

  /**
   * Get a specific Bridge Block
   */
  async getBlock(ctx: QueryCtx, blockId: string): Promise<BridgeBlock | null> {
    const block = await ctx.runQuery(this.component.bridgeBlocks.get, { blockId });
    if (!block) return null;

    return {
      blockId: block._id,
      dayId: block.dayId,
      topicLabel: block.topicLabel,
      summary: block.summary,
      keywords: block.keywords,
      status: block.status,
      turnCount: block.turnCount,
      createdAt: block.createdAt,
      updatedAt: block.updatedAt,
    };
  }

  /**
   * Get turns for a Bridge Block
   */
  async getTurns(ctx: QueryCtx, blockId: string): Promise<Turn[]> {
    const turns = await ctx.runQuery(this.component.bridgeBlocks.getTurns, { blockId });

    return turns.map((t: any) => ({
      turnId: t.turnId,
      userMessage: t.userMessage,
      aiResponse: t.aiResponse,
      timestamp: t.timestamp,
    }));
  }

  /**
   * Create a new Bridge Block manually
   */
  async createBlock(
    ctx: MutationCtx,
    args: {
      dayId: string;
      topicLabel: string;
      keywords: string[];
    }
  ): Promise<string> {
    return await ctx.runMutation(this.component.bridgeBlocks.create, args);
  }

  /**
   * Update Bridge Block status
   */
  async updateBlockStatus(
    ctx: MutationCtx,
    blockId: string,
    status: "ACTIVE" | "PAUSED" | "CLOSED"
  ): Promise<void> {
    await ctx.runMutation(this.component.bridgeBlocks.updateStatus, {
      blockId,
      status,
    });
  }

  // ==========================================================================
  // Advanced: Direct Governor Access
  // ==========================================================================

  /**
   * Run the Governor directly (for advanced use cases)
   *
   * This gives you low-level access to the Governor's routing,
   * memory retrieval, and fact lookup without generating a response.
   */
  async runGovernor(
    ctx: ActionCtx,
    args: {
      query: string;
      queryEmbedding: number[];
      dayId: string;
    }
  ): Promise<{
    routing: {
      matchedBlockId: string | null;
      isNewTopic: boolean;
      reasoning: string;
      suggestedLabel?: string;
    };
    memories: Array<{
      memoryId: string;
      content: string;
      score: number;
      turnId: string;
      blockId: string;
    }>;
    facts: Array<{
      key: string;
      value: string;
      category?: string;
    }>;
  }> {
    return await ctx.runAction(this.component.governor.govern, {
      ...args,
      openaiApiKey: this.config.OPENAI_API_KEY,
      governorModel: this.config.governorModel,
    });
  }

  /**
   * Route a query to a Bridge Block (without memory retrieval)
   */
  async route(
    ctx: ActionCtx,
    query: string,
    dayId: string
  ): Promise<{
    matchedBlockId: string | null;
    isNewTopic: boolean;
    reasoning: string;
    suggestedLabel?: string;
  }> {
    return await ctx.runAction(this.component.governor.route, {
      query,
      dayId,
      openaiApiKey: this.config.OPENAI_API_KEY,
      model: this.config.governorModel,
    });
  }

  // ==========================================================================
  // Synthesis - Daily/Weekly Pattern Aggregation
  // ==========================================================================

  /**
   * Get synthesis for a specific day
   */
  async getDaySynthesis(ctx: QueryCtx, dayId: string): Promise<DaySynthesis | null> {
    return await ctx.runQuery(this.component.synthesis.getDaySynthesis, { dayId });
  }

  /**
   * Get recent day syntheses
   */
  async getRecentSyntheses(ctx: QueryCtx, limit?: number): Promise<DaySynthesis[]> {
    return await ctx.runQuery(this.component.synthesis.getRecentSyntheses, { limit });
  }

  /**
   * Save a day synthesis
   */
  async saveDaySynthesis(
    ctx: MutationCtx,
    synthesis: Omit<DaySynthesis, "topicAffectMapping"> & { topicAffectMapping: string }
  ): Promise<string> {
    return await ctx.runMutation(this.component.synthesis.saveDaySynthesis, synthesis);
  }

  /**
   * Get synthesis context for LLM prompts
   */
  async getSynthesisContext(ctx: QueryCtx, maxTokens?: number): Promise<string> {
    return await ctx.runQuery(this.component.synthesis.getSynthesisContext, { maxTokens });
  }

  // ==========================================================================
  // Scribe - User Profile Extraction
  // ==========================================================================

  /**
   * Get all user projects
   */
  async getUserProjects(ctx: QueryCtx): Promise<UserProject[]> {
    return await ctx.runQuery(this.component.synthesis.getUserProjects, {});
  }

  /**
   * Get all user constraints
   */
  async getUserConstraints(ctx: QueryCtx): Promise<UserConstraint[]> {
    return await ctx.runQuery(this.component.synthesis.getUserConstraints, {});
  }

  /**
   * Add or update a user project
   */
  async upsertProject(ctx: MutationCtx, project: UserProject): Promise<string> {
    return await ctx.runMutation(this.component.synthesis.upsertProject, project);
  }

  /**
   * Add or update a user constraint
   */
  async upsertConstraint(ctx: MutationCtx, constraint: UserConstraint): Promise<string> {
    return await ctx.runMutation(this.component.synthesis.upsertConstraint, constraint);
  }

  /**
   * Get profile context for LLM prompts
   */
  async getProfileContext(ctx: QueryCtx, maxTokens?: number): Promise<string> {
    return await ctx.runQuery(this.component.synthesis.getProfileContext, { maxTokens });
  }

  // ==========================================================================
  // Planning - Multi-turn Planning Interviews
  // ==========================================================================

  /**
   * Create a new planning session
   */
  async createPlanningSession(ctx: MutationCtx, userQuery: string): Promise<string> {
    return await ctx.runMutation(this.component.planning.createSession, { userQuery });
  }

  /**
   * Get a planning session
   */
  async getPlanningSession(ctx: QueryCtx, sessionId: string): Promise<PlanningSession | null> {
    return await ctx.runQuery(this.component.planning.getSession, { sessionId });
  }

  /**
   * Get all active planning sessions
   */
  async getActivePlanningSessions(ctx: QueryCtx): Promise<PlanningSession[]> {
    return await ctx.runQuery(this.component.planning.getActiveSessions, {});
  }

  /**
   * Get all plans
   */
  async getPlans(ctx: QueryCtx, status?: "active" | "completed" | "paused"): Promise<Plan[]> {
    return await ctx.runQuery(this.component.planning.getPlans, { status });
  }

  /**
   * Get a plan with its items
   */
  async getPlanWithItems(ctx: QueryCtx, planId: string): Promise<Plan | null> {
    return await ctx.runQuery(this.component.planning.getPlanWithItems, { planId });
  }

  /**
   * Create a new plan
   */
  async createPlan(
    ctx: MutationCtx,
    plan: Omit<Plan, "planId" | "status" | "progressPercentage"> & { items: PlanItem[] }
  ): Promise<string> {
    return await ctx.runMutation(this.component.planning.createPlan, plan);
  }

  /**
   * Mark a plan item as completed
   */
  async completePlanItem(ctx: MutationCtx, itemId: string): Promise<string> {
    return await ctx.runMutation(this.component.planning.completePlanItem, { itemId });
  }

  // ==========================================================================
  // Debug - Turn-by-turn Logging
  // ==========================================================================

  /**
   * Get debug logs for a turn
   */
  async getDebugLogs(ctx: QueryCtx, turnId: string, category?: string): Promise<DebugLogEntry[]> {
    return await ctx.runQuery(this.component.debug.getDebugLogs, { turnId, category });
  }

  /**
   * Get a summary of a turn's debug info
   */
  async getTurnDebugSummary(ctx: QueryCtx, turnId: string): Promise<any> {
    return await ctx.runQuery(this.component.debug.getTurnSummary, { turnId });
  }

  /**
   * Get recent debug logs
   */
  async getRecentDebugLogs(ctx: QueryCtx, limit?: number): Promise<DebugLogEntry[]> {
    return await ctx.runQuery(this.component.debug.getRecentLogs, { limit });
  }

  /**
   * Get debug log statistics
   */
  async getDebugStats(ctx: QueryCtx): Promise<any> {
    return await ctx.runQuery(this.component.debug.getLogStats, {});
  }

  // ==========================================================================
  // Lineage - Provenance Tracking
  // ==========================================================================

  /**
   * Record lineage for an item
   */
  async recordLineage(
    ctx: MutationCtx,
    args: {
      itemId: string;
      itemType: "turn" | "fact" | "memory" | "block" | "summary" | "chunk";
      derivedFrom: string[];
      derivedBy: string;
    }
  ): Promise<string> {
    return await ctx.runMutation(this.component.lineage.recordLineage, args);
  }

  /**
   * Get lineage for an item
   */
  async getLineage(ctx: QueryCtx, itemId: string): Promise<LineageNode | null> {
    return await ctx.runQuery(this.component.lineage.getLineage, { itemId });
  }

  /**
   * Get ancestors of an item
   */
  async getAncestors(ctx: QueryCtx, itemId: string, maxDepth?: number): Promise<LineageNode[]> {
    return await ctx.runQuery(this.component.lineage.getAncestors, { itemId, maxDepth });
  }

  /**
   * Get descendants of an item
   */
  async getDescendants(ctx: QueryCtx, itemId: string, maxDepth?: number): Promise<LineageNode[]> {
    return await ctx.runQuery(this.component.lineage.getDescendants, { itemId, maxDepth });
  }

  /**
   * Validate lineage integrity
   */
  async validateLineageIntegrity(ctx: QueryCtx): Promise<{
    valid: boolean;
    orphanedItems: string[];
    brokenReferences: Array<{ itemId: string; missingRef: string }>;
  }> {
    return await ctx.runQuery(this.component.lineage.validateIntegrity, {});
  }

  // ==========================================================================
  // Usage - Memory Utilization Tracking
  // ==========================================================================

  /**
   * Mark an item as used
   */
  async markUsed(
    ctx: MutationCtx,
    itemId: string,
    itemType: string,
    topics?: string[]
  ): Promise<string> {
    return await ctx.runMutation(this.component.usage.markUsed, { itemId, itemType, topics });
  }

  /**
   * Get usage stats for an item
   */
  async getUsage(ctx: QueryCtx, itemId: string): Promise<UsageStats | null> {
    return await ctx.runQuery(this.component.usage.getUsage, { itemId });
  }

  /**
   * Get most used items
   */
  async getMostUsed(ctx: QueryCtx, limit?: number): Promise<UsageStats[]> {
    return await ctx.runQuery(this.component.usage.getMostUsed, { limit });
  }

  /**
   * Analyze usage patterns
   */
  async analyzeUsage(ctx: QueryCtx): Promise<{
    totalItems: number;
    activeItems: number;
    unusedItems: number;
    overUtilized: string[];
    underUtilized: string[];
    avgUsageCount: number;
  }> {
    return await ctx.runQuery(this.component.usage.analyzeUsage, {});
  }

  // ==========================================================================
  // Retrieval - Context Hydration and Search
  // ==========================================================================

  /**
   * Hydrate context for a block (build LLM prompt)
   */
  async hydrateContext(
    ctx: QueryCtx,
    args: {
      blockId: string;
      memoryIds: string[];
      factKeys: string[];
      maxTokens?: number;
    }
  ): Promise<{
    prompt: string;
    tokenBreakdown: {
      system: number;
      conversation: number;
      memories: number;
      facts: number;
      profile: number;
    };
    totalTokens: number;
  }> {
    return await ctx.runQuery(this.component.retrieval.hydrateContext, args);
  }

  /**
   * Get token statistics for a block
   */
  async getTokenStats(
    ctx: QueryCtx,
    blockId: string
  ): Promise<{
    turnCount: number;
    totalCharacters: number;
    estimatedTokens: number;
  }> {
    return await ctx.runQuery(this.component.retrieval.getTokenStats, { blockId });
  }

  /**
   * Search memories by keywords
   */
  async searchMemoriesByKeywords(
    ctx: QueryCtx,
    keywords: string[],
    options?: { blockId?: string; limit?: number }
  ): Promise<
    Array<{
      turnId: string;
      blockId: string;
      content: string;
      score: number;
      matchedKeywords: string[];
    }>
  > {
    return await ctx.runQuery(this.component.retrieval.searchMemories, {
      keywords,
      ...options,
    });
  }

  /**
   * Search chunks by keywords
   */
  async searchChunksByKeywords(
    ctx: QueryCtx,
    keywords: string[],
    options?: {
      blockId?: string;
      chunkType?: "sentence" | "paragraph";
      limit?: number;
    }
  ): Promise<
    Array<{
      chunkId: string;
      chunkType: string;
      turnId: string;
      blockId: string;
      content: string;
      score: number;
      matchedKeywords: string[];
    }>
  > {
    return await ctx.runQuery(this.component.retrieval.searchChunks, {
      keywords,
      ...options,
    });
  }

  /**
   * Search facts by keywords
   */
  async searchFactsByKeywords(
    ctx: QueryCtx,
    keywords: string[],
    options?: { category?: string; limit?: number }
  ): Promise<
    Array<{
      key: string;
      value: string;
      category?: string;
      score: number;
    }>
  > {
    return await ctx.runQuery(this.component.retrieval.searchFacts, {
      keywords,
      ...options,
    });
  }
}


