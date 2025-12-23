/**
 * Type-check test for Zod integration
 *
 * This file verifies that:
 * 1. Zod schemas work with the generator
 * 2. Generated types match inferred Zod types
 * 3. All imports resolve correctly
 */

import { z } from 'zod';
import type { Socket } from 'socket.io-client';

// Import Zod schemas and inferred types from define.ts
import {
  GenerateRequestSchema,
  GenerateResponseSchema,
  TaskSchema,
  CreateTaskRequestSchema,
  ProgressUpdateSchema,
  type GenerateRequest,
  type GenerateResponse,
  type Task,
  type CreateTaskRequest,
  type ProgressUpdate
} from './define';

// Import generated functions
import {
  generate,
  createTask,
  getTask,
  listTasks,
  cancelTask,
  handleOnProgress,
  handleOnTaskComplete,
  handleOnError
} from './client.generated';

import { isRpcError } from './types.generated';

// ============================================
// TYPE COMPATIBILITY TESTS
// ============================================

// Test: Zod-inferred types work with generated functions
function testTypeCompatibility(socket: Socket) {
  // Create a request using the Zod-inferred type
  const request: GenerateRequest = {
    prompt: 'Hello, AI!',
    maxTokens: 100,
    temperature: 0.7
  };

  // The generated function accepts the Zod-inferred type
  generate(socket, request);

  // Create task request
  const taskRequest: CreateTaskRequest = {
    title: 'Test Task',
    description: 'A test task'
  };
  createTask(socket, taskRequest);
}

// Test: Response types match Zod schemas
async function testResponseTypes(socket: Socket) {
  const response = await generate(socket, { prompt: 'test' });

  if (!isRpcError(response)) {
    // TypeScript knows response is GenerateResponse
    const text: string = response.text;
    const finishReason: 'stop' | 'length' | 'content_filter' = response.finishReason;
    const usage: { inputTokens: number; outputTokens: number } = response.usage;

    console.log(text, finishReason, usage);
  }

  const tasks = await listTasks(socket);
  if (!isRpcError(tasks)) {
    // TypeScript knows tasks is Task[]
    tasks.forEach((task: Task) => {
      console.log(task.id, task.title, task.status);
    });
  }
}

// Test: Handler types match Zod schemas
function testHandlerTypes(socket: Socket) {
  handleOnProgress(socket, async (socket, update) => {
    // update matches ProgressUpdate type
    const taskId: string = update.taskId;
    const progress: number = update.progress;
    const message: string | undefined = update.message;
    console.log(taskId, progress, message);
  });

  handleOnTaskComplete(socket, async (socket, task) => {
    // task matches Task type
    const id: string = task.id;
    const status: 'pending' | 'in_progress' | 'completed' = task.status;
    console.log(id, status);
  });

  handleOnError(socket, async (socket, message, code) => {
    console.error(`Error ${code}: ${message}`);
  });
}

// Test: Zod validation can be used alongside generated code
function testZodValidation() {
  // Parse unknown data with Zod
  const unknownData = { prompt: 'test', maxTokens: 50 };
  const parsed = GenerateRequestSchema.safeParse(unknownData);

  if (parsed.success) {
    // parsed.data is typed as GenerateRequest
    const request: GenerateRequest = parsed.data;
    console.log('Valid request:', request.prompt);
  }

  // Validate a task
  const taskData = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    title: 'My Task',
    description: 'Description',
    status: 'pending',
    createdAt: '2024-01-01T00:00:00Z'
  };

  const taskResult = TaskSchema.safeParse(taskData);
  if (taskResult.success) {
    const task: Task = taskResult.data;
    console.log('Valid task:', task.title);
  }
}

// ============================================
// RUN TESTS (type-check only, no runtime)
// ============================================

console.log('Type check passed! Zod integration works correctly.');
