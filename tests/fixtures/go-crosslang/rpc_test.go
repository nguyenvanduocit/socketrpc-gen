package rpc

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// These run against the freshly generated package with -race, so they assert
// properties of the emitter's output rather than of a checked-in snapshot.

func TestPriorityRejectsUnknownValues(t *testing.T) {
	var decoded Priority
	if err := json.Unmarshal([]byte(`"high"`), &decoded); err != nil {
		t.Fatalf("valid literal rejected: %v", err)
	}
	if decoded != PriorityHigh {
		t.Fatalf("got %q, want %q", decoded, PriorityHigh)
	}

	if err := json.Unmarshal([]byte(`"bogus"`), &decoded); err == nil {
		t.Fatal("expected an unknown enum literal to be rejected on decode")
	}
	if decoded != PriorityHigh {
		t.Fatalf("a rejected decode must leave the receiver untouched, got %q", decoded)
	}

	if _, err := json.Marshal(Priority("bogus")); err == nil {
		t.Fatal("expected an unknown enum literal to be rejected on encode")
	}
}

func TestEchoOmitsAbsentOptionalField(t *testing.T) {
	encoded, err := json.Marshal(Echo{ID: "u1", Payload: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "note") {
		t.Fatalf("an absent optional field must stay off the wire, got %s", encoded)
	}

	note := "attached"
	encoded, err = json.Marshal(Echo{ID: "u1", Payload: "hello", Note: &note})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"note":"attached"`) {
		t.Fatalf("a present optional field must be encoded, got %s", encoded)
	}
}

func TestRpcErrorCarriesBrandAndUnwraps(t *testing.T) {
	err := NewRpcError(RpcErrorCode("GO_REFUSED"), "nope", "failTyped", map[string]any{"reason": "quota"})

	encoded, marshalErr := json.Marshal(err)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	if !strings.Contains(string(encoded), `"__rpcError":true`) {
		t.Fatalf("the brand is what isRpcError checks, got %s", encoded)
	}

	if !IsRpcError(err) {
		t.Fatal("IsRpcError must recognise a branded error")
	}
	if IsRpcError(errors.New("plain")) {
		t.Fatal("IsRpcError must not claim an unbranded error")
	}

	// A success value shaped like an error carries no brand, so decoding it as
	// one must fail — the same soundness property the TypeScript side asserts.
	if _, ok := decodeRpcError(Receipt{Message: "receipt", Code: "PAID"}); ok {
		t.Fatal("an unbranded payload must not decode as an RpcError")
	}
}

// The dispatch queue is what turns Socket.IO's ordered delivery into ordered
// handling. Exercised directly here so the guarantee is pinned without a
// network round trip, and under -race so the locking is checked too.
func TestEventQueuePreservesArrivalOrder(t *testing.T) {
	const total = 200

	var mu sync.Mutex
	seen := make([]string, 0, total)
	done := make(chan struct{})

	queue := newEventQueue(func(args []any) {
		mu.Lock()
		seen = append(seen, args[0].(string))
		finished := len(seen) == total
		mu.Unlock()
		if finished {
			close(done)
		}
	})

	// Pushed from one goroutine, exactly as the Socket.IO listener does.
	for i := 0; i < total; i++ {
		queue.push([]any{strconv.Itoa(i)})
	}

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("queue did not drain")
	}

	mu.Lock()
	defer mu.Unlock()
	for i, value := range seen {
		if value != strconv.Itoa(i) {
			t.Fatalf("handled out of order at %d: got %q", i, value)
		}
	}
}

// Ordering must not cost head-of-line blocking across methods: each RPC method
// owns a queue, so one blocked handler leaves every other method running while
// still making the *same* method's next call wait its turn.
func TestEventQueuesAreIndependentPerMethod(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 2)
	blocking := newEventQueue(func([]any) {
		entered <- struct{}{}
		<-release
	})

	progressed := make(chan struct{}, 1)
	independent := newEventQueue(func([]any) { progressed <- struct{}{} })

	blocking.push(nil)
	<-entered // the first call is inside its handler, holding its own queue

	// A second call to the blocked method must wait for the first to finish.
	blocking.push(nil)
	select {
	case <-entered:
		t.Fatal("a second call to a blocked method must wait for the first")
	case <-time.After(100 * time.Millisecond):
	}

	// An unrelated method answers immediately regardless.
	independent.push(nil)
	select {
	case <-progressed:
	case <-time.After(2 * time.Second):
		t.Fatal("an unrelated method was blocked by a stalled handler")
	}

	close(release)
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("the queued second call was never handled")
	}
}
