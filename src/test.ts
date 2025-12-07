/**
 * HMLR Test Helpers
 *
 * Export utilities for testing HMLR in consuming apps using convex-test.
 *
 * Usage:
 * ```typescript
 * import hmlrTest from "@timottowitz/convex-hmlr/test";
 * import { convexTest } from "convex-test";
 *
 * const t = convexTest();
 * hmlrTest.register(t);
 * ```
 */

/// <reference types="vite/client" />

import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";

// Import schema from component
import schema from "./component/schema.js";

// Import all component modules for registration
// Note: In the built package, these paths will be resolved correctly
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the HMLR component with a convex-test instance
 *
 * @param t - The test convex instance from convexTest()
 * @param name - The component name (default: "hmlr")
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "hmlr"
): void {
  t.registerComponent(name, schema, modules);
}

/**
 * Create a mock embedding for testing
 * Returns a normalized random vector of the specified dimensions
 */
export function mockEmbedding(dimensions: number = 1024): number[] {
  const embedding = Array.from({ length: dimensions }, () => Math.random() - 0.5);
  const magnitude = Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0));
  return embedding.map((x) => x / magnitude);
}

/**
 * Create a similar embedding (for testing vector search)
 * Returns an embedding that's close to the input with some noise
 */
export function similarEmbedding(
  base: number[],
  similarity: number = 0.9
): number[] {
  const noise = 1 - similarity;
  const embedding = base.map(
    (x) => x * similarity + (Math.random() - 0.5) * noise * 2
  );
  const magnitude = Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0));
  return embedding.map((x) => x / magnitude);
}

/**
 * Generate a test day ID
 */
export function testDayId(daysAgo: number = 0): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split("T")[0];
}

/**
 * Generate a test turn ID
 */
export function testTurnId(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 15);
  return `turn_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
}

// Export everything
export default {
  register,
  schema,
  modules,
  mockEmbedding,
  similarEmbedding,
  testDayId,
  testTurnId,
};
