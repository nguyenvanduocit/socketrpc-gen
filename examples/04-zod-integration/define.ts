/**
 * Example 04: Zod Integration for AI Framework Compatibility
 *
 * This example demonstrates how to use Zod schemas with socket-rpc.
 * Useful when integrating with AI frameworks (like Claude Agent SDK)
 * that use Zod for structured outputs.
 *
 * Key pattern: Define Zod schemas first, then infer TypeScript types from them.
 */

import { z } from 'zod';

// ============================================
// ZOD SCHEMAS (your single source of truth)
// ============================================

/**
 * Schema for AI generation request
 */
export const GenerateRequestSchema = z.object({
  prompt: z.string(),
  maxTokens: z.number().optional(),
  temperature: z.number().min(0).max(2).optional()
});

/**
 * Schema for token usage tracking
 */
export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number()
});

/**
 * Schema for AI generation response
 */
export const GenerateResponseSchema = z.object({
  text: z.string(),
  finishReason: z.enum(['stop', 'length', 'content_filter']),
  usage: UsageSchema
});

/**
 * Schema for a task entity
 */
export const TaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  createdAt: z.string().datetime()
});

/**
 * Schema for creating a new task
 */
export const CreateTaskRequestSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional()
});

/**
 * Schema for progress updates
 */
export const ProgressUpdateSchema = z.object({
  taskId: z.string().uuid(),
  progress: z.number().min(0).max(100),
  message: z.string().optional()
});

// ============================================
// INFERRED TYPES (derived from Zod schemas)
// ============================================

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export type ProgressUpdate = z.infer<typeof ProgressUpdateSchema>;

// ============================================
// RPC INTERFACES (using inferred types)
// ============================================

/**
 * Interface defining functions that the SERVER provides
 * Clients can call these functions remotely
 */
export interface ServerFunctions {
  /**
   * Generate text using AI
   */
  generate: (request: GenerateRequest) => GenerateResponse;

  /**
   * Create a new task
   */
  createTask: (request: CreateTaskRequest) => Task;

  /**
   * Get task by ID
   */
  getTask: (taskId: string) => Task;

  /**
   * List all tasks
   */
  listTasks: () => Task[];

  /**
   * Cancel a running task (fire-and-forget)
   */
  cancelTask: (taskId: string) => void;
}

/**
 * Interface defining functions that the CLIENT provides
 * Server can call these functions to push updates to the client
 */
export interface ClientFunctions {
  /**
   * Receive progress updates for a task
   */
  onProgress: (update: ProgressUpdate) => void;

  /**
   * Receive notification when a task completes
   */
  onTaskComplete: (task: Task) => void;

  /**
   * Receive error notifications
   */
  onError: (message: string, code: string) => void;
}
