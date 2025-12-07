/**
 * Metadata Extractor - Parses dual-mode LLM responses
 *
 * Ported from Python: memory/metadata_extractor.py
 *
 * Responsibilities:
 * - Parses structured metadata from LLM responses
 * - Extracts keywords, summaries, affect
 * - Handles fallback if LLM doesn't follow format
 * - Validates and cleans extracted data
 */

// ============================================================================
// Types
// ============================================================================

export interface ParsedResponse {
  userReply: string;
  metadata: ExtractedMetadata;
}

export interface ExtractedMetadata {
  keywords: string[];
  summary: string;
  affect: string;
  topics: string[];
  parsingMethod: "structured" | "fallback" | "none";
}

export interface NanoMetadata {
  topics: string[];
  isTopicShift: boolean;
  newTopicLabel?: string;
  affect: string;
  keywords: string[];
}

// ============================================================================
// Constants
// ============================================================================

const VALID_AFFECT_LABELS = new Set([
  "neutral",
  "positive",
  "negative",
  "frustrated",
  "curious",
  "excited",
  "confused",
  "satisfied",
  "impatient",
  "engaged",
  "bored",
  "enthusiastic",
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "and", "or", "but",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "i",
  "you", "we", "they", "it", "this", "that", "what", "how", "why",
  "when", "where", "can", "could", "would", "should", "do", "does",
  "did", "have", "has", "had", "be", "been", "being", "my", "your",
  "me", "about", "help", "want", "need", "please", "tell", "know",
]);

// ============================================================================
// Delimiter Constants
// ============================================================================

const USER_REPLY_START = "==USER_REPLY_START==";
const USER_REPLY_END = "==USER_REPLY_END==";
const METADATA_START = "==METADATA_START==";
const METADATA_END = "==METADATA_END==";

// ============================================================================
// Core Extraction Functions
// ============================================================================

export function parseResponse(
  llmResponse: string,
  fallbackToSimple: boolean = true
): ParsedResponse {
  // Try structured extraction first
  const userReply = extractBetween(llmResponse, USER_REPLY_START, USER_REPLY_END);
  const metadataBlock = extractBetween(llmResponse, METADATA_START, METADATA_END);

  if (userReply && metadataBlock) {
    const metadata = parseMetadataFields(metadataBlock);
    metadata.parsingMethod = "structured";
    return { userReply: userReply.trim(), metadata };
  }

  // Fallback to simple extraction
  if (fallbackToSimple) {
    const metadata = simpleExtraction(llmResponse);
    metadata.parsingMethod = "fallback";
    return { userReply: llmResponse.trim(), metadata };
  }

  // No extraction
  return {
    userReply: llmResponse.trim(),
    metadata: {
      keywords: [],
      summary: "",
      affect: "neutral",
      topics: [],
      parsingMethod: "none",
    },
  };
}

function extractBetween(
  text: string,
  startDelimiter: string,
  endDelimiter: string
): string | null {
  const startIdx = text.indexOf(startDelimiter);
  const endIdx = text.indexOf(endDelimiter);

  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    return null;
  }

  return text.slice(startIdx + startDelimiter.length, endIdx).trim();
}

function parseMetadataFields(metadataBlock: string): ExtractedMetadata {
  const lines = metadataBlock.split("\n").map((l) => l.trim());
  const result: ExtractedMetadata = {
    keywords: [],
    summary: "",
    affect: "neutral",
    topics: [],
    parsingMethod: "structured",
  };

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim().toUpperCase();
    const value = line.slice(colonIdx + 1).trim();

    switch (key) {
      case "KEYWORDS":
        result.keywords = value
          .split(",")
          .map((k) => k.trim().toLowerCase())
          .filter((k) => k.length > 0);
        break;
      case "SUMMARY":
        result.summary = value;
        break;
      case "AFFECT":
        const affect = value.toLowerCase();
        result.affect = VALID_AFFECT_LABELS.has(affect) ? affect : "neutral";
        break;
      case "TOPICS":
        result.topics = value
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        break;
    }
  }

  return result;
}

function simpleExtraction(text: string): ExtractedMetadata {
  // Extract keywords using simple word frequency
  const keywords = extractKeywordsFromText(text);

  // Generate simple summary (first sentence or first 100 chars)
  const firstSentence = text.split(/[.!?]/)[0] || text;
  const summary =
    firstSentence.length > 100
      ? firstSentence.slice(0, 100) + "..."
      : firstSentence;

  // Detect affect from text patterns
  const affect = detectAffect(text);

  // Extract topics (same as keywords for simple extraction)
  const topics = keywords.slice(0, 3);

  return {
    keywords,
    summary,
    affect,
    topics,
    parsingMethod: "fallback",
  };
}

export function extractKeywordsFromText(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Count word frequencies
  const wordCounts = new Map<string, number>();
  for (const word of words) {
    wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
  }

  // Sort by frequency and return top N
  return Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

function detectAffect(text: string): string {
  const lower = text.toLowerCase();

  // Simple pattern matching for affect
  if (/\b(frustrated|annoyed|angry|upset)\b/.test(lower)) return "frustrated";
  if (/\b(curious|wondering|interested)\b/.test(lower)) return "curious";
  if (/\b(excited|amazing|awesome|great)\b/.test(lower)) return "excited";
  if (/\b(confused|unclear|don't understand)\b/.test(lower)) return "confused";
  if (/\b(thank|thanks|appreciate|helpful)\b/.test(lower)) return "satisfied";
  if (/\b(happy|glad|pleased)\b/.test(lower)) return "positive";
  if (/\b(sad|disappointed|sorry)\b/.test(lower)) return "negative";

  return "neutral";
}

// ============================================================================
// Nano Metadata Extraction (for cheap/fast LLM calls)
// ============================================================================

export function parseNanoMetadata(llmResponse: string): NanoMetadata {
  // Try to parse JSON from response
  const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        topics: parsed.topics || [],
        isTopicShift: parsed.isTopicShift || parsed.is_topic_shift || false,
        newTopicLabel: parsed.newTopicLabel || parsed.new_topic_label,
        affect: parsed.affect || "neutral",
        keywords: parsed.keywords || [],
      };
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback extraction
  return {
    topics: extractKeywordsFromText(llmResponse).slice(0, 3),
    isTopicShift: false,
    affect: detectAffect(llmResponse),
    keywords: extractKeywordsFromText(llmResponse),
  };
}

// ============================================================================
// Metadata Prompt Builder
// ============================================================================

export function buildMetadataPrompt(): string {
  return `After your response, include metadata in this exact format:

==METADATA_START==
KEYWORDS: keyword1, keyword2, keyword3
SUMMARY: One-line summary of this conversation turn
AFFECT: neutral|positive|negative|frustrated|curious|excited|confused|satisfied
TOPICS: topic1, topic2
==METADATA_END==`;
}

export function buildNanoPrompt(query: string, currentTopics: string[]): string {
  return `Analyze this user message and return JSON:
{
  "topics": ["topic1", "topic2"],
  "isTopicShift": true/false,
  "newTopicLabel": "New Topic Name" or null,
  "affect": "curious/frustrated/excited/neutral/etc",
  "keywords": ["keyword1", "keyword2"]
}

Current context topics: ${currentTopics.join(", ") || "None"}

User message: "${query}"

Return ONLY valid JSON.`;
}

// ============================================================================
// Validation
// ============================================================================

export function validateMetadata(metadata: ExtractedMetadata): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  if (metadata.keywords.length === 0) {
    issues.push("No keywords extracted");
  }

  if (!metadata.summary) {
    issues.push("No summary generated");
  }

  if (!VALID_AFFECT_LABELS.has(metadata.affect)) {
    issues.push(`Invalid affect label: ${metadata.affect}`);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

// ============================================================================
// Full Metadata Schema Parsing
// Python: metadata_extractor.py MetadataExtractor.parse_full_schema()
// ============================================================================

/**
 * Full metadata schema with all optional fields
 * Used for rich block/turn metadata
 */
export interface FullMetadataSchema {
  // Core fields (always present)
  topics: string[];
  keywords: string[];
  summary: string;
  affect: string;

  // Topic shift detection
  isTopicShift: boolean;
  newTopicLabel: string | null;
  topicConfidence: number;

  // Temporal markers
  temporalReferences: Array<{
    type: "absolute" | "relative" | "duration";
    value: string;
    normalized?: string; // ISO date if parseable
  }>;

  // Entity extraction
  entities: Array<{
    name: string;
    type: "person" | "organization" | "location" | "concept" | "product" | "event";
    mentions: number;
  }>;

  // Sentiment analysis
  sentiment: {
    polarity: number; // -1 to 1
    subjectivity: number; // 0 to 1
    emotions: string[];
  };

  // Intent signals
  intent: {
    primary: "informational" | "transactional" | "navigational" | "conversational";
    secondary: string[];
    urgency: "low" | "medium" | "high";
  };

  // Relevance scoring
  relevance: {
    toCurrentTopic: number; // 0 to 1
    toUserProfile: number; // 0 to 1
    recencyBoost: number; // multiplier
  };
}

/**
 * Parse full metadata schema from LLM response
 */
export function parseFullMetadataSchema(
  llmResponse: string,
  defaults?: Partial<FullMetadataSchema>
): FullMetadataSchema {
  const defaultSchema: FullMetadataSchema = {
    topics: [],
    keywords: [],
    summary: "",
    affect: "neutral",
    isTopicShift: false,
    newTopicLabel: null,
    topicConfidence: 0.5,
    temporalReferences: [],
    entities: [],
    sentiment: {
      polarity: 0,
      subjectivity: 0.5,
      emotions: ["neutral"],
    },
    intent: {
      primary: "conversational",
      secondary: [],
      urgency: "low",
    },
    relevance: {
      toCurrentTopic: 0.5,
      toUserProfile: 0.5,
      recencyBoost: 1.0,
    },
    ...defaults,
  };

  try {
    // Extract JSON from response
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return defaultSchema;

    const parsed = JSON.parse(jsonMatch[0]);

    // Merge with defaults, validating each field
    return {
      topics: validateArray(parsed.topics, defaultSchema.topics),
      keywords: validateArray(parsed.keywords, defaultSchema.keywords),
      summary: validateString(parsed.summary, defaultSchema.summary),
      affect: validateAffect(parsed.affect, defaultSchema.affect),
      isTopicShift: validateBoolean(parsed.isTopicShift, defaultSchema.isTopicShift),
      newTopicLabel: parsed.newTopicLabel ?? defaultSchema.newTopicLabel,
      topicConfidence: validateNumber(parsed.topicConfidence, 0, 1, defaultSchema.topicConfidence),
      temporalReferences: validateTemporalRefs(parsed.temporalReferences, defaultSchema.temporalReferences),
      entities: validateEntities(parsed.entities, defaultSchema.entities),
      sentiment: validateSentiment(parsed.sentiment, defaultSchema.sentiment),
      intent: validateIntent(parsed.intent, defaultSchema.intent),
      relevance: validateRelevance(parsed.relevance, defaultSchema.relevance),
    };
  } catch {
    return defaultSchema;
  }
}

// Validation helpers
function validateArray(value: unknown, defaultVal: string[]): string[] {
  if (!Array.isArray(value)) return defaultVal;
  return value.filter((v) => typeof v === "string");
}

function validateString(value: unknown, defaultVal: string): string {
  return typeof value === "string" ? value : defaultVal;
}

function validateBoolean(value: unknown, defaultVal: boolean): boolean {
  return typeof value === "boolean" ? value : defaultVal;
}

function validateNumber(value: unknown, min: number, max: number, defaultVal: number): number {
  if (typeof value !== "number") return defaultVal;
  return Math.max(min, Math.min(max, value));
}

function validateAffect(value: unknown, defaultVal: string): string {
  if (typeof value !== "string") return defaultVal;
  return VALID_AFFECT_LABELS.has(value) ? value : defaultVal;
}

function validateTemporalRefs(
  value: unknown,
  defaultVal: FullMetadataSchema["temporalReferences"]
): FullMetadataSchema["temporalReferences"] {
  if (!Array.isArray(value)) return defaultVal;
  return value
    .filter((v) => v && typeof v === "object")
    .map((v) => ({
      type: ["absolute", "relative", "duration"].includes(v.type) ? v.type : "relative",
      value: typeof v.value === "string" ? v.value : "",
      normalized: v.normalized,
    }));
}

function validateEntities(
  value: unknown,
  defaultVal: FullMetadataSchema["entities"]
): FullMetadataSchema["entities"] {
  if (!Array.isArray(value)) return defaultVal;
  const validTypes = ["person", "organization", "location", "concept", "product", "event"];
  return value
    .filter((v) => v && typeof v === "object" && typeof v.name === "string")
    .map((v) => ({
      name: v.name,
      type: validTypes.includes(v.type) ? v.type : "concept",
      mentions: typeof v.mentions === "number" ? v.mentions : 1,
    }));
}

function validateSentiment(
  value: unknown,
  defaultVal: FullMetadataSchema["sentiment"]
): FullMetadataSchema["sentiment"] {
  if (!value || typeof value !== "object") return defaultVal;
  const v = value as Record<string, unknown>;
  return {
    polarity: validateNumber(v.polarity, -1, 1, defaultVal.polarity),
    subjectivity: validateNumber(v.subjectivity, 0, 1, defaultVal.subjectivity),
    emotions: validateArray(v.emotions, defaultVal.emotions),
  };
}

function validateIntent(
  value: unknown,
  defaultVal: FullMetadataSchema["intent"]
): FullMetadataSchema["intent"] {
  if (!value || typeof value !== "object") return defaultVal;
  const v = value as Record<string, unknown>;
  const validPrimary = ["informational", "transactional", "navigational", "conversational"];
  const validUrgency = ["low", "medium", "high"];
  return {
    primary: validPrimary.includes(v.primary as string) ? (v.primary as any) : defaultVal.primary,
    secondary: validateArray(v.secondary, defaultVal.secondary),
    urgency: validUrgency.includes(v.urgency as string) ? (v.urgency as any) : defaultVal.urgency,
  };
}

function validateRelevance(
  value: unknown,
  defaultVal: FullMetadataSchema["relevance"]
): FullMetadataSchema["relevance"] {
  if (!value || typeof value !== "object") return defaultVal;
  const v = value as Record<string, unknown>;
  return {
    toCurrentTopic: validateNumber(v.toCurrentTopic, 0, 1, defaultVal.toCurrentTopic),
    toUserProfile: validateNumber(v.toUserProfile, 0, 1, defaultVal.toUserProfile),
    recencyBoost: validateNumber(v.recencyBoost, 0.1, 10, defaultVal.recencyBoost),
  };
}

/**
 * Generate prompt for full metadata extraction
 */
export function buildFullMetadataPrompt(
  userMessage: string,
  aiResponse: string,
  context: {
    currentTopics?: string[];
    userProfile?: Record<string, unknown>;
    recentEntities?: string[];
  }
): string {
  return `Extract comprehensive metadata from this conversation turn.

User: "${userMessage}"
Assistant: "${aiResponse}"

Current context:
- Topics: ${context.currentTopics?.join(", ") || "None"}
- Recent entities: ${context.recentEntities?.join(", ") || "None"}

Return JSON with this schema:
{
  "topics": ["topic1", "topic2"],
  "keywords": ["kw1", "kw2", "kw3"],
  "summary": "Brief 1-sentence summary",
  "affect": "neutral|curious|frustrated|excited|confused|satisfied",
  "isTopicShift": true/false,
  "newTopicLabel": "New Topic" or null,
  "topicConfidence": 0.0-1.0,
  "temporalReferences": [{"type": "relative", "value": "yesterday"}],
  "entities": [{"name": "Entity", "type": "person|org|location|concept|product|event", "mentions": 1}],
  "sentiment": {"polarity": -1.0 to 1.0, "subjectivity": 0.0-1.0, "emotions": ["neutral"]},
  "intent": {"primary": "informational|transactional|navigational|conversational", "secondary": [], "urgency": "low|medium|high"},
  "relevance": {"toCurrentTopic": 0.0-1.0, "toUserProfile": 0.0-1.0, "recencyBoost": 1.0}
}

Return ONLY valid JSON.`;
}
