/**
 * HMLR End-to-End Integration Tests
 *
 * Tests all modules working together as a complete memory layer:
 * 1. Schema & Data Layer
 * 2. Retrieval Pipeline
 * 3. Adaptive System
 * 4. Governor & Routing
 * 5. Lineage & Debug
 * 6. Full Chat Flow
 */

import { expect, test, describe } from "vitest";

// Import pure functions for unit testing
import {
  analyzeIntent,
  analyzeWithPlanContext,
  type ActivePlan,
} from "./retrieval/intentAnalyzer";
import {
  allocateTokenBudget,
  reallocateUnusedBudget,
  estimateTokens,
} from "./retrieval/hydrator";
import {
  decideCompression,
  decideCompressionWithEmbeddings,
  cosineSimilarity,
  calcSemanticDistanceWithEmbeddings,
} from "./adaptive/index";
import {
  checkForShift,
  detectExplicitShift,
  extractTopicsFromQuery,
} from "./tabulaRasa";
import {
  parseResponse,
  validateMetadata,
  parseFullMetadataSchema,
  extractKeywordsFromText,
} from "./retrieval/metadataExtractor";
import {
  chunkText,
  splitIntoSentences,
  splitIntoParagraphs,
  estimateTokenCount,
} from "./chunking/index";

// ============================================================================
// 1. INTENT ANALYSIS TESTS
// ============================================================================

describe("Intent Analysis", () => {
  test("analyzes recall query correctly", () => {
    const intent = analyzeIntent("What did we discuss about contracts yesterday?");
    expect(intent.queryType).toBe("recall");
    expect(intent.keywords).toContain("contracts");
    expect(intent.isQuestion).toBe(true);
  });

  test("analyzes planning query correctly", () => {
    const intent = analyzeIntent("Help me create a workout schedule for next week");
    expect(intent.queryType).toBe("planning");
    expect(intent.hasPlanningIntent).toBe(true);
  });

  test("analyzes general query correctly", () => {
    const intent = analyzeIntent("Tell me about machine learning");
    expect(intent.queryType).toBe("general");
  });

  test("detects time references", () => {
    const intent = analyzeIntent("What did we discuss yesterday?");
    expect(intent.timeRange).toBeDefined();
  });

  test("extracts entities", () => {
    const intent = analyzeIntent("Tell me about the Smith case and Johnson contract");
    expect(intent.entities.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 2. RETRIEVAL PIPELINE TESTS
// ============================================================================

describe("Retrieval Pipeline", () => {
  test("intent analyzer extracts keywords and classifies query", () => {
    // Test recall query
    const recallIntent = analyzeIntent("What did we discuss about contracts yesterday?");
    expect(recallIntent.queryType).toBe("recall");
    expect(recallIntent.keywords).toContain("contracts");
    expect(recallIntent.isQuestion).toBe(true);

    // Test planning query
    const planIntent = analyzeIntent("Help me create a workout schedule for next week");
    expect(planIntent.queryType).toBe("planning");
    expect(planIntent.hasPlanningIntent).toBe(true);

    // Test general query
    const generalIntent = analyzeIntent("Tell me about machine learning");
    expect(generalIntent.queryType).toBe("general");
  });

  test("intent analyzer works with plan context", () => {
    const activePlans: ActivePlan[] = [{
      planId: "plan-001",
      title: "Weekly Workout Plan",
      topic: "fitness",
      items: [
        { date: new Date().toISOString().split("T")[0], task: "Morning run", durationMinutes: 30, completed: false },
        { date: new Date().toISOString().split("T")[0], task: "Strength training", durationMinutes: 45, completed: false },
      ],
    }];

    const intent = analyzeWithPlanContext("What should I do today?", activePlans);
    expect(intent.primaryTopics).toContain("fitness");
    expect(intent.hasPlanningIntent).toBe(true);
  });

  test("hydrator builds context with token budget", () => {
    // Test budget allocation with correct function signature
    const allocation = allocateTokenBudget(4000, 500, 500);

    expect(allocation.facts).toBeGreaterThan(0);
    expect(allocation.memories).toBeGreaterThan(0);
    expect(allocation.bridgeBlock).toBeGreaterThan(0);
    expect(allocation.system).toBe(500);
    expect(allocation.tasks).toBe(500);
    expect(allocation.total).toBeLessThanOrEqual(4000);
  });

  test("token estimation works correctly", () => {
    const text = "This is a test sentence with several words in it.";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length); // Tokens < chars
  });
});

// ============================================================================
// 3. ADAPTIVE SYSTEM TESTS
// ============================================================================

describe("Adaptive System", () => {
  test("cosine similarity calculates correctly", () => {
    const vec1 = [1, 0, 0];
    const vec2 = [1, 0, 0];
    const vec3 = [0, 1, 0];

    expect(cosineSimilarity(vec1, vec2)).toBeCloseTo(1.0);
    expect(cosineSimilarity(vec1, vec3)).toBeCloseTo(0.0);
  });

  test("semantic distance with embeddings works", () => {
    const queryEmb = Array(384).fill(0).map((_, i) => Math.sin(i * 0.1));
    const contextEmbs = [
      Array(384).fill(0).map((_, i) => Math.sin(i * 0.1)), // Similar
      Array(384).fill(0).map((_, i) => Math.cos(i * 0.1)), // Different
    ];

    const distance = calcSemanticDistanceWithEmbeddings(queryEmb, contextEmbs);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(1);
  });

  test("compression decision based on semantic distance", () => {
    const decision = decideCompression(
      "What about taxes?",
      ["We discussed contracts yesterday", "The meeting was productive"],
      Date.now() - 2 * 60 * 60 * 1000 // 2 hours ago
    );

    expect(decision.level).toBeDefined();
    expect(decision.reason).toBeDefined();
    expect(decision.semanticDistance).toBeGreaterThanOrEqual(0);
  });

  test("compression with explicit reference detection", () => {
    const decisionWithRef = decideCompression(
      "As we discussed earlier, what about the contract?",
      ["Contract terms were outlined"],
      Date.now() - 1 * 60 * 60 * 1000
    );

    // Explicit reference should prevent compression
    expect(decisionWithRef.hasExplicitReference).toBe(true);
    expect(decisionWithRef.level).toBe("NO_COMPRESSION");
  });

  test("embedding-based compression decision", () => {
    const queryEmb = Array(384).fill(0).map((_, i) => Math.sin(i * 0.1));
    const recentEmbs = [
      Array(384).fill(0).map((_, i) => Math.sin(i * 0.1 + 0.5)), // Somewhat similar
    ];

    const decision = decideCompressionWithEmbeddings(
      "Related topic question",
      ["Previous discussion"],
      Date.now() - 30 * 60 * 1000, // 30 min ago
      queryEmb,
      recentEmbs
    );

    expect(decision.level).toBeDefined();
    expect(decision.reason).toContain("embedding");
  });
});

// ============================================================================
// 4. GOVERNOR & ROUTING TESTS
// ============================================================================

describe("Governor & Routing", () => {
  test("topic shift detection with continuation phrase", () => {
    // Test with continuation phrase which should prevent shift
    const noShift = checkForShift(
      "So tell me more about the contract details",
      ["contract", "law", "agreement"]
    );
    expect(noShift.isShift).toBe(false);
    expect(noShift.reason).toContain("Continuation");
  });

  test("topic shift detection with different topics", () => {
    const hasShift = checkForShift(
      "What's the weather like today?",
      ["contract", "law", "agreement"]
    );
    expect(hasShift.isShift).toBe(true);
    expect(hasShift.confidence).toBeGreaterThan(0.5);
  });

  test("explicit shift phrase detection", () => {
    const explicit = detectExplicitShift("Let's talk about cooking instead");
    expect(explicit.isShift).toBe(true);
    expect(explicit.topic).toBe("cooking");
  });

  test("topic extraction from query", () => {
    const topics = extractTopicsFromQuery("I need help with my contract dispute");
    expect(topics).toContain("contract");
    expect(topics).toContain("dispute");
    expect(topics.length).toBeLessThanOrEqual(5);
  });

  test("new conversation starts new block", () => {
    const result = checkForShift("Hello, I need help with something", []);
    expect(result.isShift).toBe(true);
    expect(result.reason).toContain("No active topic");
  });
});

// ============================================================================
// 5. METADATA EXTRACTION TESTS
// ============================================================================

describe("Metadata Extraction", () => {
  test("extracts keywords from text", () => {
    const keywords = extractKeywordsFromText("I need help with my contract dispute case");
    expect(keywords).toContain("contract");
    expect(keywords).toContain("dispute");
    expect(keywords).not.toContain("with"); // Stop word
  });

  test("validates metadata correctly", () => {
    const validMetadata = {
      keywords: ["contract", "law"],
      summary: "Discussion about contract law",
      affect: "neutral",
      topics: ["legal"],
      parsingMethod: "structured" as const,
    };

    const validation = validateMetadata(validMetadata);
    expect(validation.valid).toBe(true);
    expect(validation.issues.length).toBe(0);
  });

  test("validates metadata catches invalid affect", () => {
    const invalidMetadata = {
      keywords: ["test"],
      summary: "Test summary",
      affect: "invalid_affect_label",
      topics: [],
      parsingMethod: "fallback" as const,
    };

    const validation = validateMetadata(invalidMetadata);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toContain("Invalid affect label: invalid_affect_label");
  });

  test("parses full metadata schema", () => {
    const llmResponse = `{
      "topics": ["contract", "deadline"],
      "keywords": ["frustrated", "deadline"],
      "summary": "User concerned about contract deadline",
      "affect": "frustrated",
      "isTopicShift": false,
      "topicConfidence": 0.85,
      "sentiment": {"polarity": -0.3, "subjectivity": 0.7, "emotions": ["frustrated"]},
      "intent": {"primary": "informational", "secondary": [], "urgency": "high"}
    }`;

    const parsed = parseFullMetadataSchema(llmResponse);
    expect(parsed.topics).toContain("contract");
    expect(parsed.affect).toBe("frustrated");
    expect(parsed.sentiment.polarity).toBeLessThan(0);
  });

  test("handles malformed metadata gracefully", () => {
    const malformed = "This is not JSON";
    const result = parseFullMetadataSchema(malformed);

    expect(result.topics).toEqual([]);
    expect(result.affect).toBe("neutral");
  });
});

// ============================================================================
// 6. CHUNKING SYSTEM TESTS
// ============================================================================

describe("Chunking System", () => {
  test("splits text into sentences", () => {
    const text = "First sentence. Second sentence! Third sentence? Fourth.";
    const sentences = splitIntoSentences(text);
    expect(sentences.length).toBe(4);
    expect(sentences[0]).toContain("First");
  });

  test("splits text into paragraphs", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird.";
    const paragraphs = splitIntoParagraphs(text);
    expect(paragraphs.length).toBe(3);
  });

  test("estimates token count", () => {
    const text = "This is a test sentence with some words.";
    const tokens = estimateTokenCount(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length);
  });

  test("chunks text with turn ID", () => {
    const text = "First sentence about contracts. Second about liability. Third about damages.";
    const chunks = chunkText(text, "turn-001");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].turnId).toBe("turn-001");
    expect(chunks[0].textVerbatim).toBeDefined();
    expect(chunks[0].chunkType).toBeDefined();
  });
});

// ============================================================================
// 7. MODULE HANDOFF TESTS (Pure Function Flow)
// ============================================================================

describe("Module Handoffs", () => {
  test("Intent -> Topic Shift Detection flow", () => {
    const query = "Let's discuss something completely different - cooking recipes";

    // Step 1: Intent Analysis
    const intent = analyzeIntent(query);
    expect(intent.keywords.length).toBeGreaterThan(0);

    // Step 2: Topic Shift Detection
    const shift = checkForShift(query, ["contract", "law"]);
    expect(shift.isShift).toBe(true);
    expect(shift.newTopicLabel).toBeDefined();
  });

  test("Query -> Compression Decision flow", () => {
    // Use query with explicit reference phrase
    const query = "As we discussed earlier, what about the contract?";
    const recentQueries = ["We talked about contracts", "The agreement was signed"];

    // Step 1: Analyze intent
    const intent = analyzeIntent(query);
    expect(intent.queryType).toBe("recall");

    // Step 2: Decide compression based on intent
    const decision = decideCompression(
      query,
      recentQueries,
      Date.now() - 30 * 60 * 1000
    );

    // Explicit reference should prevent compression
    expect(decision.hasExplicitReference).toBe(true);
    expect(decision.level).toBe("NO_COMPRESSION");
  });

  test("Token Budget -> Context Selection flow", () => {
    // Allocate budget with correct signature
    const budget = allocateTokenBudget(4000, 500, 500);

    // Simulate turns with token counts
    const mockTurns = [
      { id: 1, tokens: 100 },
      { id: 2, tokens: 150 },
      { id: 3, tokens: 200 },
      { id: 4, tokens: 300 },
      { id: 5, tokens: 250 },
    ];

    // Select turns within budget (using bridgeBlock allocation)
    let usedTokens = 0;
    const selectedIds: number[] = [];

    for (const turn of mockTurns) {
      if (usedTokens + turn.tokens <= budget.bridgeBlock) {
        selectedIds.push(turn.id);
        usedTokens += turn.tokens;
      }
    }

    expect(selectedIds.length).toBeGreaterThan(0);
    expect(usedTokens).toBeLessThanOrEqual(budget.bridgeBlock);
  });

  test("Plan Context -> Intent Enhancement flow", () => {
    const activePlans: ActivePlan[] = [{
      planId: "plan-001",
      title: "Contract Review Project",
      topic: "legal",
      items: [
        { date: new Date().toISOString().split("T")[0], task: "Review clause 5", durationMinutes: 60, completed: false },
      ],
    }];

    // Basic query
    const query = "What should I work on?";

    // Enhanced with plan context
    const enhancedIntent = analyzeWithPlanContext(query, activePlans);

    // Should include plan topic
    expect(enhancedIntent.primaryTopics).toContain("legal");
    expect(enhancedIntent.hasPlanningIntent).toBe(true);
  });
});

// ============================================================================
// 8. HYBRID SEARCH TESTS
// ============================================================================

describe("Hybrid Search", () => {
  test("extracts search terms from query", async () => {
    const { extractSearchTerms } = await import("./retrieval/hybridSearch");

    const terms = extractSearchTerms("What did we discuss about contract liability?");
    expect(terms).toContain("contract");
    expect(terms).toContain("liability");
    expect(terms.length).toBeGreaterThan(0);
  });

  test("combines vector and lexical scores", async () => {
    const { combineScores } = await import("./retrieval/hybridSearch");

    const vectorScore = 0.8;
    const lexicalScore = 0.6;
    // combineScores takes options object with vectorWeight/lexicalWeight
    const combined = combineScores(vectorScore, lexicalScore, {
      vectorWeight: 0.7,
      lexicalWeight: 0.3,
      minScore: 0.3,
      topK: 10,
    });

    expect(combined).toBeGreaterThan(0);
    expect(combined).toBeLessThanOrEqual(1);
  });

  test("calculates lexical score correctly", async () => {
    const { calculateLexicalScore } = await import("./retrieval/hybridSearch");

    const content = "This document discusses contract law and liability issues";
    const searchTerms = ["contract", "liability"];

    const result = calculateLexicalScore(content, searchTerms);
    expect(result.score).toBeGreaterThan(0);
    expect(result.matchedTerms.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 9. HYDRATOR CONTEXT BUILDING TESTS
// ============================================================================

describe("Hydrator Context Building", () => {
  test("formats turn correctly", async () => {
    const { formatTurn } = await import("./retrieval/hydrator");

    const mockTurn = {
      userMessage: "What is contract law?",
      aiResponse: "Contract law governs agreements between parties.",
      timestamp: Date.now(),
    };

    const formatted = formatTurn(mockTurn);
    expect(formatted).toContain("User:");
    expect(formatted).toContain("Assistant:");
    expect(formatted).toContain("contract law");
  });

  test("formats fact correctly", async () => {
    const { formatFact } = await import("./retrieval/hydrator");

    const mockFact = {
      key: "client_email",
      value: "client@example.com",
      category: "contact",
    };

    const formatted = formatFact(mockFact);
    expect(formatted).toContain("client_email");
    expect(formatted).toContain("client@example.com");
  });

  test("truncates text to token limit", async () => {
    const { truncateToTokens } = await import("./retrieval/hydrator");

    const longText = "word ".repeat(500); // ~500 words
    const truncated = truncateToTokens(longText, 100);

    const estimatedTokens = truncated.split(/\s+/).length;
    expect(estimatedTokens).toBeLessThanOrEqual(120); // Some margin
  });
});
