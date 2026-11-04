// Package e2e drives the generated Go client against the generated Go server.
//
// tests/go-client.integration.test.ts generates both sides from
// tests/fixtures/go-client/define.ts with one CLI invocation, into two packages
// of this module: `wire` holds the contract types and the server, `wireclient`
// holds the client and imports `wire` for every contract type. This file
// contributes only the two handler implementations and a server harness; every
// event name, argument order, acknowledgement and error code comes from
// generated code.
//
// The server runs in this process on 127.0.0.1, under the namespaces /runtime
// and /worker, behind a middleware that reads the handshake's auth payload. The
// harness can drop the server two ways, so reconnect is proven against both: a
// kill closes the listener and every accepted TCP connection at once, as a
// crashed process would, and a graceful stop runs Server.Close first.
//
// Every assertion is on what a caller observes: return values, error codes,
// lifecycle events and timing. Messages are compared only where the message is
// the requirement (the middleware's refusal reaching Dial).
package e2e

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	sioclient "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/socket"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/types"
	sioserver "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/socket"

	"socketrpc.goclient.test/wire"
	"socketrpc.goclient.test/wireclient"
)

const (
	goodToken = "good-token"
	// refusal is what the auth middleware answers a bad token with. Dial must
	// hand exactly this text to its caller.
	refusal = "unauthorized: token rejected"

	// generatedTimeout is the `--timeout` the test file passes to the CLI. A
	// call made with no deadline of its own and no DialOptions.Timeout must be
	// bounded by it.
	generatedTimeout = 1500 * time.Millisecond

	// payloadLimit is the server's default maxHttpBufferSize, which it
	// advertises in the Engine.IO handshake.
	payloadLimit = 1_000_000
)

var namespaces = []string{"/runtime", "/worker"}

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------

// authLog counts accepted handshakes per namespace. It outlives a server, so a
// restart on the same address keeps counting: a reconnect that re-sends auth
// shows up as one more accepted handshake.
type authLog struct {
	mu       sync.Mutex
	accepted map[string]int
}

func newAuthLog() *authLog {
	return &authLog{accepted: map[string]int{}}
}

func (a *authLog) accept(namespace string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.accepted[namespace]++
}

func (a *authLog) count(namespace string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.accepted[namespace]
}

// session is the server's view of one client connection: the generated binding
// that answers client-to-server calls and the generated Client that makes
// server-to-client ones.
type session struct {
	namespace string
	binding   *wire.ServerBinding
	client    *wire.Client
	rpcErrors chan *wire.RpcError
}

// trackingListener remembers every connection it accepts, so kill can close
// them all at once. http.Server cannot: a WebSocket connection is hijacked and
// leaves the server's bookkeeping.
type trackingListener struct {
	net.Listener

	mu     sync.Mutex
	conns  []net.Conn
	killed bool
}

func (l *trackingListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.killed {
		_ = conn.Close()
		return nil, net.ErrClosed
	}
	l.conns = append(l.conns, conn)
	return conn, nil
}

func (l *trackingListener) kill() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.killed = true
	_ = l.Listener.Close()
	for _, conn := range l.conns {
		_ = conn.Close()
	}
	l.conns = nil
}

type testServer struct {
	addr     string
	io       *sioserver.Server
	http     *http.Server
	listener *trackingListener
	auth     *authLog

	// sessions receives every connection the server binds, per namespace.
	sessions map[string]chan *session
	// held receives the id of every `hold` call the server has started.
	held chan string

	stopOnce sync.Once
}

// startServer serves both namespaces on addr ("127.0.0.1:0" for a fresh port,
// or a previous server's address to restart it there).
func startServer(t *testing.T, addr string, auth *authLog) *testServer {
	t.Helper()
	srv := &testServer{
		io:       sioserver.NewServer(nil, nil),
		auth:     auth,
		sessions: map[string]chan *session{},
		held:     make(chan string, 16),
	}
	for _, name := range namespaces {
		srv.sessions[name] = make(chan *session, 64)
		nsp := srv.io.Of(name, nil)
		nsp.Use(func(raw *sioserver.Socket, next func(*sioserver.ExtendedError)) {
			token, _ := raw.Handshake().Auth["token"].(string)
			if token != goodToken {
				next(sioserver.NewExtendedError(refusal, nil))
				return
			}
			auth.accept(name)
			next(nil)
		})
		if err := nsp.On("connection", func(args ...any) {
			raw, ok := args[0].(*sioserver.Socket)
			if !ok {
				return
			}
			srv.serve(raw)
		}); err != nil {
			t.Fatalf("register connection on %s: %v", name, err)
		}
	}

	mux := http.NewServeMux()
	mux.Handle("/socket.io/", srv.io.ServeHandler(nil))
	srv.http = &http.Server{Handler: mux}
	srv.listener = &trackingListener{Listener: listen(t, addr)}
	srv.addr = srv.listener.Addr().String()
	go func() { _ = srv.http.Serve(srv.listener) }()

	t.Cleanup(srv.stop)
	return srv
}

// listen retries briefly so a restart can take over the address a stopped
// server just released.
func listen(t *testing.T, addr string) net.Listener {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		listener, err := net.Listen("tcp", addr)
		if err == nil {
			return listener
		}
		if time.Now().After(deadline) {
			t.Fatalf("listen %s: %v", addr, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (s *testServer) url() string {
	return "http://" + s.addr
}

func (s *testServer) serve(raw *sioserver.Socket) {
	client, err := wire.NewClient(raw, &wire.ClientOptions{Timeout: 10 * time.Second})
	if err != nil {
		return
	}
	binding, err := wire.BindServer(raw, &serverHandler{raw: raw, held: s.held})
	if err != nil {
		client.Dispose()
		return
	}
	bound := &session{
		namespace: raw.Nsp().Name(),
		binding:   binding,
		client:    client,
		rpcErrors: make(chan *wire.RpcError, 16),
	}
	binding.OnRpcError(func(failure *wire.RpcError) {
		select {
		case bound.rpcErrors <- failure:
		default:
		}
	})
	go func() {
		<-binding.Context().Done()
		client.Dispose()
	}()
	select {
	case s.sessions[bound.namespace] <- bound:
	default: // TestDialRace binds thousands; nobody reads them.
	}
}

// session waits for the next connection the server binds on namespace.
func (s *testServer) session(t *testing.T, namespace string) *session {
	t.Helper()
	select {
	case bound := <-s.sessions[namespace]:
		return bound
	case <-time.After(5 * time.Second):
		t.Fatalf("server bound no connection on %s within 5s", namespace)
		return nil
	}
}

// kill drops the server the way a crashed process does: the listener and every
// TCP connection close at once, and nothing is said on the wire first.
func (s *testServer) kill() {
	s.listener.kill()
}

// stop shuts the server down gracefully: Server.Close, then the HTTP server.
func (s *testServer) stop() {
	s.stopOnce.Do(func() {
		s.io.Close(nil)
		_ = s.http.Close()
		s.listener.kill()
	})
}

// serverHandler implements the generated wire.ServerHandler for one connection.
type serverHandler struct {
	raw  *sioserver.Socket
	held chan string

	mu    sync.Mutex
	notes []string
}

func (h *serverHandler) HandleEcho(_ context.Context, text string) (string, error) {
	return text, nil
}

func (h *serverHandler) HandleMeasure(_ context.Context, blob string) (float64, error) {
	return float64(len(blob)), nil
}

func (h *serverHandler) HandleWhoAmI(_ context.Context) (wire.Session, error) {
	token, _ := h.raw.Handshake().Auth["token"].(string)
	return wire.Session{Namespace: h.raw.Nsp().Name(), Token: token}, nil
}

func (h *serverHandler) HandleNote(_ context.Context, text string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.notes = append(h.notes, text)
	return nil
}

func (h *serverHandler) HandleReadNotes(_ context.Context) ([]string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.notes...), nil
}

// HandleHold never answers: it returns only once the binding is torn down, so
// the caller's own timeout, context or connection loss is what settles it.
func (h *serverHandler) HandleHold(ctx context.Context, id string) (string, error) {
	select {
	case h.held <- id:
	default:
	}
	<-ctx.Done()
	return "", ctx.Err()
}

// ---------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------

// clientHandler implements the generated wireclient.ClientHandler. One value
// serves a Conn for its whole life, reconnects included.
type clientHandler struct {
	mu      sync.Mutex
	records []float64

	stallEntered chan string
	stallRelease chan struct{}
}

func newClientHandler() *clientHandler {
	return &clientHandler{
		stallEntered: make(chan string, 4),
		stallRelease: make(chan struct{}),
	}
}

func (h *clientHandler) HandleRunJob(_ context.Context, job wire.Job) (wire.JobResult, error) {
	return wire.JobResult{ID: job.ID, Output: "done:" + job.Input}, nil
}

// HandleRecord panics on a negative seq, so a failing fire-and-forget handler
// can be observed from the server. Every seventh call sleeps, which would let a
// later call overtake it if the client dispatched one method concurrently.
func (h *clientHandler) HandleRecord(_ context.Context, seq float64) error {
	if seq < 0 {
		panic(fmt.Sprintf("record refused %v", seq))
	}
	if int(seq)%7 == 0 {
		time.Sleep(time.Millisecond)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.records = append(h.records, seq)
	return nil
}

func (h *clientHandler) recorded() []float64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]float64(nil), h.records...)
}

func (h *clientHandler) HandleStall(ctx context.Context, id string) (string, error) {
	h.stallEntered <- id
	select {
	case <-h.stallRelease:
		return "released:" + id, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (h *clientHandler) HandleAsk(_ context.Context, question string) (string, error) {
	switch question {
	case "panic":
		panic("ask panicked")
	case "refuse":
		return "", wire.NewRpcError(wire.RpcErrorCode("CLIENT_REFUSED"), "client refused", "", nil)
	}
	return "answer:" + question, nil
}

// managerOptions keeps the transport to WebSocket and the reconnect backoff
// short, so a dropped connection is retried within a test's patience.
func managerOptions() sioclient.ManagerOptionsInterface {
	opts := sioclient.DefaultManagerOptions()
	opts.SetTransports(types.NewSet(sioclient.WebSocket))
	opts.SetReconnectionDelay(20)
	opts.SetReconnectionDelayMax(100)
	return opts
}

func dialOptions(namespace string) *wireclient.DialOptions {
	return &wireclient.DialOptions{
		Namespace: namespace,
		Auth:      map[string]any{"token": goodToken},
		Manager:   managerOptions(),
	}
}

// dial connects one client and disposes it when the test ends.
func dial(t *testing.T, srv *testServer, options *wireclient.DialOptions) (*wireclient.Conn, *clientHandler) {
	t.Helper()
	handler := newClientHandler()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := wireclient.Dial(ctx, srv.url(), handler, options)
	if err != nil {
		t.Fatalf("Dial %s%s: %v", srv.url(), options.Namespace, err)
	}
	t.Cleanup(conn.Dispose)
	return conn, handler
}

func rpcError(err error) *wire.RpcError {
	var failure *wire.RpcError
	if errors.As(err, &failure) {
		return failure
	}
	return nil
}

func requireCode(t *testing.T, err error, want wire.RpcErrorCode, what string) *wire.RpcError {
	t.Helper()
	failure := rpcError(err)
	if failure == nil {
		t.Fatalf("%s: got %v (%T), want a *wire.RpcError with code %s", what, err, err, want)
	}
	if failure.Code != want {
		t.Fatalf("%s: got code %s (%v), want %s", what, failure.Code, failure, want)
	}
	return failure
}

func callCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// eventually polls cond until it holds or the deadline passes.
func eventually(t *testing.T, within time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s: not reached within %s", what, within)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func receive[T any](t *testing.T, ch <-chan T, within time.Duration, what string) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(within):
		t.Fatalf("%s: nothing within %s", what, within)
		var zero T
		return zero
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestRepliesInBothDirectionsOnEveryNamespace(t *testing.T) {
	auth := newAuthLog()
	srv := startServer(t, "127.0.0.1:0", auth)

	for _, namespace := range namespaces {
		t.Run(strings.TrimPrefix(namespace, "/"), func(t *testing.T) {
			conn, _ := dial(t, srv, dialOptions(namespace))
			ctx := callCtx(t)

			echoed, err := conn.CallEcho(ctx, "hello")
			if err != nil || echoed != "hello" {
				t.Fatalf("CallEcho = %q, %v; want \"hello\", nil", echoed, err)
			}

			// The middleware read the auth payload, and the binding that answered
			// is the one on the namespace Dial asked for.
			who, err := conn.CallWhoAmI(ctx)
			if err != nil {
				t.Fatalf("CallWhoAmI: %v", err)
			}
			if want := (wire.Session{Namespace: namespace, Token: goodToken}); who != want {
				t.Fatalf("CallWhoAmI = %+v, want %+v", who, want)
			}
			if got := auth.count(namespace); got != 1 {
				t.Fatalf("accepted handshakes on %s = %d, want 1", namespace, got)
			}

			// Server to client, through the handler Dial was given.
			bound := srv.session(t, namespace)
			result, err := bound.client.CallRunJob(ctx, wire.Job{ID: "j1", Input: namespace})
			if err != nil {
				t.Fatalf("server CallRunJob: %v", err)
			}
			if want := (wire.JobResult{ID: "j1", Output: "done:" + namespace}); result != want {
				t.Fatalf("server CallRunJob = %+v, want %+v", result, want)
			}
		})
	}
}

func TestFireAndForgetReachesTheServerInOrder(t *testing.T) {
	srv := startServer(t, "127.0.0.1:0", newAuthLog())
	conn, _ := dial(t, srv, dialOptions("/runtime"))
	ctx := callCtx(t)

	sent := []string{"first", "second", "third", "fourth", "fifth"}
	for _, text := range sent {
		if err := conn.CallNote(ctx, text); err != nil {
			t.Fatalf("CallNote(%q): %v", text, err)
		}
	}

	// `note` carries no acknowledgement, so delivery is visible only through a
	// later call; readNotes has its own queue and can overtake, hence the poll.
	var notes []string
	eventually(t, 5*time.Second, "every note recorded", func() bool {
		var err error
		notes, err = conn.CallReadNotes(ctx)
		return err == nil && len(notes) >= len(sent)
	})
	if !reflect.DeepEqual(notes, sent) {
		t.Fatalf("notes = %v, want %v", notes, sent)
	}
}

func TestRefusedHandshakeReturnsTheServerMessage(t *testing.T) {
	auth := newAuthLog()
	srv := startServer(t, "127.0.0.1:0", auth)

	options := dialOptions("/runtime")
	options.Auth = map[string]any{"token": "stolen"}

	// A generous ctx, so a Dial that waited for it instead of reading the
	// refusal would be caught by the 2s bound below.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	conn, err := wireclient.Dial(ctx, srv.url(), newClientHandler(), options)
	elapsed := time.Since(start)
	if conn != nil {
		conn.Dispose()
		t.Fatal("Dial returned a Conn for a refused handshake")
	}
	if elapsed > 2*time.Second {
		t.Fatalf("Dial took %s to report the refusal, want under 2s", elapsed)
	}
	failure := requireCode(t, err, wire.CodeDisconnected, "Dial with a bad token")
	if failure.Message != refusal {
		t.Fatalf("Dial refusal message = %q, want the middleware's %q", failure.Message, refusal)
	}
	if got := auth.count("/runtime"); got != 0 {
		t.Fatalf("accepted handshakes = %d, want 0", got)
	}
}

func TestDialHonoursItsContext(t *testing.T) {
	// An address nothing listens on: Dial keeps retrying until its ctx ends.
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	url := "http://" + probe.Addr().String()
	_ = probe.Close()

	t.Run("deadline", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer cancel()
		start := time.Now()
		conn, err := wireclient.Dial(ctx, url, newClientHandler(), dialOptions("/runtime"))
		if conn != nil {
			conn.Dispose()
			t.Fatal("Dial returned a Conn with no server")
		}
		requireCode(t, err, wire.CodeTimeout, "Dial past its deadline")
		if elapsed := time.Since(start); elapsed > 2*time.Second {
			t.Fatalf("Dial returned %s after its 300ms deadline", elapsed)
		}
	})

	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(100*time.Millisecond, cancel)
		conn, err := wireclient.Dial(ctx, url, newClientHandler(), dialOptions("/runtime"))
		if conn != nil {
			conn.Dispose()
			t.Fatal("Dial returned a Conn with no server")
		}
		requireCode(t, err, wire.CodeAborted, "Dial with a cancelled ctx")
	})
}

func TestReconnectsAfterTheServerIsKilled(t *testing.T) {
	testReconnect(t, (*testServer).kill)
}

func TestReconnectsAfterAGracefulServerClose(t *testing.T) {
	testReconnect(t, (*testServer).stop)
}

// testReconnect drops the server with drop, restarts it on the same address,
// and requires the Conn to come back by itself: OnConnect fires, the auth
// payload is presented again, and the handler Dial was given still answers.
func testReconnect(t *testing.T, drop func(*testServer)) {
	auth := newAuthLog()
	srv := startServer(t, "127.0.0.1:0", auth)
	conn, _ := dial(t, srv, dialOptions("/runtime"))
	srv.session(t, "/runtime")

	connects := make(chan struct{}, 4)
	conn.OnConnect(func() {
		select {
		case connects <- struct{}{}:
		default:
		}
	})
	disconnects := make(chan string, 4)
	conn.OnDisconnect(func(reason string) {
		select {
		case disconnects <- reason:
		default:
		}
	})

	drop(srv)
	receive(t, disconnects, 5*time.Second, "OnDisconnect after the server went away")
	if conn.Connected() {
		t.Fatal("Connected() is true after OnDisconnect")
	}

	// A call made while the connection is down fails at once rather than
	// waiting for a reconnect that may never come.
	start := time.Now()
	_, err := conn.CallEcho(context.Background(), "offline")
	requireCode(t, err, wire.CodeDisconnected, "CallEcho while disconnected")
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("offline CallEcho took %s, want under 1s", elapsed)
	}

	restarted := startServer(t, srv.addr, auth)
	receive(t, connects, 10*time.Second, "OnConnect after the server came back")
	if !conn.Connected() {
		t.Fatal("Connected() is false after OnConnect")
	}
	select {
	case <-conn.Done():
		t.Fatalf("Done closed on a recoverable drop (Err: %v)", conn.Err())
	default:
	}

	if got := auth.count("/runtime"); got != 2 {
		t.Fatalf("accepted handshakes = %d, want 2 (the reconnect must present auth again)", got)
	}

	ctx := callCtx(t)
	who, err := conn.CallWhoAmI(ctx)
	if err != nil {
		t.Fatalf("CallWhoAmI after reconnect: %v", err)
	}
	if who.Token != goodToken {
		t.Fatalf("token after reconnect = %q, want %q", who.Token, goodToken)
	}

	bound := restarted.session(t, "/runtime")
	result, err := bound.client.CallRunJob(ctx, wire.Job{ID: "j2", Input: "again"})
	if err != nil {
		t.Fatalf("server CallRunJob after reconnect: %v", err)
	}
	if result.Output != "done:again" {
		t.Fatalf("server CallRunJob after reconnect = %+v", result)
	}
}

func TestInFlightCallFailsPromptlyWhenTheConnectionDrops(t *testing.T) {
	srv := startServer(t, "127.0.0.1:0", newAuthLog())
	options := dialOptions("/runtime")
	options.Timeout = 30 * time.Second
	conn, _ := dial(t, srv, options)

	settled := make(chan error, 1)
	go func() {
		_, err := conn.CallHold(context.Background(), "h1")
		settled <- err
	}()
	receive(t, srv.held, 5*time.Second, "server started hold")

	start := time.Now()
	srv.kill()
	err := receive(t, settled, time.Second, "in-flight CallHold after the server was killed")
	requireCode(t, err, wire.CodeDisconnected, "in-flight CallHold")
	t.Logf("in-flight call settled %s after the drop", time.Since(start))
}

func TestCallsAreBoundedByContextAndTheGeneratedTimeout(t *testing.T) {
	srv := startServer(t, "127.0.0.1:0", newAuthLog())
	conn, _ := dial(t, srv, dialOptions("/runtime"))

	t.Run("deadline", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		_, err := conn.CallHold(ctx, "deadline")
		failure := requireCode(t, err, wire.CodeTimeout, "CallHold past its ctx deadline")
		if failure.Method != "hold" {
			t.Fatalf("Method = %q, want \"hold\"", failure.Method)
		}
	})

	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(100*time.Millisecond, cancel)
		_, err := conn.CallHold(ctx, "cancel")
		requireCode(t, err, wire.CodeAborted, "CallHold with a cancelled ctx")
	})

	t.Run("generated default", func(t *testing.T) {
		start := time.Now()
		_, err := conn.CallHold(context.Background(), "default")
		elapsed := time.Since(start)
		requireCode(t, err, wire.CodeTimeout, "CallHold with no deadline of its own")
		if elapsed < generatedTimeout-200*time.Millisecond || elapsed > generatedTimeout+3*time.Second {
			t.Fatalf("CallHold timed out after %s, want about the generated %s", elapsed, generatedTimeout)
		}
	})

	// None of the above broke the connection.
	if _, err := conn.CallEcho(callCtx(t), "still up"); err != nil {
		t.Fatalf("CallEcho after the bounded calls: %v", err)
	}
}

func TestOversizedPayloadFailsWithoutDroppingTheConnection(t *testing.T) {
	auth := newAuthLog()
	srv := startServer(t, "127.0.0.1:0", auth)
	conn, _ := dial(t, srv, dialOptions("/runtime"))
	ctx := callCtx(t)

	var mu sync.Mutex
	var reasons []string
	conn.OnDisconnect(func(reason string) {
		mu.Lock()
		defer mu.Unlock()
		reasons = append(reasons, reason)
	})

	oversized := strings.Repeat("a", payloadLimit+1)
	_, err := conn.CallMeasure(ctx, oversized)
	requireCode(t, err, wire.CodeInvalidArgument, "CallMeasure with a 1,000,001-byte argument")
	err = conn.CallNote(ctx, oversized)
	requireCode(t, err, wire.CodeInvalidArgument, "CallNote with a 1,000,001-byte argument")

	if !conn.Connected() {
		t.Fatal("the connection dropped after an oversized call")
	}
	if echoed, err := conn.CallEcho(ctx, "after"); err != nil || echoed != "after" {
		t.Fatalf("CallEcho after the oversized call = %q, %v", echoed, err)
	}

	const fits = 999_000
	size, err := conn.CallMeasure(ctx, strings.Repeat("a", fits))
	if err != nil {
		t.Fatalf("CallMeasure with a %d-byte argument: %v", fits, err)
	}
	if size != fits {
		t.Fatalf("server measured %v bytes, want %d", size, fits)
	}

	// Nothing oversized reached the server, and no reconnect hid a dropped
	// connection: still the one handshake, no disconnect observed.
	notes, err := conn.CallReadNotes(ctx)
	if err != nil || len(notes) != 0 {
		t.Fatalf("CallReadNotes = %v, %v; want no notes", notes, err)
	}
	if !conn.Connected() {
		t.Fatal("the connection dropped after the 999,000-byte call")
	}
	if got := auth.count("/runtime"); got != 1 {
		t.Fatalf("accepted handshakes = %d, want 1", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(reasons) != 0 {
		t.Fatalf("OnDisconnect fired: %v", reasons)
	}
}

// TestDialRace dials, calls and disposes many times from many goroutines, the
// way a fleet of workers restarting at once would. Every Dial must connect and
// every call must answer inside a 5s ctx; one stall fails the test.
func TestDialRace(t *testing.T) {
	dialRace(t, dialOptions("/worker"))
}

// TestDialRaceWithDefaultManager runs the same race with DialOptions.Manager
// left nil, the configuration the README and the worker example ship: the
// socket's default transports, polling first and upgraded to WebSocket.
func TestDialRaceWithDefaultManager(t *testing.T) {
	dialRace(t, &wireclient.DialOptions{
		Namespace: "/worker",
		Auth:      map[string]any{"token": goodToken},
	})
}

func dialRace(t *testing.T, options *wireclient.DialOptions) {
	t.Helper()
	iterations := 2000
	if testing.Short() {
		iterations = 200
	}
	srv := startServer(t, "127.0.0.1:0", newAuthLog())
	url := srv.url()

	const workers = 16
	stalls := make(chan string, iterations)
	var wg sync.WaitGroup
	for w := range workers {
		wg.Go(func() {
			for i := w; i < iterations; i += workers {
				if failure := dialOnce(url, options, i); failure != "" {
					stalls <- fmt.Sprintf("iteration %d of %d: %s", i, iterations, failure)
				}
			}
		})
	}
	wg.Wait()
	close(stalls)

	failed := 0
	for failure := range stalls {
		failed++
		if failed <= 5 {
			t.Error(failure)
		}
	}
	if failed > 0 {
		t.Fatalf("%d of %d dial-call-dispose cycles failed", failed, iterations)
	}
}

// dialOnce runs one cycle and reports why it failed, or "" when it did not.
func dialOnce(url string, options *wireclient.DialOptions, i int) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := wireclient.Dial(ctx, url, newClientHandler(), options)
	if err != nil {
		return "Dial: " + err.Error()
	}
	want := fmt.Sprintf("ping-%d", i)
	got, err := conn.CallEcho(ctx, want)
	conn.Dispose()
	if err != nil {
		return "CallEcho: " + err.Error()
	}
	if got != want {
		return fmt.Sprintf("CallEcho = %q, want %q", got, want)
	}
	select {
	case <-conn.Done():
	case <-time.After(5 * time.Second):
		return "Done not closed after Dispose"
	}
	if _, err := conn.CallEcho(context.Background(), "after"); rpcError(err) == nil || rpcError(err).Code != wire.CodeDisposed {
		return fmt.Sprintf("CallEcho after Dispose = %v, want DISPOSED", err)
	}
	return ""
}

func TestDisposeSettlesInFlightCalls(t *testing.T) {
	srv := startServer(t, "127.0.0.1:0", newAuthLog())
	options := dialOptions("/runtime")
	options.Timeout = 30 * time.Second
	conn, _ := dial(t, srv, options)

	settled := make(chan error, 1)
	go func() {
		_, err := conn.CallHold(context.Background(), "h1")
		settled <- err
	}()
	receive(t, srv.held, 5*time.Second, "server started hold")

	conn.Dispose()
	err := receive(t, settled, time.Second, "in-flight CallHold after Dispose")
	requireCode(t, err, wire.CodeDisposed, "in-flight CallHold after Dispose")
	receive(t, conn.Done(), time.Second, "Done after Dispose")
	conn.Dispose() // idempotent
}

func TestClientHandlersKeepPerMethodOrder(t *testing.T) {
	srv := startServer(t, "127.0.0.1:0", newAuthLog())
	_, handler := dial(t, srv, dialOptions("/runtime"))
	bound := srv.session(t, "/runtime")
	ctx := callCtx(t)

	const count = 200
	want := make([]float64, count)
	for i := range count {
		want[i] = float64(i)
		if err := bound.client.CallRecord(ctx, float64(i)); err != nil {
			t.Fatalf("server CallRecord(%d): %v", i, err)
		}
	}
	eventually(t, 5*time.Second, "every record handled", func() bool {
		return len(handler.recorded()) >= count
	})
	if got := handler.recorded(); !reflect.DeepEqual(got, want) {
		t.Fatalf("records arrived out of order:\n got %v\nwant %v", got, want)
	}
}

func TestSlowClientHandlerBlocksOnlyItsOwnMethod(t *testing.T) {
	srv := startServer(t, "127.0.0.1:0", newAuthLog())
	conn, handler := dial(t, srv, dialOptions("/runtime"))
	bound := srv.session(t, "/runtime")
	ctx := callCtx(t)

	stalled := make(chan string, 1)
	go func() {
		answer, err := bound.client.CallStall(ctx, "s1")
		if err != nil {
			answer = "error: " + err.Error()
		}
		stalled <- answer
	}()
	receive(t, handler.stallEntered, 5*time.Second, "client entered stall")

	// While `stall` holds its queue, the other methods and the other direction
	// keep answering.
	quick, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if result, err := bound.client.CallRunJob(quick, wire.Job{ID: "j3", Input: "meanwhile"}); err != nil || result.Output != "done:meanwhile" {
		t.Fatalf("server CallRunJob during a stall = %+v, %v", result, err)
	}
	if answer, err := bound.client.CallAsk(quick, "meanwhile"); err != nil || answer != "answer:meanwhile" {
		t.Fatalf("server CallAsk during a stall = %q, %v", answer, err)
	}
	if echoed, err := conn.CallEcho(quick, "meanwhile"); err != nil || echoed != "meanwhile" {
		t.Fatalf("CallEcho during a stall = %q, %v", echoed, err)
	}

	close(handler.stallRelease)
	if answer := receive(t, stalled, 5*time.Second, "stall answer after release"); answer != "released:s1" {
		t.Fatalf("server CallStall = %q, want \"released:s1\"", answer)
	}
}

func TestFailingClientHandlerNeverStopsLaterCalls(t *testing.T) {
	srv := startServer(t, "127.0.0.1:0", newAuthLog())
	_, handler := dial(t, srv, dialOptions("/runtime"))
	bound := srv.session(t, "/runtime")
	ctx := callCtx(t)

	_, err := bound.client.CallAsk(ctx, "panic")
	requireCode(t, err, wire.CodeInternalError, "server CallAsk into a panicking handler")

	_, err = bound.client.CallAsk(ctx, "refuse")
	requireCode(t, err, wire.RpcErrorCode("CLIENT_REFUSED"), "server CallAsk into a refusing handler")

	if answer, err := bound.client.CallAsk(ctx, "next"); err != nil || answer != "answer:next" {
		t.Fatalf("server CallAsk after the failures = %q, %v", answer, err)
	}

	// A fire-and-forget handler that panics has no ack to fail through; the
	// client reports it out of band, and the next call on that method runs.
	if err := bound.client.CallRecord(ctx, -1); err != nil {
		t.Fatalf("server CallRecord(-1): %v", err)
	}
	reported := receive(t, bound.rpcErrors, 5*time.Second, "server OnRpcError for the panicking record")
	if reported.Code != wire.CodeInternalError || reported.Method != "record" {
		t.Fatalf("reported failure = %s on %q, want INTERNAL_ERROR on \"record\"", reported.Code, reported.Method)
	}
	if err := bound.client.CallRecord(ctx, 1); err != nil {
		t.Fatalf("server CallRecord(1): %v", err)
	}
	eventually(t, 5*time.Second, "record after the panic handled", func() bool {
		return reflect.DeepEqual(handler.recorded(), []float64{1})
	})
}

func TestConcurrentCallsShareOneConn(t *testing.T) {
	srv := startServer(t, "127.0.0.1:0", newAuthLog())
	conn, _ := dial(t, srv, dialOptions("/runtime"))
	bound := srv.session(t, "/runtime")
	ctx := callCtx(t)

	const goroutines = 64
	const callsEach = 8
	failures := make(chan string, goroutines*callsEach*2)
	var wg sync.WaitGroup
	for g := range goroutines {
		wg.Go(func() {
			for i := range callsEach {
				want := fmt.Sprintf("c%d-%d", g, i)
				if got, err := conn.CallEcho(ctx, want); err != nil || got != want {
					failures <- fmt.Sprintf("CallEcho(%q) = %q, %v", want, got, err)
				}
				job := wire.Job{ID: want, Input: want}
				if got, err := bound.client.CallRunJob(ctx, job); err != nil || got.Output != "done:"+want {
					failures <- fmt.Sprintf("server CallRunJob(%q) = %+v, %v", want, got, err)
				}
			}
		})
	}
	wg.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
}
