package transports

import (
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/engine"
)

type (
	TransportCtor = engine.TransportCtor

	WebSocketBuilder    = engine.WebSocketBuilder
	WebTransportBuilder = engine.WebTransportBuilder
	PollingBuilder      = engine.PollingBuilder
)

var (
	Polling      TransportCtor = &PollingBuilder{}
	WebSocket    TransportCtor = &WebSocketBuilder{}
	WebTransport TransportCtor = &WebTransportBuilder{}
)
