# Example 04: Zod Integration

This example demonstrates a schema-first contract: Zod schemas are the single source of truth, the RPC interfaces use types inferred from them, and the generator reads those inferred types like any other.

## What's Included

- **Zod schemas** in `define.ts` - `GenerateRequestSchema`, `GenerateResponseSchema`, `UsageSchema`, `TaskSchema`, `CreateTaskRequestSchema`, `ProgressUpdateSchema`
- **Inferred types** - one `z.infer<typeof …Schema>` alias per schema (`GenerateRequest`, `Task`, `ProgressUpdate`, …)

- **ServerFunctions**: Functions that clients can call on the server
  - `generate(request: GenerateRequest)` - Returns `GenerateResponse`
  - `createTask(request: CreateTaskRequest)` - Returns `Task`
  - `getTask(taskId: string)` - Returns `Task`
  - `listTasks()` - Returns `Task[]`
  - `cancelTask(taskId: string)` - Fire-and-forget cancellation (void return)

- **ClientFunctions**: Functions that server can call on clients
  - `onProgress(update: ProgressUpdate)` - Fire-and-forget progress update
  - `onTaskComplete(task: Task)` - Fire-and-forget completion notice
  - `onError(message: string, code: string)` - Fire-and-forget error notice

- **test.ts** - A type-level check that the generated signatures line up with the Zod-inferred types

## Generate RPC Code

```bash
bun run ../../index.ts ./define.ts
```

This will generate:
- `client.generated.ts` - Client-side RPC functions
- `server.generated.ts` - Server-side RPC functions
- `types.generated.ts` - Shared type definitions
- `package.json` - Package configuration (if not exists)
- `tsconfig.json` - TypeScript configuration (if not exists)

## How Zod Types Flow Through the Contract

`define.ts` defines each schema once and derives the type the interface uses:

```typescript
export const TaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  createdAt: z.string().datetime()
});

export type Task = z.infer<typeof TaskSchema>;

export interface ServerFunctions {
  getTask: (taskId: string) => Task;
}
```

The generator resolves `Task` to its structural shape and writes that shape into the generated files, so the generated package has no import of `zod` or of `define.ts`. `getTask` appears in `server.generated.ts` as:

```typescript
getTask: (handler: (taskId: string) => Promise<{ id: string; title: string; description: string; status: "pending" | "in_progress" | "completed"; createdAt: string; }>) => Unsubscribe;
```

Because the shapes are identical, a value typed as the Zod-inferred `Task` is accepted wherever the generated code expects one, and a value the generated code returns can be assigned to `Task`. The Zod enums (`finishReason`, `status`) survive as string-literal unions.

The generated code carries types only. Runtime validation of an incoming payload is still the schema's job: call `Schema.parse()` / `Schema.safeParse()` inside a handler when the peer is untrusted.

## Usage

### Client Side

```typescript
import { io } from 'socket.io-client';
import { createRpcClient } from './client.generated';
import { isRpcError } from './types.generated';
import { GenerateRequestSchema, type Task } from './define';

const socket = io('http://localhost:3000');
const rpc = createRpcClient(socket);

// Validate with the schema, then pass the Zod-inferred value straight to the call
const parsed = GenerateRequestSchema.safeParse({ prompt: 'Hello, AI!', maxTokens: 100 });
if (parsed.success) {
  const response = await rpc.server.generate(parsed.data);
  if (isRpcError(response)) {
    console.error('generate failed:', response.code, response.message);
  } else {
    console.log(response.text, response.finishReason, response.usage.outputTokens);
  }
}

// Results assign to the Zod-inferred type
const tasks = await rpc.server.listTasks();
if (!isRpcError(tasks)) {
  const pending: Task[] = tasks.filter((task) => task.status === 'pending');
  console.log('Pending:', pending.length);
}

// Handle server->client calls (one handler per method; re-registering replaces)
rpc.handle.onProgress(async (update) => {
  console.log(`${update.taskId}: ${update.progress}%`, update.message ?? '');
});

rpc.handle.onError(async (message, code) => {
  console.error(`Error ${code}: ${message}`);
});

// Cleanup all handlers
rpc.dispose();
```

### Server Side

```typescript
import { Server } from 'socket.io';
import { createRpcServer } from './server.generated';
import { rpcError } from './types.generated';
import { CreateTaskRequestSchema, type Task } from './define';

const io = new Server(3000);
const tasks = new Map<string, Task>();

io.on('connection', (socket) => {
  const rpc = createRpcServer(socket);

  // Handle client->server calls; re-validate the payload with the schema
  rpc.handle.createTask(async (request) => {
    const checked = CreateTaskRequestSchema.safeParse(request);
    if (!checked.success) {
      throw rpcError('INVALID_ARGUMENT', checked.error.message);
    }
    const task: Task = {
      id: crypto.randomUUID(),
      title: checked.data.title,
      description: checked.data.description ?? '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    tasks.set(task.id, task);

    // Call client functions (fire-and-forget)
    rpc.client.onProgress({ taskId: task.id, progress: 0, message: 'queued' });
    return task;
  });

  rpc.handle.listTasks(async () => [...tasks.values()]);

  // Cleanup on disconnect
  socket.on('disconnect', () => rpc.dispose());
});
```

## Run the Type Check

`test.ts` has no runtime behaviour; it exists to fail compilation if the generated signatures drift from the Zod-inferred types.

```bash
bun run test.ts
```

Prints `Type check passed! Zod integration works correctly.` From the repository root, `bun run check` covers it too: `bun test` regenerates this example and diffs the output, and `tsc --noEmit` type-checks `test.ts`.

## What It Demonstrates

- Zod schemas as the single source of truth, with `z.infer<>` feeding the RPC interfaces
- Zod enums becoming string-literal unions in the generated signatures
- Generated files that are self-contained: no `zod` dependency in the output
- Schema validation inside a handler, reporting a failure with `rpcError('INVALID_ARGUMENT', …)`
- Reuse of schemas shared with AI frameworks (Claude Agent SDK and similar) that already speak Zod
