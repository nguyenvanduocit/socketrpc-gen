// Command goserver hosts the *generated* Go RPC bindings.
//
// tests/fixtures/go-wire/goserver writes the wire protocol out by hand to prove
// a Go implementer could satisfy it. This server does the opposite: it imports
// the package socketrpc-gen emits and implements nothing but the generated
// ServerHandler interface. Everything about event names, argument order,
// acknowledgement shape and error branding comes from generated code, so when
// the generated TypeScript client agrees with this process, both backends
// agree — and they were driven from one canonical RpcSchema.
//
// The `rpc` package is written into ./rpc by the test before `go build` runs.
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

	"socketrpc.crosslang.test/rpc"
)

// askTimeout bounds a server→client call. Deliberately shorter than the Bun
// test's own timeouts so a hung client surfaces as a Go-side error, not a hang.
const askTimeout = 2 * time.Second

// handler implements the generated rpc.ServerHandler for one connection.
type handler struct {
	socket *socket.Socket

	// client is the generated outbound surface for this same connection. It is
	// assigned once, before the binding starts dispatching, so no lock is needed.
	client *rpc.Client

	mu        sync.Mutex
	notes     []string
	rpcErrors []string
}

func (h *handler) HandleEcho(_ context.Context, id string, payload string) (rpc.Echo, error) {
	// `note` is an optional field: leaving it nil proves `omitempty` keeps the key
	// off the wire, which the TypeScript side asserts.
	return rpc.Echo{ID: id, Payload: payload}, nil
}

// HandleFailTyped returns a branded error with a custom code and structured data. The
// generated binding forwards it through the same ack slot as a success.
func (h *handler) HandleFailTyped(_ context.Context, reason string) (rpc.Echo, error) {
	return rpc.Echo{}, rpc.NewRpcError(
		rpc.RpcErrorCode("GO_REFUSED"),
		"go server refused: "+reason,
		"",
		map[string]any{"reason": reason},
	)
}

// HandleFailPanic proves the generated recover turns a handler panic into an
// INTERNAL_ERROR acknowledgement rather than killing the process.
func (h *handler) HandleFailPanic(_ context.Context, reason string) (rpc.Echo, error) {
	panic("go handler panicked: " + reason)
}

func (h *handler) HandleNote(_ context.Context, text string, priority rpc.Priority) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.notes = append(h.notes, string(priority)+":"+text)
	return nil
}

func (h *handler) HandleReadNotes(_ context.Context) ([]string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.notes...), nil
}

// recordRpcError is wired to the binding's OnRpcError observer, which is the
// only way this side learns that a fire-and-forget call into the client failed.
func (h *handler) recordRpcError(failure *rpc.RpcError) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.rpcErrors = append(h.rpcErrors, string(failure.Code)+":"+failure.Origin+":"+failure.Message)
}

// HandleReadRPCErrors deliberately returns a nil slice while nothing has been
// reported, so the generated normalization is exercised on a real reply: the
// TypeScript client's type says string[] and must never see null. The name
// comes from the contract's `readRpcErrors` through Go's initialism rules.
func (h *handler) HandleReadRPCErrors(_ context.Context) ([]string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.rpcErrors...), nil
}

// HandleNeverAck blocks until the binding's context is cancelled, so the call is
// answered by the TypeScript client's own timeout rather than by Go. Because the
// generated binding dispatches each inbound event on its own goroutine, later
// calls on the same socket keep flowing while this one hangs.
func (h *handler) HandleNeverAck(ctx context.Context, _ string) (rpc.Echo, error) {
	<-ctx.Done()
	return rpc.Echo{}, ctx.Err()
}

// HandleDropWhileInFlight closes the connection with the call outstanding, so the
// client settles as DISCONNECTED rather than TIMEOUT.
func (h *handler) HandleDropWhileInFlight(ctx context.Context, _ string) (rpc.Echo, error) {
	go func() {
		time.Sleep(50 * time.Millisecond)
		h.socket.Disconnect(true)
	}()
	<-ctx.Done()
	return rpc.Echo{}, ctx.Err()
}

// HandleReceipt returns a success that is shaped like an error. Without the
// `__rpcError` brand the TypeScript side must still read it as a value.
func (h *handler) HandleReceipt(_ context.Context, id string) (rpc.Receipt, error) {
	return rpc.Receipt{Message: "receipt for " + id, Code: "PAID"}, nil
}

// HandleRoundTrip drives the generated *outbound* surface: a fire-and-forget push
// followed by a value-returning call, both through rpc.Client.
func (h *handler) HandleRoundTrip(ctx context.Context, question string) (string, error) {
	if err := h.client.CallNotify(ctx, "pushed:"+question); err != nil {
		return "", err
	}

	askCtx, cancel := context.WithTimeout(ctx, askTimeout)
	defer cancel()

	answer, err := h.client.CallAsk(askCtx, question)
	if err != nil {
		return "", err
	}
	return "go saw: " + answer, nil
}

func serve(raw *socket.Socket) {
	h := &handler{socket: raw}

	client, err := rpc.NewClient(raw, &rpc.ClientOptions{Timeout: askTimeout})
	if err != nil {
		fmt.Fprintf(os.Stderr, "new client: %v\n", err)
		return
	}
	h.client = client

	binding, err := rpc.BindServer(raw, h)
	if err != nil {
		client.Dispose()
		fmt.Fprintf(os.Stderr, "bind server: %v\n", err)
		return
	}

	binding.OnRpcError(h.recordRpcError)

	// The binding removes its own listeners on disconnect; the outbound client
	// has to be released alongside it.
	go func() {
		<-binding.Context().Done()
		client.Dispose()
	}()
}

func main() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}

	ioServer := socket.NewServer(nil, nil)
	ioServer.On("connection", func(clients ...any) {
		raw, ok := clients[0].(*socket.Socket)
		if !ok {
			return
		}
		serve(raw)
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
