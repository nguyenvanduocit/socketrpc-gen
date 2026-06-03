import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { Server } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

import { createRpcServer } from "../examples/01-basic/server.generated";
import { createRpcClient } from "../examples/01-basic/client.generated";
import { isRpcError } from "../examples/01-basic/types.generated";
import type { RpcServer } from "../examples/01-basic/server.generated";

// These tests stand up a real socket.io server + client pair and exercise the
// generated RPC layer over the wire — the behavior that snapshot tests cannot cover.

let httpServer: HttpServer;
let ioServer: Server;
let url: string;

// Side-channels the server handlers write to, asserted from tests.
const deleted: string[] = [];
// Queue plumbing so each client connection can grab its matching server-side RpcServer.
let serverRpcQueue: RpcServer[] = [];
let serverRpcWaiters: Array<(rpc: RpcServer) => void> = [];

function nextServerRpc(): Promise<RpcServer> {
  const queued = serverRpcQueue.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve) => serverRpcWaiters.push(resolve));
}

function once(socket: ClientSocket, event: string): Promise<void> {
  return new Promise((resolve) => socket.once(event, () => resolve()));
}

const openClients: ClientSocket[] = [];

/** Connect a fresh client and wire up both sides' RPC instances. */
async function makePair() {
  const rawClient = ioClient(url, { forceNew: true, transports: ["websocket"] });
  openClients.push(rawClient);
  const serverRpc = await nextServerRpc();
  if (!rawClient.connected) await once(rawClient, "connect");

  const clientRpc = createRpcClient(rawClient);
  const received: string[] = [];
  clientRpc.handle.onMessage(async (message) => {
    received.push(message);
  });
  clientRpc.handle.requestConfirmation(async () => true);

  return { rawClient, serverRpc, clientRpc, received };
}

beforeAll(async () => {
  httpServer = createServer();
  ioServer = new Server(httpServer);

  ioServer.on("connection", (socket) => {
    const rpc = createRpcServer(socket);

    rpc.handle.getUser(async (userId) => {
      if (userId === "throw") throw new Error("boom");
      if (userId === "slow") {
        await new Promise((r) => setTimeout(r, 500)); // stay in-flight long enough to be interrupted
        return { id: "slow", name: "Slow", email: "slow@example.com" };
      }
      if (userId === "server-calls-client") {
        rpc.client.onMessage("pushed");
        const answer = await rpc.client.requestConfirmation("confirm?");
        return { id: String(answer), name: "round-trip", email: "rt@example.com" };
      }
      return { id: userId, name: "Ada", email: "ada@example.com" };
    });
    rpc.handle.createUser(async (name, email) => ({ id: "new-id", name, email }));
    rpc.handle.deleteUser(async (userId) => {
      deleted.push(userId);
    });

    const waiter = serverRpcWaiters.shift();
    if (waiter) waiter(rpc);
    else serverRpcQueue.push(rpc);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  url = `http://localhost:${port}`;
});

afterEach(() => {
  for (const c of openClients.splice(0)) c.disconnect();
  serverRpcQueue = [];
  serverRpcWaiters = [];
  deleted.length = 0;
});

afterAll(() => {
  ioServer.close();
  httpServer.close();
});

const T = 10_000;

describe("generated RPC over a real socket pair", () => {
  test(
    "client→server ack resolves to the value; isRpcError is false",
    async () => {
      const { clientRpc } = await makePair();
      const result = await clientRpc.server.getUser("u1");
      expect(isRpcError(result)).toBe(false);
      expect(result).toEqual({ id: "u1", name: "Ada", email: "ada@example.com" });
    },
    T,
  );

  test(
    "handler throw propagates as a branded RpcError with code + origin",
    async () => {
      const { clientRpc } = await makePair();
      const result = await clientRpc.server.getUser("throw");
      expect(isRpcError(result)).toBe(true);
      if (isRpcError(result)) {
        expect(result.code).toBe("INTERNAL_ERROR");
        expect(result.origin).toBe("getUser");
        expect(result.message).toBe("boom");
      }
    },
    T,
  );

  test(
    "F1: a success value shaped like { message, code } is NOT misread as an error",
    () => {
      // The exact soundness bug the brand fixes — proven against the real generated guard.
      expect(isRpcError({ message: "Payment received", code: "PAID" })).toBe(false);
      expect(isRpcError({ __rpcError: true, message: "x", code: "INTERNAL_ERROR" })).toBe(true);
    },
  );

  test(
    "void fire-and-forget is delivered to the server handler",
    async () => {
      const { clientRpc } = await makePair();
      clientRpc.server.deleteUser("gone");
      // wait for the event to round-trip
      await new Promise((r) => setTimeout(r, 150));
      expect(deleted).toContain("gone");
    },
    T,
  );

  test(
    "server→client ack round-trips (bidirectional)",
    async () => {
      const { clientRpc, received } = await makePair();
      const result = await clientRpc.server.getUser("server-calls-client");
      expect(isRpcError(result)).toBe(false);
      if (!isRpcError(result)) expect(result.id).toBe("true"); // client answered `true`
      expect(received).toContain("pushed");
    },
    T,
  );

  test(
    "AbortSignal settles the call immediately with an ABORTED RpcError",
    async () => {
      const { clientRpc } = await makePair();
      const ac = new AbortController();
      ac.abort();
      const result = await clientRpc.server.getUser("u1", { signal: ac.signal });
      expect(isRpcError(result)).toBe(true);
      if (isRpcError(result)) expect(result.code).toBe("ABORTED");
    },
    T,
  );

  test(
    "an in-flight call interrupted by a disconnect resolves with DISCONNECTED",
    async () => {
      const { clientRpc, rawClient } = await makePair();
      // Emit while connected (goes into `acks`), then drop the socket mid-flight.
      const pending = clientRpc.server.getUser("slow", { timeout: 5000 });
      setTimeout(() => rawClient.disconnect(), 50);
      const result = await pending;
      expect(isRpcError(result)).toBe(true);
      if (isRpcError(result)) expect(result.code).toBe("DISCONNECTED");
    },
    T,
  );

  test(
    "dispose() stops handlers; subsequent calls time out with TIMEOUT",
    async () => {
      const { clientRpc, serverRpc } = await makePair();
      serverRpc.dispose();
      const result = await clientRpc.server.getUser("u1", { timeout: 300 });
      expect(isRpcError(result)).toBe(true);
      if (isRpcError(result)) expect(result.code).toBe("TIMEOUT");
    },
    T,
  );

  test(
    "re-registering a handler replaces the previous one (no double-ack)",
    async () => {
      const { clientRpc } = await makePair();
      // makePair already registered requestConfirmation → true. Re-register to false,
      // then back to true. Only the last handler must answer; the ack must fire once.
      clientRpc.handle.requestConfirmation(async () => false);
      clientRpc.handle.requestConfirmation(async () => true);
      // Drive a server→client call and read the single answer back through getUser.
      const result = await clientRpc.server.getUser("server-calls-client");
      expect(isRpcError(result)).toBe(false);
      if (!isRpcError(result)) expect(result.id).toBe("true");
    },
    T,
  );

  test(
    "connection helpers: connected reflects state and onDisconnect fires",
    async () => {
      const { clientRpc, rawClient } = await makePair();
      expect(clientRpc.connected).toBe(true);
      const seen = await new Promise<boolean>((resolve) => {
        clientRpc.onDisconnect(() => resolve(true));
        rawClient.disconnect();
        setTimeout(() => resolve(false), 1000);
      });
      expect(seen).toBe(true);
    },
    T,
  );
});
