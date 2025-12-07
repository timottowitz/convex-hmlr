/**
 * Intent Analyzer - Extracts keywords and classifies user queries
 *
 * Ported from Python: memory/retrieval/intent_analyzer.py
 *
 * Responsibilities:
 * - Extract keywords from user query
 * - Classify query type (recall, task, general)
 * - Detect time references
 * - Identify topic/entity mentions
 */

// ============================================================================
// Types
// ============================================================================

export type QueryType = "recall" | "task" | "general" | "planning";

export interface Intent {
  keywords: string[];
  queryType: QueryType;
  confidence: number;
  primaryTopics: string[];
  timeRange?: {
    start: string;
    end: string;
  };
  entities: string[];
  isQuestion: boolean;
  hasPlanningIntent: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "up", "about", "into", "through", "during",
  "before", "after", "above", "below", "between", "under", "again", "further",
  "then", "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not",
  "only", "own", "same", "so", "than", "too", "very", "can", "will", "just",
  "should", "now", "is", "was", "are", "were", "be", "been", "being", "have",
  "has", "had", "do", "does", "did", "i", "you", "he", "she", "it", "we", "they",
  "what", "which", "who", "this", "that", "these", "those", "am", "me", "my",
  "your", "his", "her", "its", "our", "their",
]);

const RECALL_TRIGGERS = new Set([
  "remember", "recall", "discussed", "talked", "said", "mentioned",
  "earlier", "before", "previous", "last", "ago", "history", "past",
]);

const RECALL_PHRASES = [
  /what did (we|i|you) (say|discuss|talk)/i,
  /did (we|i|you) (ever|already)/i,
  /have (we|i) (discussed|mentioned)/i,
  /remind me (about|of)/i,
  /when did (we|i)/i,
];

const TASK_TRIGGERS = new Set([
  "task", "todo", "do", "create", "make", "build", "work",
  "project", "complete", "finish", "start", "begin",
]);

const PLANNING_TRIGGERS = new Set([
  "plan", "schedule", "calendar", "routine", "workout",
  "meal", "diet", "itinerary", "organize", "prepare",
]);

const PLANNING_PHRASES = [
  /create (a|an|my) .*(plan|schedule|routine)/i,
  /help me plan/i,
  /make (a|an) .*(plan|schedule)/i,
  /set up (a|an|my)/i,
  /organize my/i,
];

const TIME_PATTERNS = [
  { pattern: /yesterday/i, offset: -1 },
  { pattern: /today/i, offset: 0 },
  { pattern: /last week/i, offset: -7 },
  { pattern: /(\d+) days? ago/i, offsetFn: (m: RegExpMatchArray) => -parseInt(m[1]) },
  { pattern: /this morning/i, offset: 0 },
  { pattern: /last month/i, offset: -30 },
];

// ============================================================================
// Core Analysis Functions
// ============================================================================

export function analyzeIntent(query: string): Intent {
  const keywords = extractKeywords(query);
  const queryType = classifyQueryType(query, keywords);
  const confidence = calculateConfidence(query, queryType);
  const primaryTopics = extractTopics(query, keywords);
  const timeRange = extractTimeRange(query);
  const entities = extractEntities(query);
  const isQuestion = query.includes("?") || /^(what|when|where|why|how|who|did|do|does|is|are|was|were|can|could|would|should)/i.test(query);
  const hasPlanningIntent = detectPlanningIntent(query);

  return {
    keywords,
    queryType,
    confidence,
    primaryTopics,
    timeRange,
    entities,
    isQuestion,
    hasPlanningIntent,
  };
}

function extractKeywords(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Remove duplicates while preserving order
  return [...new Set(words)];
}

function classifyQueryType(query: string, keywords: string[]): QueryType {
  const lowerQuery = query.toLowerCase();

  // Check for planning intent first (most specific)
  if (detectPlanningIntent(query)) {
    return "planning";
  }

  // Check for recall triggers
  for (const trigger of RECALL_TRIGGERS) {
    if (lowerQuery.includes(trigger)) {
      return "recall";
    }
  }

  // Check for recall phrases
  for (const pattern of RECALL_PHRASES) {
    if (pattern.test(query)) {
      return "recall";
    }
  }

  // Check for task triggers
  for (const trigger of TASK_TRIGGERS) {
    if (lowerQuery.includes(trigger)) {
      return "task";
    }
  }

  // Check keywords for recall indicators
  const keywordSet = new Set(keywords);
  for (const trigger of RECALL_TRIGGERS) {
    if (keywordSet.has(trigger)) {
      return "recall";
    }
  }

  return "general";
}

function calculateConfidence(query: string, queryType: QueryType): number {
  const lowerQuery = query.toLowerCase();
  let confidence = 0.5; // Base confidence

  if (queryType === "recall") {
    // Boost for explicit recall phrases
    for (const pattern of RECALL_PHRASES) {
      if (pattern.test(query)) {
        confidence += 0.3;
        break;
      }
    }
    // Boost for recall trigger words
    for (const trigger of RECALL_TRIGGERS) {
      if (lowerQuery.includes(trigger)) {
        confidence += 0.1;
      }
    }
  } else if (queryType === "planning") {
    for (const pattern of PLANNING_PHRASES) {
      if (pattern.test(query)) {
        confidence += 0.3;
        break;
      }
    }
    for (const trigger of PLANNING_TRIGGERS) {
      if (lowerQuery.includes(trigger)) {
        confidence += 0.1;
      }
    }
  } else if (queryType === "task") {
    for (const trigger of TASK_TRIGGERS) {
      if (lowerQuery.includes(trigger)) {
        confidence += 0.15;
      }
    }
  }

  return Math.min(confidence, 1.0);
}

function extractTopics(query: string, keywords: string[]): string[] {
  // Topics are the most significant keywords (first 3-5)
  return keywords.slice(0, 5);
}

function extractTimeRange(query: string): { start: string; end: string } | undefined {
  const now = new Date();

  for (const { pattern, offset, offsetFn } of TIME_PATTERNS) {
    const match = query.match(pattern);
    if (match) {
      const dayOffset = offsetFn ? offsetFn(match) : offset;
      const targetDate = new Date(now);
      targetDate.setDate(targetDate.getDate() + (dayOffset ?? 0));
      const dateStr = targetDate.toISOString().split("T")[0];
      return { start: dateStr, end: dateStr };
    }
  }

  return undefined;
}

function extractEntities(query: string): string[] {
  const entities: string[] = [];

  // Extract capitalized words (potential proper nouns)
  const capitalizedPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g;
  const matches = query.match(capitalizedPattern);
  if (matches) {
    // Filter out sentence-starting words
    const words = query.split(/\s+/);
    for (const match of matches) {
      const firstWord = match.split(/\s+/)[0];
      // Check if it's not just a sentence starter
      const idx = words.indexOf(firstWord);
      if (idx > 0) {
        entities.push(match);
      }
    }
  }

  // Extract quoted strings
  const quotedPattern = /"([^"]+)"|'([^']+)'/g;
  let quotedMatch;
  while ((quotedMatch = quotedPattern.exec(query)) !== null) {
    entities.push(quotedMatch[1] || quotedMatch[2]);
  }

  return [...new Set(entities)];
}

function detectPlanningIntent(query: string): boolean {
  const lowerQuery = query.toLowerCase();

  // Check planning phrases
  for (const pattern of PLANNING_PHRASES) {
    if (pattern.test(query)) {
      return true;
    }
  }

  // Check planning triggers
  for (const trigger of PLANNING_TRIGGERS) {
    if (lowerQuery.includes(trigger)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Advanced Analysis
// ============================================================================

export function analyzeWithContext(
  query: string,
  recentTopics: string[],
  activeProjects: string[]
): Intent {
  const baseIntent = analyzeIntent(query);

  // Boost topics that match recent context
  const boostedTopics: string[] = [];
  for (const topic of baseIntent.primaryTopics) {
    if (recentTopics.some((rt) => rt.toLowerCase().includes(topic.toLowerCase()))) {
      boostedTopics.unshift(topic); // Put at front
    } else {
      boostedTopics.push(topic);
    }
  }

  // Add active project mentions
  const lowerQuery = query.toLowerCase();
  for (const project of activeProjects) {
    if (lowerQuery.includes(project.toLowerCase())) {
      baseIntent.entities.push(project);
    }
  }

  return {
    ...baseIntent,
    primaryTopics: boostedTopics,
  };
}

export function shouldRetrieveContext(intent: Intent): boolean {
  // Always retrieve for recall queries
  if (intent.queryType === "recall") {
    return true;
  }

  // Retrieve if query references time
  if (intent.timeRange) {
    return true;
  }

  // Retrieve if entities are mentioned
  if (intent.entities.length > 0) {
    return true;
  }

  // Retrieve for questions with high confidence
  if (intent.isQuestion && intent.confidence > 0.7) {
    return true;
  }

  // Skip retrieval for simple greetings/commands
  const simplePatterns = [
    /^(hi|hello|hey|thanks|thank you|ok|okay|bye|goodbye)$/i,
    /^(yes|no|sure|yep|nope)$/i,
  ];
  
  // Check if it's a simple query
  const queryLower = intent.keywords.join(" ");
  for (const pattern of simplePatterns) {
    if (pattern.test(queryLower)) {
      return false;
    }
  }

  return true;
}

// ============================================================================
// Keyword Extraction Utilities
// ============================================================================

export function extractKeywordsFromTurn(
  userQuery: string,
  assistantReply: string
): string[] {
  const combined = `${userQuery} ${assistantReply}`;
  const keywords = extractKeywords(combined);

  // Weight keywords that appear in both
  const userKeywords = new Set(extractKeywords(userQuery));
  const assistantKeywords = new Set(extractKeywords(assistantReply));

  const weighted: Array<{ keyword: string; weight: number }> = [];

  for (const kw of keywords) {
    let weight = 1;
    if (userKeywords.has(kw) && assistantKeywords.has(kw)) {
      weight = 3; // Appears in both
    } else if (userKeywords.has(kw)) {
      weight = 2; // User mentioned it
    }
    weighted.push({ keyword: kw, weight });
  }

  // Sort by weight and return top keywords
  return weighted
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)
    .map((w) => w.keyword);
}

// ============================================================================
// Plan-Aware Intent Analysis
// Python: intent_analyzer.py analyze_with_plan_context()
// ============================================================================

export interface ActivePlan {
  planId: string;
  title: string;
  topic: string;
  items: Array<{
    date: string;
    task: string;
    durationMinutes: number;
    completed: boolean;
  }>;
}

/**
 * Analyze user query with awareness of active plans
 * Python: IntentAnalyzer.analyze_with_plan_context()
 * 
 * Includes today's planned tasks in the analysis context
 * and adds plan topics to primary topics for better retrieval.
 */
export function analyzeWithPlanContext(
  query: string,
  activePlans: ActivePlan[]
): Intent {
  // Get today's date in YYYY-MM-DD format
  const today = new Date().toISOString().split("T")[0];

  // Get today's incomplete tasks from active plans
  const todaysTasks: Array<{ task: string; durationMinutes: number; planTitle: string }> = [];
  
  for (const plan of activePlans) {
    for (const item of plan.items) {
      if (item.date === today && !item.completed) {
        todaysTasks.push({
          task: item.task,
          durationMinutes: item.durationMinutes,
          planTitle: plan.title,
        });
      }
    }
  }

  // Create enhanced query with plan context
  let enhancedQuery = query;
  if (todaysTasks.length > 0) {
    const taskSummary = todaysTasks
      .slice(0, 3)
      .map((t) => `${t.task} (${t.durationMinutes}min)`)
      .join(", ");
    
    const suffix = todaysTasks.length > 3 
      ? `, +${todaysTasks.length - 3} more` 
      : "";
    
    enhancedQuery = `${query}\n\n[Today's planned activities: ${todaysTasks.length} tasks - ${taskSummary}${suffix}]`;
  }

  // Analyze with enhanced context
  const intent = analyzeIntent(enhancedQuery);

  // Add plan topics to primary topics for better retrieval
  const planTopics = new Set<string>();
  for (const plan of activePlans) {
    planTopics.add(plan.topic.toLowerCase());
    
    // Extract keywords from plan titles and recent tasks
    const titleKeywords = extractKeywords(plan.title);
    for (const kw of titleKeywords) {
      planTopics.add(kw);
    }
    
    // Add keywords from today's tasks
    for (const item of plan.items.slice(0, 5)) {
      const taskKeywords = extractKeywords(item.task);
      for (const kw of taskKeywords) {
        planTopics.add(kw);
      }
    }
  }

  // Merge plan topics with existing primary topics (avoid duplicates)
  const existingTopics = new Set(intent.primaryTopics.map((t) => t.toLowerCase()));
  const newTopics = [...planTopics].filter((t) => !existingTopics.has(t)).slice(0, 3);
  
  return {
    ...intent,
    primaryTopics: [...intent.primaryTopics, ...newTopics],
    hasPlanningIntent: intent.hasPlanningIntent || todaysTasks.length > 0,
  };
}

/**
 * Check if query is related to an active plan
 */
export function isQueryRelatedToPlan(query: string, plan: ActivePlan): boolean {
  const queryKeywords = new Set(extractKeywords(query));
  const planKeywords = new Set([
    ...extractKeywords(plan.title),
    ...extractKeywords(plan.topic),
    ...plan.items.flatMap((item) => extractKeywords(item.task)),
  ]);

  // Check for keyword overlap
  let matchCount = 0;
  for (const kw of queryKeywords) {
    if (planKeywords.has(kw)) {
      matchCount++;
    }
  }

  // Consider related if at least 2 keywords match or 30%+ overlap
  const overlapRatio = queryKeywords.size > 0 ? matchCount / queryKeywords.size : 0;
  return matchCount >= 2 || overlapRatio >= 0.3;
}

/**
 * Get the most relevant plan for a query
 */
export function getMostRelevantPlan(
  query: string,
  activePlans: ActivePlan[]
): ActivePlan | null {
  if (activePlans.length === 0) return null;

  const queryKeywords = new Set(extractKeywords(query));
  
  let bestPlan: ActivePlan | null = null;
  let bestScore = 0;

  for (const plan of activePlans) {
    const planKeywords = new Set([
      ...extractKeywords(plan.title),
      ...extractKeywords(plan.topic),
    ]);

    let score = 0;
    for (const kw of queryKeywords) {
      if (planKeywords.has(kw)) {
        score++;
      }
    }

    // Boost score if plan topic is mentioned directly
    if (query.toLowerCase().includes(plan.topic.toLowerCase())) {
      score += 3;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPlan = plan;
    }
  }

  return bestScore > 0 ? bestPlan : null;
}
