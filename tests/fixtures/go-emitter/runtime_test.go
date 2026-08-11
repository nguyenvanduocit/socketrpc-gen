package rpc

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	socket "github.com/zishang520/socket.io/servers/socket/v3"
)

type testHandler struct {
	deleted chan string
}

func (h *testHandler) GetUser(_ context.Context, userID string, includeDeleted bool) (User, error) {
	if userID == "panic" {
		panic("handler panic")
	}
	if userID == "error" {
		return User{}, NewRpcError(CodeInvalidArgument, "bad user", "", nil)
	}
	return User{ID: userID, DisplayName: "Ada", Status: StatusActive}, nil
}

func (h *testHandler) DeleteUser(_ context.Context, userID string) error {
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

	confirmed, err := client.Confirm(context.Background(), "continue?")
	if err != nil || !confirmed {
		t.Fatalf("Confirm() = %v, %v", confirmed, err)
	}
	_, err = client.Confirm(context.Background(), "error")
	var rpcErr *RpcError
	if !errors.As(err, &rpcErr) || rpcErr.Code != CodeInvalidArgument || !rpcErr.RPCError {
		t.Fatalf("expected branded peer error, got %#v", err)
	}
	if err := client.Notify(context.Background(), "hello"); err != nil {
		t.Fatal(err)
	}

	raw.Disconnect("transport close")
	_, err = client.Confirm(context.Background(), "after disconnect")
	if !errors.As(err, &rpcErr) || rpcErr.Code != CodeDisconnected {
		t.Fatalf("expected disconnect error, got %#v", err)
	}

	client.Dispose()
	_, err = client.Confirm(context.Background(), "after dispose")
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

	_, err = client.Confirm(context.Background(), "never answered")
	var rpcErr *RpcError
	if !errors.As(err, &rpcErr) || rpcErr.Code != CodeTimeout {
		t.Fatalf("expected timeout error, got %#v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = client.Confirm(ctx, "cancelled")
	if !errors.As(err, &rpcErr) || rpcErr.Code != CodeAborted {
		t.Fatalf("expected aborted error, got %#v", err)
	}
}

func TestEnumRejectsUnknownWireValue(t *testing.T) {
	var status Status
	if err := decodeValue("not-a-status", &status); err == nil {
		t.Fatal("expected unknown enum value to fail decoding")
	}
}
