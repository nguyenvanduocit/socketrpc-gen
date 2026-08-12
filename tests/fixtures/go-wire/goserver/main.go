// Command goserver is a handcrafted Socket.IO server that speaks the
// socketrpc-gen wire protocol. It exists so tests/go-wire.integration.test.ts can
// drive the *generated TypeScript client* against a non-TypeScript peer and prove
// the protocol is a real wire contract rather than a JS-to-JS convention.
//
// Nothing here imports the generator. Every event name, argument order and
// acknowledgement shape is written out by hand from ../define.ts, which is the
// point: if the generated client and this file agree, the protocol is portable.
//
// Wire contract, as implemented below:
//
//   - A value-returning call arrives as [args..., ack]. socket.io appends the ack
//     only when the client's packet carried an ack id. Reply with exactly ONE
//     element: ack([]any{result}, nil).
//   - A fire-and-forget call arrives as [args...] with no ack appended.
//   - A failure is not a transport error: reply through the same ack slot with a
//     branded RpcError object (see rpcError below).
//   - Calling into the client mirrors this: Emit for fire-and-forget,
//     Timeout(d).EmitWithAck(...) for a value-returning call.
//
// The server binds 127.0.0.1:0 and prints "LISTENING <host:port>" on stdout once
// the listener is up; that line is the readiness signal the Bun test waits on.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/zishang520/socket.io/servers/socket/v3"
)

// askTimeout bounds a server→client call. Deliberately shorter than the Bun
// test's own timeouts so a hung client surfaces as a Go-side error, not a hang.
const askTimeout = 2 * time.Second

// rpcError mirrors the branded RpcError in the generated types.generated.ts.
// The `__rpcError` brand is the whole contract: isRpcError() checks that field
// and nothing else, so a payload without it reads as a successful result on the
// TypeScript side no matter how error-shaped it looks.
type rpcError struct {
	Brand   bool   `json:"__rpcError"`
	Message string `json:"message"`
	Code    string `json:"code"`
	Method  string `json:"method,omitempty"`
	Data    any    `json:"data,omitempty"`
}

func newRpcError(code, message, method string, data any) rpcError {
	return rpcError{Brand: true, Code: code, Message: message, Method: method, Data: data}
}

// echoResult is the success payload for `echo`.
type echoResult struct {
	ID      string `json:"id"`
	Payload string `json:"payload"`
}

// receiptResult is a success payload deliberately shaped like an error. It proves
// the brand — not the `{ message, code }` shape — is what classifies a response.
type receiptResult struct {
	Message string `json:"message"`
	Code    string `json:"code"`
}

// splitAck separates the trailing acknowledgement callback socket.io appends when
// the inbound packet carried an ack id. socket.Ack is an alias for
// func([]any, error), so the type assertion matches the value the library appends.
// Fire-and-forget calls arrive without one and yield a nil ack.
func splitAck(args []any) ([]any, socket.Ack) {
	if len(args) == 0 {
		return args, nil
	}
	if ack, ok := args[len(args)-1].(socket.Ack); ok {
		return args[:len(args)-1], ack
	}
	return args, nil
}

// argString reads a positional string argument. Arguments arrive as decoded JSON,
// so strings are string, numbers are float64 and objects are map[string]any.
func argString(args []any, i int) string {
	if i < 0 || i >= len(args) {
		return ""
	}
	s, _ := args[i].(string)
	return s
}

// session is the per-connection state the handlers share.
type session struct {
	mu    sync.Mutex
	notes []string
}

func (s *session) record(note string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.notes = append(s.notes, note)
}

func (s *session) snapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.notes))
	copy(out, s.notes)
	return out
}

// wire registers every handler from ServerFunctions in ../define.ts.
//
// Listeners run on a queue that the library serializes per socket ("mimics
// Node.js's event loop"), so any handler that waits — sleeping, or awaiting a
// client acknowledgement — runs its body in a goroutine. Blocking inline would
// stall every later event on the same connection.
func wire(client *socket.Socket) {
	state := &session{}

	// echo: the ordinary success path — a value-returning call answered with an object.
	client.On("echo", func(args ...any) {
		params, ack := splitAck(args)
		if ack == nil {
			return
		}
		ack([]any{echoResult{ID: argString(params, 0), Payload: argString(params, 1)}}, nil)
	})

	// failTyped: a failure travels through the ack slot as a branded error, with a
	// non-standard code and a data payload, so the client sees a typed rejection
	// rather than a transport fault.
	client.On("failTyped", func(args ...any) {
		params, ack := splitAck(args)
		if ack == nil {
			return
		}
		reason := argString(params, 0)
		ack([]any{newRpcError(
			"GO_REFUSED",
			"go server refused: "+reason,
			"failTyped",
			map[string]any{"reason": reason},
		)}, nil)
	})

	// note: fire-and-forget. A void signature must arrive with no ack appended;
	// recording the violation lets the client assert that from the other end.
	client.On("note", func(args ...any) {
		params, ack := splitAck(args)
		text := argString(params, 0)
		if ack != nil {
			state.record("UNEXPECTED_ACK:" + text)
			return
		}
		state.record(text)
	})

	// readNotes: reads back what `note` delivered, making fire-and-forget observable.
	client.On("readNotes", func(args ...any) {
		if _, ack := splitAck(args); ack != nil {
			ack([]any{state.snapshot()}, nil)
		}
	})

	// neverAck: the ack is deliberately dropped, leaving the client to time out on
	// its own clock.
	client.On("neverAck", func(args ...any) {})

	// dropWhileInFlight: close the connection with the call still outstanding, so
	// the client settles it from the disconnect rather than the timeout.
	client.On("dropWhileInFlight", func(args ...any) {
		go func() {
			time.Sleep(50 * time.Millisecond)
			client.Disconnect(true)
		}()
	})

	// receipt: a success that happens to carry `message` and `code`.
	client.On("receipt", func(args ...any) {
		params, ack := splitAck(args)
		if ack == nil {
			return
		}
		ack([]any{receiptResult{Message: "receipt for " + argString(params, 0), Code: "PAID"}}, nil)
	})

	// roundTrip: the bidirectional path. Go pushes a fire-and-forget `notify`, then
	// makes a value-returning `ask` call into the client, then folds the client's
	// answer into the reply to the original call.
	client.On("roundTrip", func(args ...any) {
		params, ack := splitAck(args)
		if ack == nil {
			return
		}
		question := argString(params, 0)

		go func() {
			// Fire-and-forget into the client: no ack callback appended.
			if err := client.Emit("notify", "pushed:"+question); err != nil {
				ack([]any{newRpcError("INTERNAL_ERROR", err.Error(), "roundTrip", nil)}, nil)
				return
			}

			// Value-returning call into the client. Timeout() sets a flag consumed by
			// the very next emit on this socket, so the two must stay adjacent.
			answered := make(chan []any, 1)
			failed := make(chan error, 1)
			client.Timeout(askTimeout).EmitWithAck("ask", question)(func(reply []any, err error) {
				if err != nil {
					failed <- err
					return
				}
				answered <- reply
			})

			select {
			case reply := <-answered:
				ack([]any{"go saw: " + argString(reply, 0)}, nil)
			case err := <-failed:
				ack([]any{newRpcError("INTERNAL_ERROR", err.Error(), "roundTrip", nil)}, nil)
			}
		}()
	})
}

func main() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}

	ioServer := socket.NewServer(nil, nil)
	ioServer.On("connection", func(clients ...any) {
		client, ok := clients[0].(*socket.Socket)
		if !ok {
			return
		}
		wire(client)
	})

	mux := http.NewServeMux()
	mux.Handle("/socket.io/", ioServer.ServeHandler(nil))
	server := &http.Server{Handler: mux}

	serveErr := make(chan error, 1)
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	// Readiness. os.Stdout is unbuffered, so this line reaches the parent as soon
	// as the listener is accepting — the Bun test blocks on it before connecting.
	fmt.Printf("LISTENING %s\n", listener.Addr().String())

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)

	// A closed stdin means the Bun test died without killing us. Exit rather than
	// linger as an orphan holding a port.
	parentGone := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		close(parentGone)
	}()

	select {
	case err := <-serveErr:
		fmt.Fprintf(os.Stderr, "serve: %v\n", err)
		os.Exit(1)
	case <-signals:
	case <-parentGone:
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}
