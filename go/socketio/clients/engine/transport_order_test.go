package engine

import (
	"slices"
	"testing"

	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/types"
)

// TestTransportsAreTriedInAFixedOrder builds sockets from the default
// transports and from a set written in another order, and requires the order
// they are tried in to be polling, websocket, webtransport every time.
//
// Transports arrive as a set, and the try-order used to be read from the set's
// map, so it changed from one socket to the next; a socket that tried
// WebTransport first against a server without HTTP/3 stalled until QUIC gave
// up.
func TestTransportsAreTriedInAFixedOrder(t *testing.T) {
	cases := []struct {
		name       string
		transports *types.Set[TransportCtor]
		want       []string
	}{
		{"default", nil, []string{"polling", "websocket", "webtransport"}},
		{"explicit", types.NewSet[TransportCtor](&WebTransportBuilder{}, &WebSocketBuilder{}, &PollingBuilder{}), []string{"polling", "websocket", "webtransport"}},
		{"without polling", types.NewSet[TransportCtor](&WebTransportBuilder{}, &WebSocketBuilder{}), []string{"websocket", "webtransport"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// A map ranges in a fresh random order each time, so one build
			// passing proves nothing; a hundred in a row do.
			for range 100 {
				opts := DefaultSocketOptions()
				if tc.transports != nil {
					opts.SetTransports(tc.transports)
				}
				// Port 1 refuses at once, so no transport ever opens.
				socket := NewSocket("http://127.0.0.1:1", opts)
				got := socket.Transports().All()
				socket.Close()
				if !slices.Equal(got, tc.want) {
					t.Fatalf("try-order = %v, want %v", got, tc.want)
				}
			}
		})
	}
}
