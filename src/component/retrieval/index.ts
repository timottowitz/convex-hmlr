/**
 * Retrieval Module - Context retrieval and hydration
 *
 * This module provides:
 * - Context Hydrator: Build LLM prompts from retrieved context
 * - Metadata Extractor: Parse LLM responses for keywords/affect
 * - Intent Analyzer: Classify queries and extract intent
 * - Hybrid Search: Combined vector + lexical search
 */

// Re-export all retrieval functionality
export * from "./hydrator";
export * from "./metadataExtractor";
export * from "./intentAnalyzer";
export * from "./hybridSearch";
