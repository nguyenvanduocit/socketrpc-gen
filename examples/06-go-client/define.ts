/**
 * Example 06: Go client, Go server
 *
 * Generated with:
 *   bunx socketrpc-gen ./examples/06-go-client/define.ts \
 *     --client go --server go \
 *     --go-out ./examples/06-go-client/wire --go-package wire \
 *     --go-client-out ./examples/06-go-client/wireclient --go-client-package wireclient
 *
 * One invocation writes two packages of the Go module in this directory:
 *
 *   - `wire` holds the contract types and the generated server
 *   - `wireclient` holds the generated client, which imports `wire` for every
 *     contract type, so the two sides share one set of types
 *
 * A worker dials a coordinator, registers itself, and runs the tasks the
 * coordinator sends it. Everything below stays inside the portable subset the
 * Go backend accepts.
 */

/** What a worker announces about itself on every connection. */
export type Worker = {
  name: string;
  capacity: number;
};

/** The coordinator's answer to a registration. */
export type Registration = {
  workerId: string;
  /** Tasks the coordinator holds for this worker. */
  pending: number;
};

export type Task = {
  id: string;
  prompt: string;
};

export type TaskResult = {
  taskId: string;
  output: string;
};

/** Functions the coordinator (the Go server) provides; the worker calls these. */
export interface ServerFunctions {
  /** Acknowledged: the worker announces itself, again after every reconnect. */
  register: (worker: Worker) => Registration;

  /** Fire-and-forget progress from a running task. */
  progress: (taskId: string, percent: number) => void;
}

/** Functions the worker (the Go client) provides; the coordinator calls these. */
export interface ClientFunctions {
  /** Acknowledged: the coordinator hands the worker a task and waits for the result. */
  runTask: (task: Task) => TaskResult;

  /** Fire-and-forget: the coordinator asks the worker to stop a task. */
  cancelTask: (taskId: string) => void;
}
