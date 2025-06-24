# Socket RPC

[![npm version](https://badge.fury.io/js/socketrpc-gen.svg)](https://badge.fury.io/js/socketrpc-gen)

`socket-rpc` is a powerful command-line tool that automatically generates a type-safe RPC (Remote Procedure Call) layer for your client and server applications using `socket.io`. It takes a TypeScript interface as input and generates all the necessary code for you to communicate between your client and server with full type safety.

## Features

-   **Type-Safe:** Full static type checking for your RPC calls, powered by TypeScript.
-   **Auto-generation:** Automatically generates client and server code from a single TypeScript interface definition.
-   **Bidirectional Communication:** Supports both client-to-server and server-to-client RPC calls.
-   **Simple to Use:** Get started with a single command.
-   **Customizable:** Configure the generated code to fit your needs.

## Getting Started

### 1. Define Your RPC Interface

Create a TypeScript file (e.g., `pkg/rpc/define.ts`) that defines the functions your server and client will expose.

```typescript
// pkg/rpc/define.ts

/**
 * Interface defining the functions available on the RPC server
 * These functions can be called remotely by RPC clients
 */
interface ServerFunctions {
  /**
   * Generates text based on the provided prompt
   */
  generateText: (prompt: string) => string;
}

/**
 * Interface defining the functions available on the RPC client
 * These functions can be called by the RPC server to interact with the client
 */
interface ClientFunctions {
  /**
   * Displays an error to the client user interface
   */
  showError: (error: Error) => void;
}
```

### 2. Run the Generator

Use the `socketrpc-gen` CLI to generate the RPC code. The generator automatically infers the output directory from the input file path.

```bash
bunx socketrpc-gen <path-to-your-interface-file> [options]
```

For example:

```bash
bunx socketrpc-gen ./example/pkg/rpc/define.ts
```

This will generate a new package in the `example/pkg/rpc` directory containing the generated client and server code.

## Example Usage

### Server

Implement the server-side functions and use the generated handlers to process client requests.

```typescript
// pkg/server/index.ts
import { createServer } from "http";
import { Server } from "socket.io";
import { handleGenerateText, showError } from "@socket-rpc/rpc/server";

const httpServer = createServer();
const io = new Server(httpServer);

io.on("connection", async (socket) => {
  // Handle the `generateText` RPC call from the client
  handleGenerateText(
    socket,
    async (prompt: string): Promise<string> => {
      // Call the `showError` RPC function on the client
      showError(socket, new Error("This is a test error from the server!"));
      return `Server received: ${prompt}`;
    }
  );
});

httpServer.listen(8080, () => {
  console.log("Server running on http://localhost:8080");
});
```

### Client

Use the generated functions to call server methods and handle server-initiated calls.

```typescript
// pkg/client/index.ts
import { io } from "socket.io-client";
import { generateText, handleShowError } from "@socket-rpc/rpc/client";

const socket = io("http://localhost:8080");

socket.on("connect", async () => {
  // Handle the `showError` RPC call from the server
  handleShowError(socket, async (error: Error): Promise<void> => {
    console.error("Server sent an error:", error.message);
  });

  // Call the `generateText` RPC function on the server
  const response = await generateText(socket, "Hello, server!");
  console.log("Server responded:", response);
});
```

## CLI Reference

### `socketrpc-gen`

Generates the RPC code from interface definitions.

**Usage:**

```
socketrpc-gen <path> [options]
```

**Arguments:**

-   `<path>`: Path to the input TypeScript file containing interface definitions. (Required)

**Options:**

-   `-p, --package-name <name>`: Package name for the generated RPC package. (Default: "@socket-rpc/rpc")
-   `-t, --timeout <ms>`: Default timeout for RPC calls in milliseconds. (Default: "5000")
-   `-w, --watch`: Watch for changes and regenerate automatically. (Default: false)
-   `-h, --help`: Display help for command.

## How It Works

The `socket-rpc` tool works by parsing your TypeScript interface file and generating a set of functions and handlers that wrap the `socket.io` communication layer.

-   For each function in your `ServerFunctions` interface, it generates:
    -   A `handle<FunctionName>` function for the server to process incoming requests.
    -   A `<functionName>` function for the client to call the server method.
-   For each function in your `ClientFunctions` interface, it generates:
    -   A `handle<FunctionName>` function for the client to process incoming requests from the server.
    -   A `<functionName>` function for the server to call the client method.

This approach provides a clean and type-safe way to communicate between your client and server, without having to write any boilerplate `socket.io` code yourself. 