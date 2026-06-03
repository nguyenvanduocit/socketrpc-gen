/**
 * Type-check test for Zod integration
 *
 * This file verifies that:
 * 1. Zod schemas work with the generator
 * 2. Generated types match inferred Zod types
 * 3. All imports resolve correctly
 */

import type { Socket } from 'socket.io-client';

// Import Zod schemas and inferred types from define.ts
import {
  GenerateRequestSchema,
  TaskSchema,
  type GenerateRequest,
  type Task,
  type CreateTaskRequest,
} from './define';

// Import the generated factory + types
import { createRpcClient } from './client.generated';
import { isRpcError } from './types.generated';

// ============================================
// TYPE COMPATIBILITY TESTS
// ============================================

// Test: Zod-inferred types work with the generated call methods
function testTypeCompatibility(socket: Socket) {
  const rpc = createRpcClient(socket);

  // Create a request using the Zod-inferred type
  const request: GenerateRequest = {
    prompt: 'Hello, AI!',
    maxTokens: 100,
    temperature: 0.7,
  };

  // The generated call accepts the Zod-inferred type
  rpc.server.generate(request);

  // Create task request
  const taskRequest: CreateTaskRequest = {
    title: 'Test Task',
    description: 'A test task',
  };
  rpc.server.createTask(taskRequest);
}

// Test: Response types match Zod schemas
async function testResponseTypes(socket: Socket) {
  const rpc = createRpcClient(socket);

  const response = await rpc.server.generate({ prompt: 'test' });

  if (!isRpcError(response)) {
    // TypeScript knows response is GenerateResponse
    const text: string = response.text;
    const finishReason: 'stop' | 'length' | 'content_filter' = response.finishReason;
    const usage: { inputTokens: number; outputTokens: number } = response.usage;

    console.log(text, finishReason, usage);
  }

  const tasks = await rpc.server.listTasks();
  if (!isRpcError(tasks)) {
    // TypeScript knows tasks is Task[]
    tasks.forEach((task: Task) => {
      console.log(task.id, task.title, task.status);
    });
  }
}

// Test: Handler types match Zod schemas
function testHandlerTypes(socket: Socket) {
  const rpc = createRpcClient(socket);

  rpc.handle.onProgress(async (update) => {
    // update matches ProgressUpdate type
    const taskId: string = update.taskId;
    const progress: number = update.progress;
    const message: string | undefined = update.message;
    console.log(taskId, progress, message);
  });

  rpc.handle.onTaskComplete(async (task) => {
    // task matches Task type
    const id: string = task.id;
    const status: 'pending' | 'in_progress' | 'completed' = task.status;
    console.log(id, status);
  });

  rpc.handle.onError(async (message, code) => {
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
    createdAt: '2024-01-01T00:00:00Z',
  };

  const taskResult = TaskSchema.safeParse(taskData);
  if (taskResult.success) {
    const task: Task = taskResult.data;
    console.log('Valid task:', task.title);
  }
}

// Keep the type-check entry points referenced so unused-symbol settings stay quiet.
void [testTypeCompatibility, testResponseTypes, testHandlerTypes, testZodValidation];

// ============================================
// RUN TESTS (type-check only, no runtime)
// ============================================

console.log('Type check passed! Zod integration works correctly.');
