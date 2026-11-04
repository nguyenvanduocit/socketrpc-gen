// Command goclient drives the *generated* Go RPC client against the generated
// TypeScript server that tests/go-client-ts.integration.test.ts runs in-process.
//
// It imports the package socketrpc-gen emits (`--client go --server typescript`,
// written into ./rpc by the test before `go build` runs) and implements nothing
// but the generated ClientHandler interface. Event names, argument order,
// acknowledgement handling and error branding all come from generated code.
//
// Usage: goclient <url> <token>
//
// Each check prints exactly one JSON line on stdout, `{"check": "<name>", ...}`,
// and the last line is `{"check": "done"}`. The process then keeps the
// connection open, so the test can drive server-side assertions against it,
// and exits once stdin closes: that is the test's shutdown signal, and the exit
// status shows Dispose returned.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"socketrpc.goclientts.test/rpc"
)

const (
	namespace = "/runtime"

	// callTimeout bounds every check, well inside the Bun test's own timeouts,
	// so a hung peer surfaces as a reported failure rather than a stalled test.
	callTimeout = 5 * time.Second

	concurrentCalls = 32
)

// reporter serializes result lines: checks run on several goroutines, and two
// interleaved writes would corrupt the line protocol the test parses.
type reporter struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

func (r *reporter) report(line map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.encoder.Encode(line); err != nil {
		fmt.Fprintln(os.Stderr, "goclient: write result:", err)
		os.Exit(1)
	}
}

// errorFields describes err the way the test asserts on it: an *rpc.RpcError
// keeps its code, message, method and data; anything else is reported with an
// empty code, which no assertion accepts.
func errorFields(check string, err error) map[string]any {
	line := map[string]any{"check": check, "ok": false}
	var rpcErr *rpc.RpcError
	if errors.As(err, &rpcErr) && rpcErr != nil {
		line["code"] = string(rpcErr.Code)
		line["message"] = rpcErr.Message
		line["method"] = rpcErr.Method
		line["data"] = rpcErr.Data
		return line
	}
	line["code"] = ""
	line["message"] = fmt.Sprintf("not an *rpc.RpcError (%T): %v", err, err)
	return line
}

// handler implements the generated rpc.ClientHandler.
type handler struct{}

func (handler) HandleAsk(_ context.Context, question string) (string, error) {
	if question == "refuse" {
		return "", rpc.NewRpcError(rpc.CodeInvalidArgument, "go refuses to answer", "", nil)
	}
	return "go answered " + question, nil
}

// HandleNotify always fails. The call is fire-and-forget, so the generated
// binding has no acknowledgement to answer with and must report the failure to
// the server through __rpc:error__.
func (handler) HandleNotify(_ context.Context, text string) error {
	return rpc.NewRpcError(rpc.RpcErrorCode("GO_NOTIFY_REFUSED"), "go refused notify: "+text, "", nil)
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: goclient <url> <token>")
		os.Exit(2)
	}
	url, token := os.Args[1], os.Args[2]
	out := &reporter{encoder: json.NewEncoder(os.Stdout)}

	checkRefusedHandshake(out, url)

	dialCtx, cancelDial := context.WithTimeout(context.Background(), callTimeout)
	conn, err := rpc.Dial(dialCtx, url, handler{}, &rpc.DialOptions{
		Namespace: namespace,
		Auth:      map[string]any{"token": token},
		Timeout:   callTimeout,
	})
	cancelDial()
	if err != nil {
		out.report(errorFields("dial", err))
		os.Exit(1)
	}
	out.report(map[string]any{"check": "dial", "ok": true, "connected": conn.Connected()})

	// Registered before anything can make the server report, so no report is
	// missed. Buffered with a non-blocking send: an observer must never stall the
	// binding that delivers to it.
	reports := make(chan *rpc.RpcError, 8)
	conn.OnRpcError(func(report *rpc.RpcError) {
		select {
		case reports <- report:
		default:
		}
	})

	checkGreet(out, conn)
	checkConcurrentGreets(out, conn)
	checkInvalidArgument(out, conn)
	checkRelay(out, conn, "relay", "ping")
	checkRelay(out, conn, "relayRefused", "refuse")
	checkPushNotify(out, conn)
	checkRpcErrorFromServer(out, conn, reports)

	out.report(map[string]any{"check": "done", "ok": true})

	// Hold the connection until the test closes stdin, then shut down. Reaching
	// the final line proves Dispose returned and Done closed.
	_, _ = io.Copy(io.Discard, os.Stdin)
	conn.Dispose()
	select {
	case <-conn.Done():
	case <-time.After(callTimeout):
		fmt.Fprintln(os.Stderr, "goclient: Done did not close after Dispose")
		os.Exit(1)
	}
}

// checkRefusedHandshake dials with a token the server's middleware rejects.
// Dial must return the middleware's message as an error at once, not hang until
// the context runs out.
func checkRefusedHandshake(out *reporter, url string) {
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	started := time.Now()
	conn, err := rpc.Dial(ctx, url, handler{}, &rpc.DialOptions{
		Namespace: namespace,
		Auth:      map[string]any{"token": "wrong-token"},
		Timeout:   callTimeout,
	})
	elapsed := time.Since(started).Milliseconds()
	if err == nil {
		conn.Dispose()
		out.report(map[string]any{"check": "refused", "ok": false, "elapsedMs": elapsed})
		return
	}
	line := errorFields("refused", err)
	line["elapsedMs"] = elapsed
	out.report(line)
}

func checkGreet(out *reporter, conn *rpc.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	greeting, err := conn.CallGreet(ctx, "gopher")
	if err != nil {
		out.report(errorFields("greet", err))
		return
	}
	out.report(map[string]any{"check": "greet", "ok": true, "value": greeting})
}

// checkConcurrentGreets issues calls from many goroutines on one Conn. The
// binary is built with -race, so unsynchronized state in the generated client
// fails the process even when every reply happens to be right.
func checkConcurrentGreets(out *reporter, conn *rpc.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()

	var wg sync.WaitGroup
	failures := make(chan string, concurrentCalls)
	for i := range concurrentCalls {
		wg.Add(1)
		go func() {
			defer wg.Done()
			name := fmt.Sprintf("caller-%d", i)
			greeting, err := conn.CallGreet(ctx, name)
			switch {
			case err != nil:
				failures <- fmt.Sprintf("%s: %v", name, err)
			case greeting.Text != "hello "+name:
				failures <- fmt.Sprintf("%s: got %q", name, greeting.Text)
			}
		}()
	}
	wg.Wait()
	close(failures)

	collected := []string{}
	for failure := range failures {
		collected = append(collected, failure)
	}
	out.report(map[string]any{
		"check":    "concurrent",
		"ok":       len(collected) == 0,
		"calls":    concurrentCalls,
		"failures": collected,
	})
}

// checkInvalidArgument expects the TS handler's thrown rpcError to arrive with
// its code, message and data unchanged.
func checkInvalidArgument(out *reporter, conn *rpc.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	greeting, err := conn.CallValidate(ctx, "forbidden")
	if err == nil {
		out.report(map[string]any{"check": "invalidArgument", "ok": false, "value": greeting})
		return
	}
	line := errorFields("invalidArgument", err)
	line["isRpcError"] = rpc.IsRpcError(err)
	out.report(line)
}

// checkRelay makes the TS server call back into this client's HandleAsk while
// the Go call is still waiting on its own acknowledgement.
func checkRelay(out *reporter, conn *rpc.Conn, check string, question string) {
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	answer, err := conn.CallRelay(ctx, question)
	if err != nil {
		out.report(errorFields(check, err))
		return
	}
	out.report(map[string]any{"check": check, "ok": true, "value": answer})
}

// checkPushNotify makes the TS server push a fire-and-forget notify, whose
// handler here fails. The test asserts the server-side onRpcError report.
func checkPushNotify(out *reporter, conn *rpc.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	answer, err := conn.CallPushNotify(ctx, "bell")
	if err != nil {
		out.report(errorFields("pushNotify", err))
		return
	}
	out.report(map[string]any{"check": "pushNotify", "ok": true, "value": answer})
}

// checkRpcErrorFromServer sends a fire-and-forget call whose TS handler throws.
// The only way back is the server's __rpc:error__ report, observed through
// OnRpcError.
func checkRpcErrorFromServer(out *reporter, conn *rpc.Conn, reports <-chan *rpc.RpcError) {
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	if err := conn.CallExplode(ctx, "kaboom"); err != nil {
		out.report(errorFields("rpcErrorFromServer", err))
		return
	}
	select {
	case report := <-reports:
		out.report(map[string]any{
			"check":   "rpcErrorFromServer",
			"ok":      true,
			"code":    string(report.Code),
			"message": report.Message,
			"method":  report.Method,
		})
	case <-ctx.Done():
		out.report(map[string]any{"check": "rpcErrorFromServer", "ok": false, "message": "no __rpc:error__ report within the call timeout"})
	}
}
