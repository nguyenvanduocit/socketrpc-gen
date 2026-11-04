package engine

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/parsers/engine/packet"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/types"
)

// TestPollingPauseSeesEveryPollAndWrite pauses an open polling transport
// while polls and writes complete beside it, and requires every pause to
// complete.
//
// Pause waits for the poll in flight and the write in flight to finish. It
// used to check whether each was in flight and only then attach the listener
// for its completion, so a poll answered or a write finished in between was
// never seen: the pause never completed, the upgrade to websocket stalled with
// it, and every packet written after that stayed in the socket's buffer. The
// server below answers every poll at once, so a poll completes on almost
// every instant Pause can run at.
func TestPollingPauseSeesEveryPollAndWrite(t *testing.T) {
	iterations := 300
	if testing.Short() {
		iterations = 50
	}

	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		switch {
		case r.Method == http.MethodPost:
			_, _ = io.WriteString(w, "ok")
		case r.URL.Query().Get("sid") == "":
			_, _ = io.WriteString(w, `0{"sid":"s","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}`)
		default:
			_, _ = io.WriteString(w, "6") // noop
		}
	}))
	t.Cleanup(httpServer.Close)

	for i := range iterations {
		if err := pauseWhilePolling(httpServer.URL); err != nil {
			t.Fatalf("iteration %d of %d: %v", i, iterations, err)
		}
	}
}

// pauseWhilePolling opens a polling-only socket, writes a packet, pauses the
// transport, and reports whether the pause completed.
func pauseWhilePolling(url string) error {
	opts := DefaultSocketOptions()
	opts.SetTransports(types.NewSet[TransportCtor](&PollingBuilder{}))
	opts.SetUpgrade(false)

	opened := make(chan struct{})
	socket := MakeSocket()
	_ = socket.Once("open", func(...any) { close(opened) })
	socket.Construct(url, opts)
	defer socket.Close()

	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		return fmt.Errorf("never opened")
	}

	transport := socket.Transport()
	transport.Send([]*packet.Packet{{Type: packet.MESSAGE, Data: types.NewStringBufferString("x")}})

	paused := make(chan struct{})
	transport.Pause(func() { close(paused) })
	select {
	case <-paused:
		return nil
	case <-time.After(2 * time.Second):
		return fmt.Errorf("pause never completed (polling=%v, writable=%v)", transport.(*polling)._polling.Load(), transport.Writable())
	}
}
