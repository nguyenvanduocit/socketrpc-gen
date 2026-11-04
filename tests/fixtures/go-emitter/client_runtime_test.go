package rpc

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	socket "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/socket"
)

// The generated client is driven here through the stub clients/socket, whose
// Trigger* hooks stand in for the server and the network. Every assertion is on
// what a caller of the generated API observes.

type clientHandler struct {
	notified chan float64
	started  chan string
	stopped  chan error
	release  chan struct{}
}

func newClientHandler() *clientHandler {
	return &clientHandler{
		notified: make(chan float64, 128),
		started:  make(chan string, 8),
		stopped:  make(chan error, 8),
		release:  make(chan struct{}),
	}
}

func (h *clientHandler) HandleConfirm(ctx context.Context, question string) (string, error) {
	switch question {
	case "stall":
		// Respects its context, and answers nothing until it ends.
		h.started <- question
		<-ctx.Done()
		h.stopped <- ctx.Err()
		return "", ctx.Err()
	case "panic":
		panic("handler panic")
	case "error":
		return "", NewRpcError(CodeInvalidArgument, "bad question", "", nil)
	case "slow":
		h.started <- question
		<-h.release
		return "slow done", nil
	case "big":
		return strings.Repeat("x", 400), nil
	}
	return "yes: " + question, nil
}

func (h *clientHandler) HandleNotify(_ context.Context, seq float64) error {
	if seq < 0 {
		panic("negative sequence")
	}
	h.notified <- seq
	return nil
}

var stubServers atomic.Int64

// serve registers a stub server for a fresh address and returns it.
func serve(onConnect func(*socket.Socket)) string {
	uri := fmt.Sprintf("http://stub-%d.test", stubServers.Add(1))
	socket.Serve(uri, onConnect)
	return uri
}

func dial(t *testing.T, options *DialOptions) (*Conn, *socket.Socket, *clientHandler) {
	t.Helper()
	uri := serve(func(s *socket.Socket) { s.TriggerConnect() })
	handler := newClientHandler()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := Dial(ctx, uri, handler, options)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	t.Cleanup(conn.Dispose)
	return conn, conn.Socket(), handler
}

func requireCode(t *testing.T, err error, code RpcErrorCode) *RpcError {
	t.Helper()
	var rpcErr *RpcError
	if !errors.As(err, &rpcErr) || rpcErr.Code != code {
		t.Fatalf("expected %s, got %#v", code, err)
	}
	return rpcErr
}

// ask delivers one acknowledged server-to-client call and returns the channel
// its acknowledgement reaches the server on.
func ask(raw *socket.Socket, question string) <-chan []any {
	return raw.TriggerWithAck("confirm", question)
}

func awaitAnswer(t *testing.T, answers <-chan []any) any {
	t.Helper()
	select {
	case values := <-answers:
		if len(values) != 1 {
			t.Fatalf("expected one acknowledgement value, got %d", len(values))
		}
		return values[0]
	case <-time.After(2 * time.Second):
		t.Fatal("no acknowledgement")
		return nil
	}
}

func echoLookups(raw *socket.Socket) {
	raw.SetAckHandler(func(event string, args []any) ([]any, error) {
		id, _ := args[0].(string)
		return []any{map[string]any{"id": id, "tags": []any{"a"}}}, nil
	})
}

func TestDialJoinsTheNamespaceWithACopyOfAuth(t *testing.T) {
	auth := map[string]any{"token": "secret"}
	manager := socket.DefaultManagerOptions()
	manager.SetAutoConnect(true)
	conn, raw, handler := dial(t, &DialOptions{Namespace: "/runtime", Auth: auth, Manager: manager})
	auth["token"] = "changed"

	if !conn.Connected() || conn.Err() != nil {
		t.Fatalf("Connected() = %v, Err() = %v", conn.Connected(), conn.Err())
	}
	if raw.Namespace() != "/runtime" {
		t.Fatalf("namespace %q", raw.Namespace())
	}
	if raw.Auth()["token"] != "secret" {
		t.Fatalf("auth %v: Dial must copy the map it was given", raw.Auth())
	}
	if raw.Io().AutoConnect() {
		t.Fatal("Dial left AutoConnect on, so the socket could open before its listeners exist")
	}

	echoLookups(raw)
	item, err := conn.CallLookup(context.Background(), "i1")
	if err != nil || item.ID != "i1" || len(item.Tags) != 1 {
		t.Fatalf("CallLookup() = %#v, %v", item, err)
	}
	if err := conn.CallReport(context.Background(), "hello"); err != nil {
		t.Fatal(err)
	}
	if answer := awaitAnswer(t, ask(raw, "q")); answer != "yes: q" {
		t.Fatalf("confirm answered %#v", answer)
	}
	raw.Trigger("notify", float64(7))
	if seq := <-handler.notified; seq != 7 {
		t.Fatalf("notify delivered %v", seq)
	}
}

func TestDialRefusesInvalidArguments(t *testing.T) {
	uri := serve(func(s *socket.Socket) { s.TriggerConnect() })
	cases := map[string]func() (*Conn, error){
		"negative timeout": func() (*Conn, error) {
			return Dial(context.Background(), uri, newClientHandler(), &DialOptions{Timeout: -time.Second})
		},
		"namespace without slash": func() (*Conn, error) {
			return Dial(context.Background(), uri, newClientHandler(), &DialOptions{Namespace: "runtime"})
		},
		"namespace in the address": func() (*Conn, error) {
			return Dial(context.Background(), uri+"/runtime", newClientHandler(), nil)
		},
		"unsupported scheme": func() (*Conn, error) {
			return Dial(context.Background(), "ftp://stub.test", newClientHandler(), nil)
		},
		"nil handler": func() (*Conn, error) {
			return Dial(context.Background(), uri, nil, nil)
		},
	}
	for name, attempt := range cases {
		conn, err := attempt()
		if conn != nil {
			conn.Dispose()
			t.Fatalf("%s: Dial returned a Conn", name)
		}
		if failure := requireCode(t, err, CodeInvalidArgument); failure.Method != "Dial" {
			t.Fatalf("%s: method %q", name, failure.Method)
		}
	}
}

func TestDialReturnsARefusedHandshakeAtOnce(t *testing.T) {
	uri := serve(func(s *socket.Socket) { s.TriggerConnectError("unauthorized: token rejected", false) })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	started := time.Now()
	conn, err := Dial(ctx, uri, newClientHandler(), nil)
	if conn != nil {
		t.Fatal("Dial returned a Conn for a refused handshake")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("Dial took %s to report the refusal", elapsed)
	}
	failure := requireCode(t, err, CodeDisconnected)
	if failure.Message != "unauthorized: token rejected" || failure.Method != "Dial" {
		t.Fatalf("refusal = %#v", failure)
	}
}

func TestDialHonoursItsContext(t *testing.T) {
	// A transport error leaves the socket retrying, so only the ctx ends Dial.
	uri := serve(func(s *socket.Socket) { s.TriggerConnectError("dial tcp: connection refused", true) })

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := Dial(ctx, uri, newClientHandler(), nil)
	failure := requireCode(t, err, CodeTimeout)
	if !strings.Contains(failure.Message, "dial tcp: connection refused") {
		t.Fatalf("timeout %q does not name the last connect error", failure.Message)
	}

	cancelled, cancelNow := context.WithCancel(context.Background())
	cancelNow()
	_, err = Dial(cancelled, uri, newClientHandler(), nil)
	requireCode(t, err, CodeAborted)
}

func TestCallsHonourContextAndTheGeneratedTimeout(t *testing.T) {
	conn, _, _ := dial(t, nil)

	// No acknowledgement ever arrives: the generated default bounds the call.
	started := time.Now()
	_, err := conn.CallLookup(context.Background(), "never")
	requireCode(t, err, CodeTimeout)
	if elapsed := time.Since(started); elapsed < 200*time.Millisecond || elapsed > 2*time.Second {
		t.Fatalf("default timeout took %s, want about 250ms", elapsed)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err = conn.CallLookup(ctx, "never")
	requireCode(t, err, CodeTimeout)

	_, err = conn.CallLookup(nil, "nil ctx")
	requireCode(t, err, CodeInvalidArgument)
}

func TestInboundCallsKeepOrderAndIsolation(t *testing.T) {
	_, raw, handler := dial(t, nil)

	for seq := 1; seq <= 50; seq++ {
		raw.Trigger("notify", float64(seq))
	}
	for want := 1; want <= 50; want++ {
		if got := <-handler.notified; got != float64(want) {
			t.Fatalf("notify %v arrived in position %d", got, want)
		}
	}

	// A slow confirm stalls only its own method.
	slow := ask(raw, "slow")
	<-handler.started
	raw.Trigger("notify", float64(99))
	select {
	case seq := <-handler.notified:
		if seq != 99 {
			t.Fatalf("notify delivered %v", seq)
		}
	case <-time.After(time.Second):
		t.Fatal("a slow confirm blocked notify")
	}
	close(handler.release)
	if answer := awaitAnswer(t, slow); answer != "slow done" {
		t.Fatalf("slow confirm answered %#v", answer)
	}

	// A panic answers INTERNAL_ERROR, and the next call on that method runs.
	if failure, ok := awaitAnswer(t, ask(raw, "panic")).(*RpcError); !ok || failure.Code != CodeInternalError {
		t.Fatal("a panicking handler did not answer INTERNAL_ERROR")
	}
	if failure, ok := awaitAnswer(t, ask(raw, "error")).(*RpcError); !ok || failure.Code != CodeInvalidArgument {
		t.Fatal("a handler error did not reach the server")
	}
	if answer := awaitAnswer(t, ask(raw, "after")); answer != "yes: after" {
		t.Fatalf("confirm after a panic answered %#v", answer)
	}

	// A fire-and-forget panic is reported out of band, and notify keeps running.
	raw.Trigger("notify", float64(-1))
	raw.Trigger("notify", float64(100))
	if seq := <-handler.notified; seq != 100 {
		t.Fatalf("notify after a panic delivered %v", seq)
	}
	deadline := time.Now().Add(time.Second)
	for {
		reported := false
		for _, emission := range raw.Emissions() {
			if emission.Event == RPCErrorEvent {
				failure, _ := emission.Args[0].(*RpcError)
				reported = failure != nil && failure.Code == CodeInternalError
			}
		}
		if reported {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a failed fire-and-forget handler was not reported to the server")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestLifecycleEventsFollowTransitions(t *testing.T) {
	conn, raw, _ := dial(t, nil)
	disconnects := make(chan string, 4)
	connects := make(chan struct{}, 4)
	conn.OnDisconnect(func(reason string) { disconnects <- reason })
	conn.OnConnect(func() { connects <- struct{}{} })

	// Socket.IO can report one loss twice; observers hear it once.
	raw.TriggerDisconnect("transport close", true)
	raw.TriggerDisconnect("transport close", true)
	if reason := <-disconnects; reason != "transport close" {
		t.Fatalf("OnDisconnect reason %q", reason)
	}
	if conn.Connected() {
		t.Fatal("Connected() after a disconnect")
	}

	raw.TriggerConnect()
	select {
	case <-connects:
	case <-time.After(time.Second):
		t.Fatal("OnConnect did not fire on reconnect")
	}
	if !conn.Connected() {
		t.Fatal("not Connected() after a reconnect")
	}
	select {
	case reason := <-disconnects:
		t.Fatalf("OnDisconnect fired twice for one loss (%q)", reason)
	case <-time.After(50 * time.Millisecond):
	}
	select {
	case <-conn.Done():
		t.Fatal("a recoverable loss closed Done")
	default:
	}
}

func TestCallsFailPromptlyWhenTheConnectionDrops(t *testing.T) {
	conn, raw, _ := dial(t, &DialOptions{Timeout: 30 * time.Second})
	release := make(chan struct{})
	defer close(release)
	raw.SetAckHandler(func(string, []any) ([]any, error) {
		<-release
		return []any{map[string]any{"id": "late", "tags": []any{}}}, nil
	})

	result := make(chan error, 1)
	go func() {
		_, err := conn.CallLookup(context.Background(), "in flight")
		result <- err
	}()
	for len(raw.Emissions()) == 0 {
		time.Sleep(time.Millisecond)
	}
	dropped := time.Now()
	raw.TriggerDisconnect("transport close", true)
	select {
	case err := <-result:
		requireCode(t, err, CodeDisconnected)
		if elapsed := time.Since(dropped); elapsed > 100*time.Millisecond {
			t.Fatalf("in-flight call took %s to fail", elapsed)
		}
	case <-time.After(time.Second):
		t.Fatal("in-flight call did not fail when the connection dropped")
	}

	// Offline, a call fails at once and sends nothing.
	sent := len(raw.Emissions())
	started := time.Now()
	_, err := conn.CallLookup(context.Background(), "offline")
	requireCode(t, err, CodeDisconnected)
	if err := conn.CallReport(context.Background(), "offline"); err == nil {
		t.Fatal("fire-and-forget call succeeded offline")
	}
	if time.Since(started) > 50*time.Millisecond || len(raw.Emissions()) != sent {
		t.Fatal("an offline call waited or emitted")
	}
}

func TestAnAcknowledgementNeverCrossesAReconnect(t *testing.T) {
	_, raw, handler := dial(t, nil)
	stale := ask(raw, "slow")
	<-handler.started

	raw.TriggerDisconnect("transport close", true)
	raw.TriggerConnect()
	close(handler.release)
	// The fresh call queues behind the slow one, so its answer proves the slow
	// handler has returned and answered before the check below.
	if answer := awaitAnswer(t, ask(raw, "fresh")); answer != "yes: fresh" {
		t.Fatalf("confirm on the new connection answered %#v", answer)
	}
	select {
	case values := <-stale:
		t.Fatalf("an answer from before the reconnect was sent on the new connection: %v", values)
	default:
	}
}

func TestALostConnectionStopsItsHandlersAndFreesTheirMethod(t *testing.T) {
	conn, raw, handler := dial(t, nil)
	stale := ask(raw, "stall")
	<-handler.started

	// The stalled handler holds confirm's queue until its context ends. The
	// connection it was serving ending must end it, or every server call to
	// confirm on the next connection waits behind dead work.
	raw.TriggerDisconnect("transport close", true)
	awaitStopped(t, handler, "the connection's loss")
	raw.TriggerConnect()
	if answer := awaitAnswer(t, ask(raw, "fresh")); answer != "yes: fresh" {
		t.Fatalf("confirm on the new connection answered %#v", answer)
	}
	select {
	case values := <-stale:
		t.Fatalf("the stopped handler's answer reached the new connection: %v", values)
	default:
	}
	select {
	case <-conn.Context().Done():
		t.Fatal("a recoverable loss cancelled the Conn's own context")
	default:
	}

	// Dispose ends the handlers of the live connection the same way.
	ask(raw, "stall")
	<-handler.started
	conn.Dispose()
	awaitStopped(t, handler, "Dispose")
}

func awaitStopped(t *testing.T, handler *clientHandler, cause string) {
	t.Helper()
	select {
	case err := <-handler.stopped:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("%s ended the handler's context with %v", cause, err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("%s did not cancel the context of the handler it interrupted", cause)
	}
}

func TestACallMadeAsTheConnectionDropsIsNeverSentLater(t *testing.T) {
	conn, raw, _ := dial(t, &DialOptions{Timeout: 30 * time.Second})
	echoLookups(raw)

	// The socket stops being connected before it reports the loss. A call made
	// in between still finds the Conn live, so only the socket can refuse it.
	report := raw.BeginDisconnect(true)
	result := make(chan error, 1)
	go func() {
		_, err := conn.CallLookup(context.Background(), "window")
		result <- err
	}()
	select {
	case err := <-result:
		requireCode(t, err, CodeDisconnected)
	case <-time.After(time.Second):
		report("transport close")
		<-result
		t.Fatal("a call made while the socket was not connected waited for the loss to be reported")
	}
	if err := conn.CallReport(context.Background(), "window"); err != nil {
		requireCode(t, err, CodeDisconnected)
	}
	report("transport close")
	raw.TriggerConnect()

	for _, emission := range raw.Emissions() {
		for _, arg := range emission.Args {
			if arg == "window" {
				t.Fatalf("%s from before the loss was sent on the next connection", emission.Event)
			}
		}
	}
	if item, err := conn.CallLookup(context.Background(), "fresh"); err != nil || item.ID != "fresh" {
		t.Fatalf("CallLookup on the new connection = %#v, %v", item, err)
	}
}

func TestOversizedPayloadsFailWithoutBeingSent(t *testing.T) {
	conn, raw, _ := dial(t, nil)
	echoLookups(raw)

	// Before a handshake reports a limit, the server's default applies.
	if err := conn.CallReport(context.Background(), strings.Repeat("x", 999_000)); err != nil {
		t.Fatalf("a payload under the default limit failed: %v", err)
	}
	sent := len(raw.Emissions())
	err := conn.CallReport(context.Background(), strings.Repeat("x", 1_000_001))
	if failure := requireCode(t, err, CodeInvalidArgument); failure.Method != "report" {
		t.Fatalf("oversized call names %q", failure.Method)
	}
	if len(raw.Emissions()) != sent {
		t.Fatal("an oversized call was sent")
	}

	// The advertised limit replaces the default.
	raw.SetEngineMaxPayload(300)
	_, err = conn.CallLookup(context.Background(), strings.Repeat("x", 300))
	requireCode(t, err, CodeInvalidArgument)
	if len(raw.Emissions()) != sent {
		t.Fatal("an oversized acknowledged call was sent")
	}
	if _, err := conn.CallLookup(context.Background(), "small"); err != nil {
		t.Fatalf("a call under the limit failed: %v", err)
	}

	// A reply too large for the server answers INTERNAL_ERROR instead.
	failure, ok := awaitAnswer(t, ask(raw, "big")).(*RpcError)
	if !ok || failure.Code != CodeInternalError {
		t.Fatalf("an oversized reply answered %#v", failure)
	}
}

func TestAnObserverMayCall(t *testing.T) {
	conn, raw, _ := dial(t, nil)
	echoLookups(raw)
	announced := make(chan error, 1)
	conn.OnConnect(func() {
		_, err := conn.CallLookup(context.Background(), "announce")
		announced <- err
	})
	raw.TriggerDisconnect("transport close", true)
	raw.TriggerConnect()
	select {
	case err := <-announced:
		if err != nil {
			t.Fatalf("call from OnConnect: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a call made from OnConnect deadlocked")
	}
}

func TestDisposeEndsEverything(t *testing.T) {
	conn, raw, _ := dial(t, &DialOptions{Timeout: 30 * time.Second})
	release := make(chan struct{})
	defer close(release)
	raw.SetAckHandler(func(string, []any) ([]any, error) {
		<-release
		return nil, nil
	})

	result := make(chan error, 1)
	go func() {
		_, err := conn.CallLookup(context.Background(), "in flight")
		result <- err
	}()
	for len(raw.Emissions()) == 0 {
		time.Sleep(time.Millisecond)
	}

	disposed := make(chan struct{})
	go func() {
		conn.Dispose()
		conn.Dispose()
		close(disposed)
	}()
	select {
	case <-disposed:
	case <-time.After(time.Second):
		t.Fatal("Dispose deadlocked")
	}
	requireCode(t, <-result, CodeDisposed)
	select {
	case <-conn.Done():
	default:
		t.Fatal("Dispose did not close Done")
	}
	requireCode(t, conn.Err(), CodeDisposed)
	select {
	case <-conn.Context().Done():
	default:
		t.Fatal("Dispose did not cancel the handler context")
	}
	if conn.Connected() {
		t.Fatal("Connected() after Dispose")
	}
	_, err := conn.CallLookup(context.Background(), "after")
	requireCode(t, err, CodeDisposed)

	for _, event := range []string{"connect", "disconnect", "connect_error", "confirm", "notify", RPCErrorEvent} {
		if count := raw.ListenerCount(event); count != 0 {
			t.Fatalf("Dispose left %d %q listeners", count, event)
		}
	}
	if count := raw.Io().ListenerCount("reconnect_failed"); count != 0 {
		t.Fatalf("Dispose left %d reconnect_failed listeners", count)
	}
	if _, disconnects := raw.Counts(); disconnects == 0 {
		t.Fatal("Dispose did not disconnect the socket it owns")
	}
}

func TestLossesTheSocketCannotRecoverEndTheConn(t *testing.T) {
	losses := map[string]func(*socket.Socket){
		"server disconnect": func(raw *socket.Socket) { raw.TriggerDisconnect("io server disconnect", false) },
		"reconnection exhausted": func(raw *socket.Socket) {
			raw.TriggerDisconnect("transport close", true)
			raw.Io().TriggerReconnectFailed()
		},
		"refused reconnect": func(raw *socket.Socket) {
			raw.TriggerDisconnect("transport close", true)
			raw.TriggerConnectError("token expired", false)
		},
	}
	for name, lose := range losses {
		conn, raw, _ := dial(t, nil)
		lose(raw)
		select {
		case <-conn.Done():
		case <-time.After(time.Second):
			t.Fatalf("%s: Done did not close", name)
		}
		requireCode(t, conn.Err(), CodeDisconnected)
		_, err := conn.CallLookup(context.Background(), "after")
		requireCode(t, err, CodeDisconnected)
		if conn.Connected() {
			t.Fatalf("%s: Connected() after a terminal loss", name)
		}
	}
}

func TestConcurrentCalls(t *testing.T) {
	conn, raw, _ := dial(t, nil)
	echoLookups(raw)
	var wg sync.WaitGroup
	failures := make(chan error, 64)
	for worker := 0; worker < 64; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			id := fmt.Sprintf("w%d", worker)
			item, err := conn.CallLookup(context.Background(), id)
			if err == nil && item.ID != id {
				err = fmt.Errorf("worker %s got %q", id, item.ID)
			}
			if err != nil {
				failures <- err
			}
		}(worker)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
}
