// Command goserver hosts the generated Go bindings for the JSON-value contract.
//
// Like tests/fixtures/go-crosslang/goserver it implements nothing but the
// generated ServerHandler interface — every event name, argument order and
// acknowledgement shape comes from generated code. What it adds is a document
// store whose frontmatter is arbitrary JSON, so the `any` the Go backend
// projects `unknown` onto is carried through every position the contract has:
// map values, struct fields, parameters, results and slice elements.
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

	"socketrpc.jsonvalue.test/rpc"
)

// resolveTimeout bounds a server→client call. Deliberately shorter than the Bun
// test's own timeouts so a hung client surfaces as a Go-side error, not a hang.
const resolveTimeout = 2 * time.Second

// handler implements the generated rpc.ServerHandler for one connection.
type handler struct {
	// client is the generated outbound surface for this same connection. It is
	// assigned once, before the binding starts dispatching, so no lock is needed.
	client *rpc.Client

	mu sync.Mutex
	// documents holds frontmatter exactly as it arrived. Nothing here knows the
	// shape of a value, which is the whole point of the contract's `unknown`.
	documents map[string]map[string]any
	events    []string
	history   map[string][]any
}

func newHandler() *handler {
	return &handler{
		documents: map[string]map[string]any{},
		history:   map[string][]any{},
	}
}

// frontmatterOf returns the stored frontmatter for a path, creating it on first
// use. Callers hold h.mu.
func (h *handler) frontmatterOf(path string) map[string]any {
	existing, ok := h.documents[path]
	if !ok {
		existing = map[string]any{}
		h.documents[path] = existing
	}
	return existing
}

// ReadDocument returns the whole envelope. A path that was never written has no
// frontmatter at all, so the map is nil here and the generated MarshalJSON has
// to turn it into `{}` — the client's type says Record<string, unknown>, which
// null does not satisfy.
func (h *handler) HandleReadDocument(_ context.Context, path string) (rpc.Document, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	document := rpc.Document{Path: path, Body: "body of " + path}
	if stored, ok := h.documents[path]; ok {
		document.Frontmatter = stored
	}
	return document, nil
}

// ApplyMutation writes one arbitrary JSON value into one frontmatter key. The
// value arrives inside a named struct, so it exercises a JSON value nested in a
// generated type rather than sitting in a bare parameter.
func (h *handler) HandleApplyMutation(_ context.Context, mutation rpc.Mutation) (rpc.Document, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if mutation.Key == "" {
		return rpc.Document{}, rpc.NewRpcError(rpc.CodeInvalidArgument, "key is required", "", nil)
	}

	frontmatter := h.frontmatterOf(mutation.Path)
	frontmatter[mutation.Key] = mutation.Value
	h.history[mutation.Path] = append(h.history[mutation.Path], mutation.Value)

	return rpc.Document{
		Path:        mutation.Path,
		Frontmatter: frontmatter,
		Body:        "body of " + mutation.Path,
	}, nil
}

// ReadKey answers with a bare JSON value. A missing key answers nil, which
// encodes as JSON null — a value the client's `unknown` accepts.
func (h *handler) HandleReadKey(_ context.Context, path string, key string) (any, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.documents[path][key], nil
}

// MergeFrontmatter takes and returns the named `Record<string, unknown>` alias,
// which Go spells as one `map[string]any` on both sides.
func (h *handler) HandleMergeFrontmatter(_ context.Context, path string, patch rpc.Frontmatter) (rpc.Frontmatter, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	frontmatter := h.frontmatterOf(path)
	for key, value := range patch {
		frontmatter[key] = value
	}

	merged := make(rpc.Frontmatter, len(frontmatter))
	for key, value := range frontmatter {
		merged[key] = value
	}
	return merged, nil
}

// RecordEvent is fire-and-forget: no acknowledgement travels with it, so the
// JSON payload's arrival is only observable through ReadEvents.
func (h *handler) HandleRecordEvent(_ context.Context, name string, payload any) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.events = append(h.events, fmt.Sprintf("%s=%#v", name, payload))
	return nil
}

func (h *handler) HandleReadEvents(_ context.Context) ([]string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.events...), nil
}

// History returns a slice of JSON values, nil until something has been written.
// The client's type says `unknown[]`, so nil must still arrive as `[]`.
func (h *handler) HandleHistory(_ context.Context, path string) ([]any, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]any(nil), h.history[path]...), nil
}

// UnencodableValue returns something Go is happy to hold in an `any` and
// encoding/json refuses outright. The generated preflight has to catch it and
// answer with INTERNAL_ERROR; letting it reach Socket.IO's write path would drop
// the reply silently and strand the caller until its own timeout fired.
func (h *handler) HandleUnencodableValue(_ context.Context) (any, error) {
	return make(chan int), nil
}

// SyncBack drives the generated *outbound* surface with JSON values: a
// fire-and-forget push carrying frontmatter, then an acknowledged call whose
// result is whatever JSON the TypeScript client decided to answer with.
func (h *handler) HandleSyncBack(ctx context.Context, path string) (any, error) {
	h.mu.Lock()
	frontmatter := make(rpc.Frontmatter, len(h.documents[path]))
	for key, value := range h.documents[path] {
		frontmatter[key] = value
	}
	incoming := h.documents[path]["title"]
	h.mu.Unlock()

	if err := h.client.CallDocumentChanged(ctx, path, frontmatter); err != nil {
		return nil, err
	}

	resolveCtx, cancel := context.WithTimeout(ctx, resolveTimeout)
	defer cancel()

	resolved, err := h.client.CallResolveConflict(resolveCtx, "title", incoming)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": path, "resolved": resolved}, nil
}

func serve(raw *socket.Socket) {
	h := newHandler()

	client, err := rpc.NewClient(raw, &rpc.ClientOptions{Timeout: resolveTimeout})
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
