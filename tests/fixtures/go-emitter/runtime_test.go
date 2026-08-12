package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	socket "github.com/zishang520/socket.io/servers/socket/v3"
)

type testHandler struct {
	deleted chan string
}

func (h *testHandler) HandleGetUser(_ context.Context, userID string, includeDeleted bool) (User, error) {
	if userID == "panic" {
		panic("handler panic")
	}
	if userID == "error" {
		return User{}, NewRpcError(CodeInvalidArgument, "bad user", "", nil)
	}
	return User{ID: userID, DisplayName: "Ada", Status: StatusActive}, nil
}

func (h *testHandler) HandleDeleteUser(_ context.Context, userID string) error {
	h.deleted <- userID
	return nil
}

func TestInboundAckPanicAndFireAndForget(t *testing.T) {
	raw := socket.NewSocket()
	handler := &testHandler{deleted: make(chan string, 1)}
	binding, err := BindServer(raw, handler)
	if err != nil {
		t.Fatal(err)
	}
	defer binding.Dispose()

	assertAck := func(userID string, wantCode RpcErrorCode) {
		t.Helper()
		values := make(chan []any, 2)
		var calls atomic.Int32
		raw.Trigger("getUser", userID, false, socket.Ack(func(args []any, _ error) {
			calls.Add(1)
			values <- args
		}))
		select {
		case args := <-values:
			if len(args) != 1 {
				t.Fatalf("expected one ack value, got %d", len(args))
			}
			if wantCode == "" {
				user, ok := args[0].(User)
				if !ok || user.ID != userID {
					t.Fatalf("unexpected success ack: %#v", args[0])
				}
			} else {
				rpcErr, ok := args[0].(*RpcError)
				if !ok || !rpcErr.RPCError || rpcErr.Code != wantCode {
					t.Fatalf("unexpected error ack: %#v", args[0])
				}
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for ack")
		}
		time.Sleep(10 * time.Millisecond)
		if calls.Load() != 1 {
			t.Fatalf("ack called %d times", calls.Load())
		}
	}

	assertAck("u1", "")
	assertAck("error", CodeInvalidArgument)
	assertAck("panic", CodeInternalError)

	raw.Trigger("deleteUser", "gone")
	select {
	case deleted := <-handler.deleted:
		if deleted != "gone" {
			t.Fatalf("deleted %q", deleted)
		}
	case <-time.After(time.Second):
		t.Fatal("void handler was not called")
	}
}

func TestClientAckErrorsDisconnectAndDispose(t *testing.T) {
	raw := socket.NewSocket()
	raw.SetAckHandler(func(event string, args []any) ([]any, error) {
		if event != "confirm" || len(args) != 1 {
			return nil, errors.New("unexpected call")
		}
		question, _ := args[0].(string)
		if question == "error" {
			return []any{map[string]any{
				"__rpcError": true,
				"code":       "INVALID_ARGUMENT",
				"message":    "bad question",
			}}, nil
		}
		return []any{true}, nil
	})
	client, err := NewClient(raw, &ClientOptions{Timeout: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}

	confirmed, err := client.CallConfirm(context.Background(), "continue?")
	if err != nil || !confirmed {
		t.Fatalf("CallConfirm() = %v, %v", confirmed, err)
	}
	_, err = client.CallConfirm(context.Background(), "error")
	var rpcErr *RpcError
	if !errors.As(err, &rpcErr) || rpcErr.Code != CodeInvalidArgument || !rpcErr.RPCError {
		t.Fatalf("expected branded peer error, got %#v", err)
	}
	if err := client.CallNotify(context.Background(), "hello"); err != nil {
		t.Fatal(err)
	}

	raw.Disconnect("transport close")
	_, err = client.CallConfirm(context.Background(), "after disconnect")
	if !errors.As(err, &rpcErr) || rpcErr.Code != CodeDisconnected {
		t.Fatalf("expected disconnect error, got %#v", err)
	}

	client.Dispose()
	_, err = client.CallConfirm(context.Background(), "after dispose")
	if !errors.As(err, &rpcErr) || rpcErr.Code != CodeDisposed {
		t.Fatalf("expected disposed error, got %#v", err)
	}
}

func TestClientTimeoutAndContextCancellation(t *testing.T) {
	raw := socket.NewSocket()
	client, err := NewClient(raw, &ClientOptions{Timeout: 5 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Dispose()

	_, err = client.CallConfirm(context.Background(), "never answered")
	var rpcErr *RpcError
	if !errors.As(err, &rpcErr) || rpcErr.Code != CodeTimeout {
		t.Fatalf("expected timeout error, got %#v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = client.CallConfirm(ctx, "cancelled")
	if !errors.As(err, &rpcErr) || rpcErr.Code != CodeAborted {
		t.Fatalf("expected aborted error, got %#v", err)
	}
}

func TestEnumRejectsUnknownWireValue(t *testing.T) {
	var status Status
	if err := rpc_decodeValue("not-a-status", &status); err == nil {
		t.Fatal("expected unknown enum value to fail decoding")
	}
}

// A required map field is nil in a zero value, and encoding/json writes nil as
// null — which would break a client whose generated type says the key is always
// an object. The generated MarshalJSON normalizes it without touching the value
// the handler still holds.
func TestRequiredMapFieldNeverEncodesAsNull(t *testing.T) {
	user := User{ID: "u1", DisplayName: "Ada", Status: StatusActive}
	encoded, err := json.Marshal(user)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(encoded), `"attributes":{}`) {
		t.Errorf("expected an empty object for the nil map, got %s", encoded)
	}
	if user.Attributes != nil {
		t.Error("MarshalJSON mutated the caller's value")
	}
}

// A wire field named after the marshalling hook takes the struct's method
// namespace with it: Go allows a type one member of a given name, and
// `encoding/json` fixes the method's spelling. The normalization the method
// would have performed has to survive the move to the field types — including
// one level in, where the value travels as an element of a slice.
func TestFieldNamedAfterTheMarshallerKeepsNormalization(t *testing.T) {
	payload := Payload{MarshalJSON: "the field wins"}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	const want = `{"marshalJSON":"the field wins","labels":[],"counts":{}}`
	if string(encoded) != want {
		t.Fatalf("got  %s\nwant %s", encoded, want)
	}
	if payload.Labels != nil || payload.Counts != nil {
		t.Error("normalization mutated the caller's value")
	}

	nested, err := json.Marshal([]Payload{{}})
	if err != nil {
		t.Fatalf("marshal slice: %v", err)
	}
	if !strings.Contains(string(nested), `"labels":[]`) {
		t.Errorf("a nested value was not normalized: %s", nested)
	}

	// The field types stay assignable from the plain Go types a handler writes.
	payload.Labels = []string{"a"}
	payload.Counts = map[string]float64{"n": 1}
	var labels []string = payload.Labels
	if len(labels) != 1 {
		t.Fatal("the generated field type is not assignable to its underlying type")
	}

	var decoded Payload
	if err := rpc_decodeValue(map[string]any{"labels": []any{"x"}}, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(decoded.Labels) != 1 || decoded.Labels[0] != "x" {
		t.Fatalf("decoded %#v", decoded)
	}
}

// A required enum left at its zero value cannot be encoded. Socket.IO's write
// path discards that failure, so without the guard the caller would wait out its
// own timeout instead of learning what went wrong.
func TestUnencodableResultBecomesTypedError(t *testing.T) {
	failure := rpc_ensureEncodable(User{ID: "u1"}, "getUser")
	if failure == nil {
		t.Fatal("expected a zero-valued required enum to be refused")
	}
	if failure.Code != CodeInternalError || !failure.RPCError {
		t.Fatalf("unexpected failure: %#v", failure)
	}
}

// A peer whose handler for a fire-and-forget call fails has no acknowledgement
// to answer through, so it reports out of band. The binding must route that to
// an observer instead of dropping it.
func TestOnRpcErrorReceivesPeerReports(t *testing.T) {
	raw := socket.NewSocket()
	binding, err := BindServer(raw, &testHandler{deleted: make(chan string, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer binding.Dispose()

	reports := make(chan *RpcError, 1)
	binding.OnRpcError(func(failure *RpcError) { reports <- failure })

	raw.Trigger(RPCErrorEvent, map[string]any{
		"__rpcError": true,
		"code":       "INTERNAL_ERROR",
		"message":    "client handler exploded",
		"method":     "notify",
	})

	select {
	case failure := <-reports:
		if failure.Code != CodeInternalError || failure.Message != "client handler exploded" {
			t.Fatalf("unexpected report: %#v", failure)
		}
		if failure.Method != "notify" {
			t.Fatalf("method = %q", failure.Method)
		}
	case <-time.After(time.Second):
		t.Fatal("out-of-band error report never reached the observer")
	}
}

// Observers are additive and ordered, matching the TypeScript client's onRpcError.
// A second registration used to displace the first; it must not.
func TestOnRpcErrorObserversAreAdditiveAndOrdered(t *testing.T) {
	raw := socket.NewSocket()
	binding, err := BindServer(raw, &testHandler{deleted: make(chan string, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer binding.Dispose()

	order := make(chan string, 3)
	binding.OnRpcError(func(*RpcError) { order <- "first" })
	// A panicking observer must not stop the ones registered after it.
	binding.OnRpcError(func(*RpcError) { panic("observer exploded") })
	binding.OnRpcError(func(*RpcError) { order <- "third" })

	raw.Trigger(RPCErrorEvent, map[string]any{
		"__rpcError": true,
		"code":       "INTERNAL_ERROR",
		"message":    "boom",
		"method":     "notify",
	})

	for _, want := range []string{"first", "third"} {
		select {
		case got := <-order:
			if got != want {
				t.Fatalf("observer order = %q, want %q", got, want)
			}
		case <-time.After(time.Second):
			t.Fatalf("observer %q never ran", want)
		}
	}
}

// The unsubscribe an OnRpcError registration returns detaches only that observer.
func TestOnRpcErrorUnsubscribeDetachesOneObserver(t *testing.T) {
	raw := socket.NewSocket()
	binding, err := BindServer(raw, &testHandler{deleted: make(chan string, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer binding.Dispose()

	removed := make(chan struct{}, 1)
	kept := make(chan struct{}, 1)
	unsubscribe := binding.OnRpcError(func(*RpcError) { removed <- struct{}{} })
	binding.OnRpcError(func(*RpcError) { kept <- struct{}{} })
	unsubscribe()

	raw.Trigger(RPCErrorEvent, map[string]any{
		"__rpcError": true,
		"code":       "INTERNAL_ERROR",
		"message":    "boom",
		"method":     "notify",
	})

	select {
	case <-kept:
	case <-time.After(time.Second):
		t.Fatal("the surviving observer never ran")
	}
	select {
	case <-removed:
		t.Fatal("the unsubscribed observer still ran")
	default:
	}
}
